/**
 * /sap/* — SAP 운영 문의 AI 응답.
 *
 * 호출 경로
 *   Lambda → EC2 인증 프록시(:8646) → hermes proxy(127.0.0.1:8645) → Nous Portal
 *
 * 저장소는 DynamoDB 다
 *   RDS 는 2026-10-12 해지됐다(CLAUDE.md). DynamoDB 는 요청당 과금이라 이 규모에서
 *   월 100원 수준이고 안 쓰는 달은 0원이다. 대화를 서버에 두어야 여러 사람이 같은
 *   대화를 이어가고, 나중에 문의 유형을 집계할 수 있다.
 *
 *   sap_conversations  PK userKey(S) · SK convId(S)
 *   sap_messages       PK convId(S)  · SK seq(N)
 *
 * 대화 연속성
 *   hermes proxy 는 /v1/responses 를 중계하지 않는다(허용: chat/completions,
 *   completions, embeddings, models). previous_response_id 로 서버에 맡길 수 없어
 *   sap_messages 에서 최근 대화를 꺼내 매 요청에 함께 보낸다.
 *
 * SAP 조회는 아직 붙어 있지 않다. 사내망 접근이 열리면 도구로 추가하는데, 그때는
 * 도구 루프가 29초(API Gateway 한도)를 넘기므로 비동기 구조가 함께 필요하다.
 *
 * 필요한 환경변수: HERMES_URL · PROXY_TOKEN · AI_MODEL
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const HERMES_URL  = (process.env.HERMES_URL || '').replace(/\/$/, '');
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const MODEL       = process.env.AI_MODEL || 'openai/gpt-6-luna';

const T_CONV = 'sap_conversations';
const T_MSG  = 'sap_messages';

const MAX_INPUT   = 20000;   // 질문 한 건의 길이 상한(자)
const MAX_HISTORY = 24;      // 컨텍스트에 싣는 최근 메시지 수
const MAX_TOKENS  = 1500;
const TIMEOUT_MS  = 25000;   // API Gateway 29초보다 짧게

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const SYSTEM = [
  '당신은 SAP ERP 운영 문의를 돕는 어시스턴트입니다.',
  '현재 SAP 시스템에 직접 연결되어 있지 않아 실제 테이블·소스를 조회할 수 없습니다.',
  '조회가 필요한 질문이면 "어떤 테이블/프로그램을 어떤 조건으로 조회해야 하는지"를 구체적으로 알려주세요.',
  '조회 없이 답할 수 있는 질문(개념, ABAP 문법, 사용자가 붙여넣은 소스 분석, 앞선 대화 내용)은 바로 답하세요.',
  '모르는 값은 지어내지 말고, 판단 근거(테이블·필드·프로그램 위치)를 함께 적으세요.',
  '한국어로 간결하게 답하세요.',
].join(' ');

/* ── AI 호출 (OpenAI 호환 /chat/completions) ─────────── */
function callAI(messages, model) {
  const payload = JSON.stringify({
    model: model || MODEL,       // hermes proxy 는 model 을 자동 주입하지 않는다
    messages,
    max_tokens: MAX_TOKENS,
    temperature: 0.3,
  });

  const u = new URL(HERMES_URL + '/v1/chat/completions');
  const mod = u.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer local',   // hermes proxy 가 실제 자격증명을 붙인다
        'X-Proxy-Token': PROXY_TOKEN,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('AI ' + res.statusCode + ': ' + raw.slice(0, 500)));
        }
        let d;
        try { d = JSON.parse(raw); }
        catch (e) { return reject(new Error('응답이 JSON이 아닙니다: ' + raw.slice(0, 300))); }
        const ch = d.choices && d.choices[0];
        if (!ch) return reject(new Error('choices 가 비어 있습니다: ' + raw.slice(0, 300)));
        resolve({
          text: (ch.message && ch.message.content) || '(빈 응답)',
          model: d.model || model || MODEL,
          usage: d.usage || {},
          latencyMs: Date.now() - started,
        });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('AI 응답 시간 초과(25초)')); });
    req.on('error', reject);
    req.end(payload);
  });
}

/* ── 저장소 ──────────────────────────────────────────── */
function newConvId() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

async function getConversation(userKey, convId) {
  if (!convId) return null;
  const r = await ddb.send(new GetCommand({ TableName: T_CONV, Key: { userKey, convId } }));
  return r.Item || null;
}

async function createConversation(userKey, title) {
  const now = new Date().toISOString();
  const item = {
    userKey, convId: newConvId(), title: String(title || '').slice(0, 60),
    createdAt: now, lastAt: now, msgCount: 0,
  };
  await ddb.send(new PutCommand({ TableName: T_CONV, Item: item }));
  return item;
}

/** 최근 MAX_HISTORY 개를 시간순으로 돌려준다. */
async function loadHistory(convId) {
  const r = await ddb.send(new QueryCommand({
    TableName: T_MSG,
    KeyConditionExpression: 'convId = :c',
    ExpressionAttributeValues: { ':c': convId },
    ScanIndexForward: false,            // 최신부터 가져와서
    Limit: MAX_HISTORY,
  }));
  return (r.Items || []).reverse()      // 시간순으로 뒤집는다
    .map(function (m) { return { role: m.role, content: m.content }; });
}

async function appendMessages(userKey, conv, items) {
  const now = new Date().toISOString();
  let seq = Number(conv.msgCount) || 0;
  for (const m of items) {
    seq += 1;
    await ddb.send(new PutCommand({
      TableName: T_MSG,
      Item: { convId: conv.convId, seq, role: m.role, content: m.content, createdAt: now },
    }));
  }
  await ddb.send(new UpdateCommand({
    TableName: T_CONV,
    Key: { userKey, convId: conv.convId },
    UpdateExpression: 'SET msgCount = :n, lastAt = :t',
    ExpressionAttributeValues: { ':n': seq, ':t': now },
  }));
}

/* ── 라우트 ──────────────────────────────────────────── */
async function route(ctx, event, method, path) {
  const resp = ctx.resp;
  const getBody = ctx.getBody;           // pool 은 쓰지 않는다 (RDS 해지)
  if (!path.startsWith('/sap/')) return null;

  if (!HERMES_URL || !PROXY_TOKEN) {
    return resp(500, { error: 'HERMES_URL / PROXY_TOKEN 환경변수가 설정되지 않았습니다.' });
  }

  const body = getBody(event) || {};
  const qs = event.queryStringParameters || {};
  const userKey = String(body.userKey || qs.userKey || '').trim();
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(userKey)) {
    return resp(400, { error: '사용자 키가 올바르지 않습니다.' });
  }

  /* 질문 → 답변 */
  if (path === '/sap/ask' && method === 'POST') {
    const text = String(body.text || '').trim();
    if (!text) return resp(400, { error: '메시지가 비어 있습니다.' });
    if (text.length > MAX_INPUT) {
      return resp(400, { error: '메시지가 너무 깁니다(' + MAX_INPUT + '자 제한).' });
    }

    let conv = await getConversation(userKey, body.convId);
    if (!conv) conv = await createConversation(userKey, text);

    const history = await loadHistory(conv.convId);
    const messages = [{ role: 'system', content: SYSTEM }]
      .concat(history)
      .concat([{ role: 'user', content: text }]);

    try {
      const out = await callAI(messages, body.model);
      await appendMessages(userKey, conv,
        [{ role: 'user', content: text }, { role: 'assistant', content: out.text }]);
      const u = out.usage || {};
      console.log('[sap] conv=' + conv.convId + ' ' + out.model + ' ' + out.latencyMs + 'ms '
        + 'in=' + u.prompt_tokens + ' out=' + u.completion_tokens + ' cost=' + u.cost);
      return resp(200, {
        convId: conv.convId, text: out.text, model: out.model,
        latencyMs: out.latencyMs, usage: u,
        turns: history.length + 2,
        continued: history.length > 0,
      });
    } catch (e) {
      console.error('[sap] 호출 실패:', e.message);
      return resp(502, { error: e.message, convId: conv.convId });
    }
  }

  /* 내 대화 목록 */
  if (path === '/sap/conversations' && method === 'GET') {
    const r = await ddb.send(new QueryCommand({
      TableName: T_CONV,
      KeyConditionExpression: 'userKey = :u',
      ExpressionAttributeValues: { ':u': userKey },
      Limit: 30,
    }));
    const list = (r.Items || []).sort(function (a, b) {
      return String(b.lastAt).localeCompare(String(a.lastAt));
    });
    return resp(200, { conversations: list });
  }

  /* 대화 내용 — convId 만 알면 볼 수 있다(공유용) */
  if (path === '/sap/messages' && method === 'GET') {
    const convId = String(qs.convId || '');
    if (!convId) return resp(400, { error: 'convId 가 필요합니다.' });
    const r = await ddb.send(new QueryCommand({
      TableName: T_MSG,
      KeyConditionExpression: 'convId = :c',
      ExpressionAttributeValues: { ':c': convId },
      ScanIndexForward: true,
      Limit: 200,
    }));
    return resp(200, { convId, messages: r.Items || [] });
  }

  /* 프록시 상태 */
  if (path === '/sap/health' && method === 'GET') {
    try {
      const u = new URL(HERMES_URL + '/healthz');
      const mod = u.protocol === 'https:' ? https : http;
      const code = await new Promise(function (res2, rej) {
        const r = mod.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: 5000 },
          function (x) { x.resume(); res2(x.statusCode); });
        r.on('timeout', function () { r.destroy(new Error('timeout')); });
        r.on('error', rej);
      });
      return resp(200, { hermes: code === 200 ? 'ok' : 'unexpected ' + code, model: MODEL });
    } catch (e) {
      return resp(502, { hermes: 'unreachable', error: e.message });
    }
  }

  return resp(404, { error: '알 수 없는 /sap 경로' });
}

module.exports = { route };
