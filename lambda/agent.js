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
const MAX_DATA    = 400000;   // data(구조 있는 내용)의 JSON 길이 상한
const AI_TOKENS   = 4000;     // 요약 답변 길이. 길면 29초(API Gateway)에 걸린다

function newDocId() {
  return 'd' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function clean(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max);
}

/**
 * 글이 아닌 내용을 담는 칸. 여행 일정처럼 날짜·시간·장소가 얽힌 것은 본문 한 덩이로
 * 누르면 다시 편집할 수가 없다. 메뉴마다 모양이 다르므로 서버는 형태를 따지지 않고
 * 크기만 본다 — 무엇이 들어갈지는 그 메뉴의 화면이 정한다.
 */
function cleanData(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') return undefined;
  const size = JSON.stringify(raw).length;
  if (size > MAX_DATA) {
    const e = new Error('내용이 너무 큽니다(' + Math.round(size / 1024) + 'KB). 나눠서 저장하세요.');
    e.tooBig = true;
    throw e;
  }
  return raw;
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

/* ── 여행 일정 ───────────────────────────────────────── */

const TRAVEL_SYSTEM = [
  '당신은 여행 일정을 짜는 사람입니다. 사람이 고쳐 쓸 "초안"을 만듭니다.',
  '',
  '1. 하루에 3~5개만 넣습니다. 빡빡하면 실제로 못 지킵니다.',
  '2. 이동 시간을 고려해 가까운 곳끼리 같은 날에 묶습니다.',
  '3. 시간은 24시간 표기(09:30)로 적습니다.',
  '4. 영업시간·휴무일처럼 확실하지 않은 것은 메모에 "확인 필요" 라고 적습니다.',
  '   지어내서 단정하지 않습니다.',
  '5. 장소는 실제로 있는 곳을 씁니다. 모르면 "○○ 근처 식당" 처럼 두루뭉술하게 두고',
  '   메모에 직접 고르라고 적습니다.',
  '6. 한국어로 씁니다.',
  '',
  'JSON 만 출력합니다. 설명도 코드펜스도 붙이지 않습니다.',
  '{"days":[{"title":"1일차 — 시내 중심","items":[',
  '  {"time":"09:30","place":"장소 이름","memo":"한 줄 메모"}',
  ']}]}',
].join('\n');

/** 모델 응답에서 일정을 꺼낸다. 코드펜스나 앞뒤 설명이 붙어 와도 건진다. */
function parsePlan(text, maxDays) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  if (s[0] !== '{') {
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return [];
    s = s.slice(i, j + 1);
  }
  let d;
  try { d = JSON.parse(s); } catch (e) { return []; }
  const days = Array.isArray(d) ? d : (Array.isArray(d.days) ? d.days : []);
  return days.slice(0, maxDays).map(function (day, n) {
    return {
      title: clean(day && day.title, MAX_TITLE) || (n + 1) + '일차',
      items: (Array.isArray(day && day.items) ? day.items : []).slice(0, 12).map(function (it) {
        return {
          time: clean(it && it.time, 10),
          place: clean(it && it.place, 200),
          memo: clean(it && it.memo, 500),
        };
      }).filter(function (it) { return it.place || it.memo; }),
    };
  });
}

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
  // 한글 이름을 받는다 — sap.js 와 같은 규칙. 자세한 이유는 거기 주석 참고.
  if (!/^[\p{L}\p{N}._@-]{2,64}$/u.test(userKey)) {
    return resp(400, { error: '사용자 키가 올바르지 않습니다(글자·숫자와 . _ @ - 만, 2~64자).' });
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
    let data;
    try { data = cleanData(body.data); }
    catch (e) { if (e.tooBig) return resp(413, { error: e.message }); throw e; }

    // 여행 일정처럼 글 없이 data 만 있는 메뉴도 있다
    if (!bodyText && !sources.length && !data) {
      return resp(400, { error: '저장할 내용이 없습니다.' });
    }

    const now = new Date().toISOString();
    const docId = clean(body.docId, 64);

    if (!docId) {
      const item = {
        userKey, docId: newDocId(), kind: clean(body.kind, 40) || 'merge',
        title, sources, body: bodyText, summary: clean(body.summary, MAX_TEXT),
        data: data || null,
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
        UpdateExpression: 'SET title = :t, sources = :s, body = :b, summary = :m, #dt = :d, '
                        + 'updatedAt = :at, updatedBy = :by, rev = rev + :one',
        ConditionExpression: 'rev = :rev',
        ExpressionAttributeNames: { '#dt': 'data' },   // data 는 DynamoDB 예약어다
        ExpressionAttributeValues: {
          ':t': title, ':s': sources, ':b': bodyText,
          ':m': clean(body.summary, MAX_TEXT),
          ':d': data === undefined ? null : data,
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

  /* 여행 일정 초안 — 빈 화면에서 시작하는 게 제일 어렵다. 뼈대를 만들어주고
     사람이 고치게 한다. 날짜·시간이 얽혀 있으므로 글이 아니라 구조로 받는다. */
  if (path === '/agent/travel/plan' && method === 'POST') {
    if (!callAI) {
      return resp(503, {
        error: '일정 제안은 모델이 필요합니다. HERMES_URL / PROXY_TOKEN 이 설정된 서버에서만 됩니다.',
      });
    }
    const where = clean(body.where, 200);
    const days = Math.min(Math.max(parseInt(body.days, 10) || 0, 1), 30);
    if (!where) return resp(400, { error: '어디로 가는지 알려주세요.' });

    const want = clean(body.want, 2000);
    const startDate = clean(body.startDate, 20);

    try {
      const out = await callAI([
        { role: 'system', content: TRAVEL_SYSTEM },
        {
          role: 'user',
          content: [
            '여행지: ' + where,
            '기간: ' + days + '일',
            startDate ? '출발일: ' + startDate : '',
            want ? '원하는 것: ' + want : '',
          ].filter(Boolean).join('\n'),
        },
      ], body.model, null, AI_TOKENS);

      const plan = parsePlan(out.text, days);
      if (!plan.length) {
        return resp(502, { error: '일정을 만들지 못했습니다. 다시 시도해 보세요.' });
      }
      const u = out.usage || {};
      console.log('[agent/travel] ' + where + ' ' + days + '일 · ' + out.model
        + ' ' + out.latencyMs + 'ms cost=' + u.cost);
      return resp(200, { days: plan, model: out.model, latencyMs: out.latencyMs, usage: u });
    } catch (e) {
      console.error('[agent/travel] 실패:', e.message);
      return resp(502, { error: '일정 제안에 실패했습니다: ' + e.message });
    }
  }

  return resp(404, { error: '알 수 없는 /agent 경로' });
}

module.exports = { route, mergeSources, T_DOC };
