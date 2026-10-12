/**
 * /sap/* — SAP 운영 문의 AI 응답.
 *
 * 호출 경로
 *   Lambda → EC2 인증 프록시(:8646) → hermes proxy(127.0.0.1:8645) → Nous Portal
 *
 * DB 를 쓰지 않는다
 *   RDS 는 2026-10-12 해지됐고 되살릴 계획이 없다(CLAUDE.md). 그래서 대화 기록을
 *   서버에 두지 않고 **브라우저가 히스토리를 들고 매 요청에 함께 보낸다**.
 *   hermes proxy 가 /v1/responses 를 중계하지 않아(허용: chat/completions,
 *   completions, embeddings, models) previous_response_id 로 서버에 맡기는 길도
 *   없으므로, 어차피 전체 히스토리를 실어야 한다 — 그 보관처만 브라우저로 옮긴 셈이다.
 *
 *   한계: 브라우저를 바꾸면 대화가 사라지고, 문의 이력이 서버에 쌓이지 않는다.
 *   이력 분석이 필요해지면 DynamoDB(사실상 무료)를 붙이면 된다.
 *
 * 사용량은 CloudWatch 로그로 남긴다 — 모델을 고르려면 실측값이 필요하다.
 *
 * SAP 조회는 아직 붙어 있지 않다. 사내망 접근이 열리면 도구로 추가한다.
 *
 * 필요한 환경변수
 *   HERMES_URL    예: http://3.26.56.6:8646
 *   PROXY_TOKEN   EC2 authproxy 와 나눠 갖는 비밀값
 *   AI_MODEL      기본 모델 (요청의 model 이 우선)
 */
const http = require('node:http');
const https = require('node:https');

const HERMES_URL  = (process.env.HERMES_URL || '').replace(/\/$/, '');
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const MODEL       = process.env.AI_MODEL || 'openai/gpt-6-luna';

const MAX_INPUT    = 20000;   // 질문 한 건의 길이 상한(자)
const MAX_HISTORY  = 24;      // 컨텍스트에 싣는 최근 메시지 수
const MAX_HIST_CH  = 60000;   // 히스토리 전체 길이 상한(자) — 비용 폭주 방지
const MAX_TOKENS   = 1500;
const TIMEOUT_MS   = 25000;   // API Gateway 29초보다 짧게

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

/** 클라이언트가 보낸 히스토리를 신뢰하지 않고 모양·길이를 다듬는다. */
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const kept = [];
  let chars = 0;
  // 최근 것부터 담다가 상한에 닿으면 멈춘다(오래된 쪽이 잘린다)
  for (let i = raw.length - 1; i >= 0 && kept.length < MAX_HISTORY; i--) {
    const m = raw[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content || '').slice(0, MAX_INPUT);
    if (!content) continue;
    if (chars + content.length > MAX_HIST_CH) break;
    chars += content.length;
    kept.push({ role: m.role, content });
  }
  return kept.reverse();
}

/* ── 라우트 ──────────────────────────────────────────── */
async function route(ctx, event, method, path) {
  const { resp, getBody } = ctx;          // pool 은 쓰지 않는다 (DB 없음)
  if (!path.startsWith('/sap/')) return null;

  if (!HERMES_URL || !PROXY_TOKEN) {
    return resp(500, { error: 'HERMES_URL / PROXY_TOKEN 환경변수가 설정되지 않았습니다.' });
  }

  const body = getBody(event) || {};
  const qs = event.queryStringParameters || {};

  /* 질문 → 답변 */
  if (path === '/sap/ask' && method === 'POST') {
    const text = String(body.text || '').trim();
    if (!text) return resp(400, { error: '메시지가 비어 있습니다.' });
    if (text.length > MAX_INPUT) return resp(400, { error: `메시지가 너무 깁니다(${MAX_INPUT}자 제한).` });

    const history = sanitizeHistory(body.history);
    const messages = [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'user', content: text },
    ];

    try {
      const out = await callAI(messages, body.model);
      const u = out.usage || {};
      console.log(`[sap] ${out.model} ${out.latencyMs}ms `
        + `in=${u.prompt_tokens} out=${u.completion_tokens} cost=${u.cost} turns=${history.length + 2}`);
      return resp(200, {
        text: out.text,
        model: out.model,
        latencyMs: out.latencyMs,
        usage: u,
        turns: history.length + 2,
        continued: history.length > 0,
      });
    } catch (e) {
      console.error('[sap] 호출 실패:', e.message);
      return resp(502, { error: e.message });
    }
  }

  /* 프록시 상태 — 연결 점검용 */
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
