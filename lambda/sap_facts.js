/**
 * sap_facts — SAP 분석에서 "알게 된 사실"만 요약해 쌓고, 여러 사람이 함께 고치는 저장소.
 *
 * 대화 원문은 sap_messages 에 그대로 남지만 그건 읽기 어렵다. 쓸모 있는 건 그중
 * 한 줌이라, 분석이 끝날 때 모델이 사실만 뽑아 여기 쌓는다. 사람이 고치는 대상은
 * 대화가 아니라 이 요약이다.
 *
 *   sap_facts   PK subject(S) · SK factId(S)
 *
 *     subject    ZSDNR0010 / ZCMT0120 / 하드블럭입출고 — 사실이 귀속되는 오브젝트·주제
 *     body       한 문장 요약
 *     status     draft(모델이 뽑음) · confirmed(사람이 확인) · rejected(틀림)
 *     rev        수정 횟수. 저장할 때 조건으로 걸어 동시 수정 충돌을 잡는다.
 *     source     convId — 어느 분석에서 나왔는지
 *
 * 동시 수정: 여러 사람이 같은 사실을 고치므로 rev 없는 저장은 받지 않는다.
 * 읽은 rev 와 DB 의 rev 가 다르면 409 로 되돌려, 남의 수정을 덮어쓰지 않게 한다.
 */
const crypto = require('node:crypto');
const {
  GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const T_FACT = 'sap_facts';

const MAX_BODY      = 4000;   // 지식 한 건의 길이 상한(자). 덩어리로 쓰므로 넉넉히.
const MIN_BODY      = 60;     // 이보다 짧으면 "한 줄짜리 단편" 으로 보고 버린다
const MAX_SUBJECT   = 60;
const MAX_TITLE     = 80;
const MAX_NEW       = 5;      // 한 번 추출에서 받을 지식 수 상한
const MAX_PROMPT    = 40;     // 다음 질문의 프롬프트에 실어줄 사실 수
const MAX_LIST      = 300;    // 편집 화면에 내려줄 전체 목록 상한
const EXTRACT_CHARS = 40000;  // 추출에 넣을 대화 길이 상한
const EXTRACT_TOKENS = 2500;  // 추출 답변 길이. 한 줄짜리 사실 20개면 충분하고,
                              // 넉넉히 주면 응답이 느려져 29초 한도에 걸린다.

const STATUSES = ['draft', 'confirmed', 'rejected'];

/* ── 추출 ────────────────────────────────────────────── */

const EXTRACT_SYSTEM = [
  '당신은 SAP 분석 대화에서 "나중에 다시 쓸 지식"을 정리하는 담당입니다.',
  '',
  '# 가장 중요한 규칙 — 잘게 쪼개지 마세요',
  '한 오브젝트에 대해 알게 된 것은 **한 건으로 합쳐서** 씁니다.',
  '"A는 B를 포함한다", "B에 C 필드가 있다", "C는 표시되지 않는다" 를 세 건으로',
  '나누지 말고, 하나의 설명으로 이어 쓰세요. 쪼개면 읽는 사람이 다시 꿰맞춰야 합니다.',
  '',
  '- 한 건은 2~6문장입니다. 한 문장짜리 단편은 만들지 않습니다.',
  '- 전체 건수는 많아야 다섯입니다. 보통 한두 건이면 충분합니다.',
  '- 한 subject 에 대해 한 건만 만듭니다. 같은 subject 가 두 번 나오면 안 됩니다.',
  '- 여러 오브젝트에 걸친 내용이면, 중심이 되는 오브젝트 하나를 subject 로 삼고',
  '  나머지는 본문 안에서 이름으로 언급합니다.',
  '',
  '# 무엇을 쓰나',
  '- 구조·규칙·인과를 씁니다. "왜 그런지"가 들어가야 지식입니다.',
  '- 근거(테이블·필드·프로그램·FORM 이름)를 본문 안에 넣습니다.',
  '- 확인하지 못한 것은 "확인되지 않았다"고 적습니다. 지어내지 않습니다.',
  '- 조회 과정, 시행착오, 실패한 시도, 인사말은 버립니다.',
  '- 개인식별정보(이름·연락처·이메일·계좌·주소)와 실제 고객 데이터 값은 절대 쓰지 않습니다.',
  '  구조와 규칙만 씁니다. "고객 홍길동의 주문" 대신 "VBAK-KUNNR 로 주문자를 찾는다".',
  '',
  '# 분류',
  '- subject : 중심 오브젝트명(대문자) 또는 업무 주제.',
  '- package : 대화에서 그 오브젝트의 패키지(개발클래스)가 나왔으면 적습니다. 모르면 생략.',
  '- title   : 한 줄 제목. 목록에서 이것만 보고도 무슨 내용인지 알 수 있게.',
  '',
  '# 갱신',
  '기존 지식을 줬다면, 같은 주제는 새로 만들지 말고 그 factId 를 적어 갱신하세요.',
  '갱신할 때는 기존 내용에 새로 안 것을 합쳐 전체를 다시 씁니다(덧붙이는 게 아니라 다시 쓰기).',
  '새로 알게 된 것이 없으면 빈 배열을 돌려줍니다. 억지로 채우지 않습니다.',
  '',
  'JSON 만 출력합니다. 설명도 코드펜스도 붙이지 않습니다.',
  '{"facts":[{"subject":"ZSDR0665","title":"투숙일 표시 구조","package":"ZSDN01",',
  '"body":"여러 문장으로 이어 쓴 설명","factId":"(기존 갱신일 때만)"}]}',
].join('\n');

/* 패키지 앞글자로 업무모듈을 추정한다. 트리 1단계로만 쓰므로 틀려도 화면에서 고치면 된다.
   Z/Y 로 시작하는 커스텀 패키지는 두세 번째 글자가 모듈인 관례를 따른다. */
const MODULES = {
  SD: 'SD 영업', MM: 'MM 구매', FI: 'FI 재무', CO: 'CO 관리회계', PP: 'PP 생산',
  HR: 'HR 인사', PS: 'PS 프로젝트', QM: 'QM 품질', PM: 'PM 설비', WM: 'WM 창고',
  LE: 'LE 물류', TR: 'TR 자금', AA: 'AA 자산', CM: '공통', BC: 'BC 기술',
};

function guessModule(pkg, subject) {
  const s = String(pkg || subject || '').toUpperCase();
  const m = s.match(/^[ZY]([A-Z]{2})/);
  if (m && MODULES[m[1]]) return MODULES[m[1]];
  return '미분류';
}

/** 모델 응답에서 JSON 을 꺼낸다 — 코드펜스나 앞뒤 설명이 붙어 와도 건진다. */
function parseFacts(text) {
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
  const arr = Array.isArray(d) ? d : (Array.isArray(d.facts) ? d.facts : []);
  const cleaned = arr
    .map(function (f) {
      const pkg = String((f && f.package) || '').trim().toUpperCase().slice(0, MAX_SUBJECT);
      const subject = String((f && f.subject) || '').trim().slice(0, MAX_SUBJECT);
      return {
        subject, pkg,
        module: guessModule(pkg, subject),
        title: String((f && f.title) || '').trim().slice(0, MAX_TITLE),
        body: String((f && f.body) || '').trim().slice(0, MAX_BODY),
        factId: String((f && f.factId) || '').trim().slice(0, 40) || null,
      };
    })
    // 프롬프트로 "쪼개지 말라" 고 해도 모델은 쪼갠다. 길이로 한 번 더 거른다.
    .filter(function (f) { return f.subject && f.body.length >= MIN_BODY; });

  // 같은 subject 가 여러 건 오면 가장 자세한 것만 남긴다 — 한 주제에 한 건이 원칙이다.
  const best = new Map();
  for (const f of cleaned) {
    const prev = best.get(f.subject);
    if (!prev || f.body.length > prev.body.length) best.set(f.subject, f);
  }
  return Array.from(best.values()).slice(0, MAX_NEW);
}

/** 대화를 추출용 평문으로 — 도구 호출 원문은 길기만 하므로 자른다. */
function flatten(messages) {
  const lines = [];
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue;
    let c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (m.role === 'tool') c = c.slice(0, 2000) + (c.length > 2000 ? ' …(생략)' : '');
    if (!c.trim()) continue;
    lines.push((m.role === 'user' ? '[질문] ' : m.role === 'tool' ? '[조회결과] ' : '[분석] ') + c);
  }
  const joined = lines.join('\n\n');
  return joined.length > EXTRACT_CHARS ? joined.slice(-EXTRACT_CHARS) : joined;
}

/* ── 저장소 ──────────────────────────────────────────── */

function newFactId() {
  return 'f' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

async function bySubject(ddb, subject) {
  const r = await ddb.send(new QueryCommand({
    TableName: T_FACT,
    KeyConditionExpression: 'subject = :s',
    ExpressionAttributeValues: { ':s': subject },
  }));
  return r.Items || [];
}

/** 전체 목록. 규모가 작아(수백 건) Scan 으로 충분하다 — 커지면 status GSI 를 판다. */
async function listAll(ddb) {
  const r = await ddb.send(new ScanCommand({ TableName: T_FACT, Limit: MAX_LIST }));
  return (r.Items || []).sort(function (a, b) {
    return String(a.subject).localeCompare(String(b.subject))
        || String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

/** 프롬프트에 실을 텍스트. rejected 는 빼고, confirmed 를 draft 보다 앞에 둔다. */
async function loadFactsText(ddb, subjects) {
  let items = [];
  try {
    if (Array.isArray(subjects) && subjects.length) {
      const seen = new Set();
      for (const s of subjects.slice(0, 10)) {
        const key = String(s).trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items = items.concat(await bySubject(ddb, key));
      }
    } else {
      items = await listAll(ddb);
    }
  } catch (e) {
    console.error('[sap/facts] 프롬프트용 조회 실패:', e.message);
    return '';                       // 지식이 없다고 답이 막히진 않게 한다
  }
  const usable = items
    .filter(function (f) { return f.status !== 'rejected'; })
    .sort(function (a, b) {
      return (a.status === 'confirmed' ? 0 : 1) - (b.status === 'confirmed' ? 0 : 1);
    })
    .slice(0, MAX_PROMPT);
  if (!usable.length) return '';
  return [
    '다음은 지금까지 이 시스템을 분석해 정리해 둔 사실입니다.',
    '(검수중) 표시는 아직 사람이 확인하지 않은 것이니 그대로 믿지 말고 조회로 확인하세요.',
    '',
  ].concat(usable.map(function (f) {
    return '- [' + f.subject + '] ' + f.body + (f.status === 'confirmed' ? '' : ' (검수중)');
  })).join('\n');
}

/* ── 수정 ────────────────────────────────────────────── */

/* 바꿀 수 있는 칸. 분류(module·pkg)도 화면에서 고칠 수 있어야 한다 — 패키지 앞글자로
   추정하는 것이라 틀릴 때가 있다. subject 는 키라서 못 고친다. */
const EDITABLE = {
  body:   { max: MAX_BODY, required: true },
  title:  { max: MAX_TITLE },
  pkg:    { max: MAX_SUBJECT, upper: true },
  module: { max: 40 },
};

/**
 * 한 건을 고친다. rev 가 맞아야 저장되고, 어긋나면 409 와 최신 내용을 돌려준다.
 * 단건 수정과 일괄 저장이 같은 길을 타게 하려고 따로 뺐다.
 */
async function applyEdit(ddb, userKey, src) {
  const subject = String((src && src.subject) || '').trim();
  const factId  = String((src && src.factId) || '').trim();
  const rev     = Number(src && src.rev);
  if (!subject || !factId) return { code: 400, obj: { error: 'subject 와 factId 가 필요합니다.' } };
  if (!Number.isInteger(rev) || rev < 1) {
    return { code: 400, obj: { error: 'rev 가 필요합니다. 목록을 다시 불러온 뒤 수정하세요.' } };
  }

  const sets = ['updatedAt = :t', 'updatedBy = :u', 'rev = rev + :one'];
  const vals = { ':t': new Date().toISOString(), ':u': userKey, ':one': 1, ':rev': rev };
  const names = {};

  let n = 0;
  for (const key of Object.keys(EDITABLE)) {
    const rule = EDITABLE[key];
    if (src[key] === undefined) continue;
    let v = String(src[key]).trim().slice(0, rule.max);
    if (rule.upper) v = v.toUpperCase();
    if (rule.required && !v) return { code: 400, obj: { error: '내용이 비어 있습니다.' } };
    const ph = ':v' + (n++);
    // module 은 DynamoDB 예약어라 이름을 치환해야 한다
    names['#' + key] = key;
    sets.push('#' + key + ' = ' + ph);
    vals[ph] = v;
  }
  if (src.status !== undefined) {
    if (!STATUSES.includes(src.status)) {
      return { code: 400, obj: { error: 'status 는 ' + STATUSES.join(' / ') + ' 중 하나여야 합니다.' } };
    }
    names['#status'] = 'status';
    sets.push('#status = :st');
    vals[':st'] = src.status;
  }
  if (sets.length === 3) return { code: 400, obj: { error: '바꿀 내용이 없습니다.' } };

  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: T_FACT,
      Key: { subject, factId },
      UpdateExpression: 'SET ' + sets.join(', '),
      ConditionExpression: 'rev = :rev',
      ExpressionAttributeValues: vals,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ReturnValues: 'ALL_NEW',
    }));
    return { code: 200, obj: { fact: r.Attributes } };
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      const cur = await ddb.send(new GetCommand({ TableName: T_FACT, Key: { subject, factId } }));
      return {
        code: 409,
        obj: {
          error: '다른 사람이 먼저 수정했습니다. 최신 내용을 보고 다시 고쳐주세요.',
          fact: cur.Item || null,
        },
      };
    }
    throw e;
  }
}

/* ── 라우트 ──────────────────────────────────────────── */

/**
 * /sap/facts* 를 처리한다. 해당 경로가 아니면 null.
 * deps: { ddb, callAI, resp, userKey, body, qs, method, path }
 */
async function factRoute(deps) {
  const { ddb, callAI, resp, userKey, body, qs, method, path } = deps;
  if (!path.startsWith('/sap/facts')) return null;

  /* 분석 한 건이 끝났을 때 — 대화에서 사실을 뽑아 draft 로 쌓는다 */
  if (path === '/sap/facts/extract' && method === 'POST') {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return resp(400, { error: 'messages 배열이 필요합니다.' });

    if (!callAI) {
      return resp(503, {
        error: '요약 추출은 모델이 필요합니다. HERMES_URL / PROXY_TOKEN 이 설정된 서버에서만 됩니다. '
             + '(지식 조회·수정은 이 서버에서도 됩니다)',
      });
    }

    const convo = flatten(messages);
    if (convo.length < 50) return resp(200, { facts: [], skipped: '대화가 너무 짧습니다.' });

    // 이미 아는 것을 함께 줘야 같은 말이 쌓이지 않는다
    let known = [];
    try { known = await listAll(ddb); } catch (e) { /* 없으면 없는 대로 뽑는다 */ }
    const knownText = known.length
      ? '이미 저장된 사실:\n' + known.slice(0, MAX_PROMPT).map(function (f) {
          return '- (' + f.factId + ') [' + f.subject + '] ' + f.body;
        }).join('\n') + '\n\n'
      : '';

    let out;
    try {
      out = await callAI([
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: knownText + '아래 분석에서 사실을 뽑으세요.\n\n' + convo },
      ], null, null, EXTRACT_TOKENS);
    } catch (e) {
      console.error('[sap/facts] 추출 호출 실패:', e.message);
      return resp(502, { error: '요약 추출에 실패했습니다: ' + e.message });
    }

    const picked = parseFacts(out.text);
    if (!picked.length) return resp(200, { facts: [], note: '새로 쌓을 사실이 없습니다.' });

    const knownById = new Map(known.map(function (f) { return [f.factId, f]; }));
    const now = new Date().toISOString();
    const saved = [];
    for (const f of picked) {
      const prev = f.factId ? knownById.get(f.factId) : null;
      if (prev) {
        // 모델이 갱신이라고 본 건 — 사람이 confirmed 로 만든 건 건드리지 않는다
        if (prev.status === 'confirmed') continue;
        const patch = {
          body: f.body,
          title: f.title || prev.title || '',
          // 분류는 사람이 고쳐둘 수 있으므로 기존 값이 있으면 지키고, 비었을 때만 채운다
          pkg: prev.pkg || f.pkg || '',
          module: prev.pkg ? prev.module : (f.pkg ? f.module : (prev.module || f.module)),
        };
        await ddb.send(new UpdateCommand({
          TableName: T_FACT,
          Key: { subject: prev.subject, factId: prev.factId },
          UpdateExpression: 'SET body = :b, title = :ti, pkg = :p, #md = :m, '
                          + 'updatedAt = :t, updatedBy = :u, rev = rev + :one',
          ExpressionAttributeNames: { '#md': 'module' },
          ExpressionAttributeValues: {
            ':b': patch.body, ':ti': patch.title, ':p': patch.pkg, ':m': patch.module,
            ':t': now, ':u': 'ai', ':one': 1,
          },
        }));
        saved.push(Object.assign({}, prev, patch, { updatedAt: now, updatedBy: 'ai' }));
        continue;
      }
      const item = {
        subject: f.subject, factId: newFactId(), body: f.body,
        title: f.title || '', pkg: f.pkg || '', module: f.module || '미분류',
        status: 'draft', rev: 1, source: String(body.convId || '').slice(0, 64),
        createdAt: now, createdBy: userKey, updatedAt: now, updatedBy: 'ai',
      };
      await ddb.send(new PutCommand({ TableName: T_FACT, Item: item }));
      saved.push(item);
    }
    console.log('[sap/facts] extract conv=' + (body.convId || '-') + ' 저장 ' + saved.length + '건');
    return resp(200, { facts: saved });
  }

  /* 목록 — subject 를 주면 그 오브젝트 것만, 없으면 전체 */
  if (path === '/sap/facts' && method === 'GET') {
    const subject = String(qs.subject || '').trim();
    const items = subject ? await bySubject(ddb, subject) : await listAll(ddb);
    return resp(200, { facts: items, count: items.length });
  }

  /* 수정 — rev 를 함께 보내야 받는다(동시 수정 보호) */
  if (path === '/sap/facts' && (method === 'PUT' || method === 'PATCH')) {
    const r = await applyEdit(ddb, userKey, body);
    return resp(r.code, r.obj);
  }

  /* 일괄 저장 — 화면에서 여러 건을 고치고 한 번에 보낸다.
     한 건이 충돌해도 나머지는 저장한다. 하나 때문에 전부 되돌리면
     고친 내용을 다시 입력해야 하는데, 그게 더 손해다. */
  if (path === '/sap/facts/batch' && (method === 'POST' || method === 'PUT')) {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return resp(400, { error: 'items 배열이 필요합니다.' });
    if (items.length > MAX_LIST) {
      return resp(400, { error: '한 번에 ' + MAX_LIST + '건까지만 저장할 수 있습니다.' });
    }
    const results = [];
    for (const it of items) {
      try {
        const r = await applyEdit(ddb, userKey, it);
        results.push({
          subject: it && it.subject, factId: it && it.factId,
          ok: r.code === 200, code: r.code, error: r.obj.error, fact: r.obj.fact || null,
        });
      } catch (e) {
        results.push({
          subject: it && it.subject, factId: it && it.factId,
          ok: false, code: 500, error: e.message, fact: null,
        });
      }
    }
    const saved = results.filter(function (r) { return r.ok; }).length;
    console.log('[sap/facts] batch ' + saved + '/' + results.length + '건 저장');
    return resp(200, { saved, total: results.length, results });
  }

  /* 삭제 — 실제로 지우지 않고 rejected 로 둔다(왜 틀렸는지가 남아야 한다) */
  if (path === '/sap/facts' && method === 'DELETE') {
    const subject = String(body.subject || qs.subject || '').trim();
    const factId  = String(body.factId || qs.factId || '').trim();
    if (!subject || !factId) return resp(400, { error: 'subject 와 factId 가 필요합니다.' });
    const r = await ddb.send(new UpdateCommand({
      TableName: T_FACT,
      Key: { subject, factId },
      UpdateExpression: 'SET #st = :s, updatedAt = :t, updatedBy = :u, rev = rev + :one',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':s': 'rejected', ':t': new Date().toISOString(), ':u': userKey, ':one': 1,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return resp(200, { fact: r.Attributes });
  }

  return resp(404, { error: '알 수 없는 /sap/facts 경로' });
}

module.exports = { factRoute, loadFactsText, T_FACT };
