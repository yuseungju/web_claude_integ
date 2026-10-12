/**
 * /sap/* — SAP 운영 문의 AI 응답. sap_ 테이블만 다루는 독립 모듈.
 *
 * 호출 경로
 *   Lambda → EC2 인증 프록시(:8646) → hermes proxy(127.0.0.1:8645) → Nous Portal
 *
 * 대화 연속성
 *   hermes proxy 는 /v1/responses 를 중계하지 않는다(허용: chat/completions,
 *   completions, embeddings, models). 그래서 previous_response_id 로 서버에
 *   맡기는 방식을 쓸 수 없고, 우리가 sap_messages 에 쌓아둔 히스토리를 매 요청에
 *   실어 보낸다. 대신 대화 이력이 우리 DB 에 남아 문의 유형 분석에 바로 쓸 수 있다.
 *
 * SAP 조회는 아직 붙어 있지 않다. 사내망 접근이 열리면 도구로 추가한다.
 * 그때까지는 조회가 필요한 질문이면 그렇다고 말하고, 아니면 일반 지식으로 답한다.
 *
 * 필요한 환경변수
 *   HERMES_URL    예: http://3.26.56.6:8646
 *   PROXY_TOKEN   EC2 authproxy 와 나눠 갖는 비밀값
 *   AI_MODEL      기본 모델 (요청에서 model 을 주면 그쪽이 우선)
 */
const http = require('node:http');
const https = require('node:https');

const HERMES_URL  = (process.env.HERMES_URL || '').replace(/\/$/, '');
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const MODEL       = process.env.AI_MODEL || 'openai/gpt-6-luna';

const MAX_INPUT   = 20000;   // 질문 한 건의 길이 상한(자)
const MAX_TURNS   = 24;      // 컨텍스트에 싣는 최근 메시지 수
const MAX_TOKENS  = 1500;    // 출력 상한
const TIMEOUT_MS  = 25000;   // API Gateway 29초보다 짧게

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
    model: model || MODEL,          // hermes proxy 는 model 을 자동 주입하지 않는다
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
          return reject(new Error(`AI ${res.statusCode}: ${raw.slice(0, 500)}`));
        }
        let d;
        try { d = JSON.parse(raw); }
        catch { return reject(new Error('응답이 JSON이 아닙니다: ' + raw.slice(0, 300))); }
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
    req.on('timeout', () => req.destroy(new Error('AI 응답 시간 초과(25초)')));
    req.on('error', reject);
    req.end(payload);
  });
}

/* ── 저장소 ──────────────────────────────────────────── */
async function getConversationId(pool, userKey, convId) {
  if (convId) {
    const { rows } = await pool.query(
      'SELECT id FROM sap_conversations WHERE id = $1 AND user_key = $2', [convId, userKey]);
    if (rows.length) return Number(rows[0].id);
  }
  const { rows } = await pool.query(
    `INSERT INTO sap_conversations (user_key, source) VALUES ($1, 'web') RETURNING id`, [userKey]);
  return Number(rows[0].id);
}

/** 최근 MAX_TURNS 개를 시간순으로 돌려준다. content 는 JSONB 에 문자열로 들어있다. */
async function loadHistory(pool, convId) {
  const { rows } = await pool.query(
    `SELECT role, content FROM sap_messages
      WHERE conv_id = $1 AND dropped = false
      ORDER BY seq DESC LIMIT $2`, [convId, MAX_TURNS]);
  return rows.reverse().map((r) => ({
    role: r.role,
    content: typeof r.content === 'string' ? r.content : String(r.content),
  }));
}

async function appendMessages(pool, convId, items) {
  const { rows } = await pool.query(
    'SELECT COALESCE(MAX(seq), 0) AS s FROM sap_messages WHERE conv_id = $1', [convId]);
  let seq = Number(rows[0].s);
  for (const m of items) {
    seq += 1;
    await pool.query(
      'INSERT INTO sap_messages (conv_id, seq, role, content) VALUES ($1, $2, $3, $4)',
      [convId, seq, m.role, JSON.stringify(m.content)]);
  }
  await pool.query('UPDATE sap_conversations SET last_at = now() WHERE id = $1', [convId]);
}

async function logCall(pool, convId, out) {
  try {
    const u = out.usage || {};
    await pool.query(
      `INSERT INTO sap_ai_calls (conv_id, model, input_tokens, output_tokens, latency_ms, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [convId, out.model, u.prompt_tokens || 0, u.completion_tokens || 0,
       out.latencyMs, u.cost || 0]);
  } catch (e) { console.error('[sap] 사용량 기록 실패:', e.message); }
}

/* ── 라우트 ──────────────────────────────────────────── */
async function route(ctx, event, method, path) {
  const { pool, resp, getBody } = ctx;
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
    if (text.length > MAX_INPUT) return resp(400, { error: `메시지가 너무 깁니다(${MAX_INPUT}자 제한).` });

    const convId = await getConversationId(pool, userKey, body.convId);
    const history = await loadHistory(pool, convId);
    const userMsg = { role: 'user', content: text };
    const messages = [{ role: 'system', content: SYSTEM }, ...history, userMsg];

    try {
      const out = await callAI(messages, body.model);
      await appendMessages(pool, convId, [userMsg, { role: 'assistant', content: out.text }]);
      await logCall(pool, convId, out);
      console.log(`[sap] conv=${convId} ${out.model} ${out.latencyMs}ms `
        + `in=${out.usage.prompt_tokens} out=${out.usage.completion_tokens} cost=${out.usage.cost}`);
      return resp(200, {
        convId, text: out.text, model: out.model,
        latencyMs: out.latencyMs, usage: out.usage,
        turns: history.length + 2,
        continued: history.length > 0,
      });
    } catch (e) {
      console.error('[sap] 호출 실패:', e.message);
      return resp(502, { error: e.message, convId });
    }
  }

  /* 대화 목록 */
  if (path === '/sap/conversations' && method === 'GET') {
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.created_at, c.last_at,
              (SELECT count(*)::int FROM sap_messages m WHERE m.conv_id = c.id) AS messages
         FROM sap_conversations c
        WHERE c.user_key = $1 ORDER BY c.last_at DESC LIMIT 30`, [userKey]);
    return resp(200, { conversations: rows });
  }

  /* 대화 내용 */
  if (path === '/sap/messages' && method === 'GET') {
    const convId = Number(qs.convId);
    if (!convId) return resp(400, { error: 'convId 가 필요합니다.' });
    const { rows } = await pool.query(
      `SELECT m.seq, m.role, m.content FROM sap_messages m
         JOIN sap_conversations c ON c.id = m.conv_id
        WHERE m.conv_id = $1 AND c.user_key = $2 AND m.dropped = false
        ORDER BY m.seq`, [convId, userKey]);
    return resp(200, { convId, messages: rows });
  }

  /* 사용량 집계 — 모델 비교의 근거 */
  if (path === '/sap/usage' && method === 'GET') {
    const { rows } = await pool.query(
      `SELECT model, count(*)::int AS calls,
              sum(input_tokens)::int  AS input_tokens,
              sum(output_tokens)::int AS output_tokens,
              round(avg(latency_ms))::int AS avg_ms,
              round(sum(cost_usd)::numeric, 4) AS cost_usd
         FROM sap_ai_calls GROUP BY model ORDER BY calls DESC`);
    return resp(200, { usage: rows });
  }

  /* 프록시 상태 */
  if (path === '/sap/health' && method === 'GET') {
    try {
      const u = new URL(HERMES_URL + '/healthz');
      const mod = u.protocol === 'https:' ? https : http;
      const code = await new Promise((res2, rej) => {
        const r = mod.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: 5000 },
          (x) => { x.resume(); res2(x.statusCode); });
        r.on('timeout', () => r.destroy(new Error('timeout')));
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
