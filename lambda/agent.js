/**
 * /agent/* — 에이전트 관리 웹의 백엔드.
 *
 * workKit 의 기사작성이 하던 일(여러 글을 모아 합치고 요약해서 보관)을 가져왔다.
 * 다만 그쪽은 RDS 에 묶여 있어(/issues · /mypage · /bookmarks) 그대로 못 쓴다.
 * RDS 는 2026-10-12 에 해지됐으므로 여기서는 DynamoDB 를 쓴다.
 *
 *   agent_docs   PK userKey(S) · SK docId(S)
 *
 * 메뉴가 늘어도 테이블을 새로 파지 않는다. kind 로 나눈다 — 메뉴마다 테이블을
 * 만들면 그때마다 콘솔에서 테이블 생성과 IAM 수정을 반복해야 한다.
 *
 *     kind     merge | ...        어느 메뉴에서 만든 문서인가
 *     title    제목
 *     sources  [{title, text}]    합치기 전 원문들. 다시 편집할 수 있어야 하므로 남긴다
 *     body     합쳐진 글
 *     summary  요약 (모델)
 *     rev      수정 횟수. 조건부 저장으로 동시 수정을 잡는다
 *
 * AI 는 sap.js 의 callAI 를 그대로 쓴다(Lambda → EC2 authproxy → hermes proxy → 모델).
 */
const crypto = require('node:crypto');
const {
  DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const T_DOC = 'agent_docs';

const MAX_TITLE   = 200;
const MAX_TEXT    = 200000;   // 글 하나의 길이 상한(자)
const MAX_SOURCES = 50;       // 한 문서에 담을 원문 수
const MAX_LIST    = 200;
const AI_TOKENS   = 4000;     // 요약 답변 길이. 길면 29초(API Gateway)에 걸린다

function newDocId() {
  return 'd' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function clean(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max);
}

/** 원문 목록을 정리한다. 제목 없이 본문만 넣는 경우가 흔하므로 본문만 있으면 받는다. */
function cleanSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(function (s) {
      return {
        title: clean(s && s.title, MAX_TITLE),
        text: clean(s && s.text, MAX_TEXT),
      };
    })
    .filter(function (s) { return s.text; })
    .slice(0, MAX_SOURCES);
}

/* ── 합치기 ──────────────────────────────────────────── */

/** 모델을 부르지 않는다. 합치는 건 규칙이 정해진 일이라 돈을 쓸 이유가 없다. */
function mergeSources(sources) {
  return sources
    .map(function (s, i) {
      const head = s.title || '원문 ' + (i + 1);
      return '## ' + head + '\n\n' + s.text;
    })
    .join('\n\n---\n\n');
}

const SUMMARY_SYSTEM = [
  '당신은 여러 글을 하나로 정리하는 편집자입니다.',
  '',
  '1. 사실만 남깁니다. 같은 내용이 여러 글에 나오면 한 번만 씁니다.',
  '2. 원문에 없는 내용을 지어내지 않습니다. 숫자와 고유명사는 원문 그대로 씁니다.',
  '3. 글마다 말이 다르면 "원문에 따라 다르게 적혀 있다"고 적고 양쪽을 다 보여줍니다.',
  '4. 개인식별정보(이름·연락처·이메일·계좌·주소)는 쓰지 않습니다.',
  '5. 한국어로 씁니다.',
  '',
  '형식:',
  '## 한 줄 요약',
  '## 핵심',
  '- 항목 3~7개',
  '## 덧붙일 것',
  '(원문이 서로 어긋나거나 빠진 부분이 있으면 여기에. 없으면 이 절은 생략)',
].join('\n');

/* ── 저장소 ──────────────────────────────────────────── */

async function listDocs(ddb, userKey, kind) {
  const r = await ddb.send(new QueryCommand({
    TableName: T_DOC,
    KeyConditionExpression: 'userKey = :u',
    ExpressionAttributeValues: { ':u': userKey },
    Limit: MAX_LIST,
  }));
  const items = (r.Items || []).filter(function (d) { return !kind || d.kind === kind; });
  // 목록에는 본문을 싣지 않는다. 문서가 쌓이면 목록 응답만 수 MB 가 된다.
  return items
    .map(function (d) {
      return {
        docId: d.docId, kind: d.kind, title: d.title, rev: d.rev,
        sourceCount: (d.sources || []).length,
        bodyChars: String(d.body || '').length,
        hasSummary: Boolean(d.summary),
        createdAt: d.createdAt, updatedAt: d.updatedAt, updatedBy: d.updatedBy,
      };
    })
    .sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
}

/* ── 라우트 ──────────────────────────────────────────── */

/**
 * /agent/* 를 처리한다. 해당 경로가 아니면 null.
 * deps: { ddb, callAI, resp, getBody }
 */
async function route(deps, event, method, path) {
  const { ddb, callAI, resp, getBody } = deps;
  if (!path.startsWith('/agent/')) return null;

  const body = getBody(event) || {};
  const qs = event.queryStringParameters || {};
  const userKey = String(body.userKey || qs.userKey || '').trim();
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(userKey)) {
    return resp(400, { error: '사용자 키가 올바르지 않습니다.' });
  }

  /* 목록 */
  if (path === '/agent/docs' && method === 'GET') {
    const docs = await listDocs(ddb, userKey, clean(qs.kind, 40));
    return resp(200, { docs, count: docs.length });
  }

  /* 한 건 (본문까지) */
  if (path === '/agent/doc' && method === 'GET') {
    const docId = clean(qs.docId, 64);
    if (!docId) return resp(400, { error: 'docId 가 필요합니다.' });
    const r = await ddb.send(new GetCommand({ TableName: T_DOC, Key: { userKey, docId } }));
    if (!r.Item) return resp(404, { error: '문서를 찾지 못했습니다.' });
    return resp(200, { doc: r.Item });
  }

  /* 저장 — docId 가 없으면 새로 만들고, 있으면 rev 를 맞춰 덮어쓴다 */
  if (path === '/agent/doc' && (method === 'POST' || method === 'PUT')) {
    const sources = cleanSources(body.sources);
    const title = clean(body.title, MAX_TITLE) || (sources[0] && sources[0].title) || '제목 없음';
    const bodyText = clean(body.body, MAX_TEXT) || mergeSources(sources);
    if (!bodyText && !sources.length) {
      return resp(400, { error: '저장할 내용이 없습니다.' });
    }

    const now = new Date().toISOString();
    const docId = clean(body.docId, 64);

    if (!docId) {
      const item = {
        userKey, docId: newDocId(), kind: clean(body.kind, 40) || 'merge',
        title, sources, body: bodyText, summary: clean(body.summary, MAX_TEXT),
        rev: 1, createdAt: now, createdBy: userKey, updatedAt: now, updatedBy: userKey,
      };
      await ddb.send(new PutCommand({ TableName: T_DOC, Item: item }));
      return resp(200, { doc: item, created: true });
    }

    const rev = Number(body.rev);
    if (!Number.isInteger(rev) || rev < 1) {
      return resp(400, { error: 'rev 가 필요합니다. 문서를 다시 불러온 뒤 저장하세요.' });
    }
    try {
      const r = await ddb.send(new UpdateCommand({
        TableName: T_DOC,
        Key: { userKey, docId },
        UpdateExpression: 'SET title = :t, sources = :s, body = :b, summary = :m, '
                        + 'updatedAt = :at, updatedBy = :by, rev = rev + :one',
        ConditionExpression: 'rev = :rev',
        ExpressionAttributeValues: {
          ':t': title, ':s': sources, ':b': bodyText,
          ':m': clean(body.summary, MAX_TEXT),
          ':at': now, ':by': userKey, ':one': 1, ':rev': rev,
        },
        ReturnValues: 'ALL_NEW',
      }));
      return resp(200, { doc: r.Attributes });
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') {
        const cur = await ddb.send(new GetCommand({ TableName: T_DOC, Key: { userKey, docId } }));
        return resp(409, {
          error: '다른 곳에서 먼저 저장했습니다. 최신 내용을 확인한 뒤 다시 저장하세요.',
          doc: cur.Item || null,
        });
      }
      throw e;
    }
  }

  /* 삭제 — 문서는 사용자가 직접 만든 것이라 표시만 남기지 않고 실제로 지운다 */
  if (path === '/agent/doc' && method === 'DELETE') {
    const docId = clean(body.docId || qs.docId, 64);
    if (!docId) return resp(400, { error: 'docId 가 필요합니다.' });
    await ddb.send(new DeleteCommand({ TableName: T_DOC, Key: { userKey, docId } }));
    return resp(200, { deleted: docId });
  }

  /* 합치기 — 서버가 한다. 규칙이 정해진 일이라 모델을 부르지 않는다. */
  if (path === '/agent/merge' && method === 'POST') {
    const sources = cleanSources(body.sources);
    if (!sources.length) return resp(400, { error: '합칠 글이 없습니다.' });
    const merged = mergeSources(sources);
    return resp(200, { body: merged, chars: merged.length, count: sources.length });
  }

  /* 요약 — 헤르메스를 거쳐 모델에 묻는다 */
  if (path === '/agent/summary' && method === 'POST') {
    if (!callAI) {
      return resp(503, {
        error: '요약은 모델이 필요합니다. HERMES_URL / PROXY_TOKEN 이 설정된 서버에서만 됩니다.',
      });
    }
    const sources = cleanSources(body.sources);
    const text = clean(body.body, MAX_TEXT) || mergeSources(sources);
    if (text.length < 30) return resp(400, { error: '요약할 내용이 너무 짧습니다.' });

    const extra = clean(body.instruction, 2000);
    try {
      const out = await callAI([
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: (extra ? '추가 지시: ' + extra + '\n\n' : '') + '아래 글을 정리하세요.\n\n' + text,
        },
      ], body.model, null, AI_TOKENS);
      const u = out.usage || {};
      console.log('[agent/summary] ' + out.model + ' ' + out.latencyMs + 'ms '
        + 'in=' + u.prompt_tokens + ' out=' + u.completion_tokens + ' cost=' + u.cost);
      return resp(200, {
        summary: out.text || '', model: out.model, latencyMs: out.latencyMs, usage: u,
      });
    } catch (e) {
      console.error('[agent/summary] 실패:', e.message);
      return resp(502, { error: '요약에 실패했습니다: ' + e.message });
    }
  }

  return resp(404, { error: '알 수 없는 /agent 경로' });
}

module.exports = { route, mergeSources, T_DOC };
