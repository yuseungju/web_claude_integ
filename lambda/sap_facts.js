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

const MAX_BODY      = 500;    // 사실 한 줄의 길이 상한(자)
const MAX_SUBJECT   = 60;
const MAX_NEW       = 20;     // 한 번 추출에서 받을 사실 수 상한
const MAX_PROMPT    = 40;     // 다음 질문의 프롬프트에 실어줄 사실 수
const MAX_LIST      = 300;    // 편집 화면에 내려줄 전체 목록 상한
const EXTRACT_CHARS = 60000;  // 추출에 넣을 대화 길이 상한

const STATUSES = ['draft', 'confirmed', 'rejected'];

/* ── 추출 ────────────────────────────────────────────── */

const EXTRACT_SYSTEM = [
  '당신은 SAP 분석 대화에서 "나중에 다시 쓸 사실"만 골라내는 정리 담당입니다.',
  '',
  '1. 사실만 남깁니다. 조회 과정, 시행착오, 실패한 시도, 인사말은 버립니다.',
  '2. 한 항목은 한 문장입니다. 근거(테이블·필드·프로그램명)를 문장 안에 넣습니다.',
  '3. subject 는 그 사실이 귀속되는 SAP 오브젝트명(대문자) 또는 업무 주제 한 단어입니다.',
  '4. 개인식별정보(이름·연락처·이메일·계좌·주소)와 실제 고객 데이터 값은 절대 쓰지 않습니다.',
  '   구조와 규칙만 씁니다. "고객 홍길동의 주문" 대신 "VBAK-KUNNR 로 주문자를 찾는다".',
  '5. 기존 사실을 줬다면 같은 내용을 다시 만들지 말고, 그 factId 를 적어 갱신하세요.',
  '6. 새로 알게 된 것이 없으면 빈 배열을 돌려줍니다. 억지로 채우지 않습니다.',
  '',
  'JSON 만 출력합니다. 설명도 코드펜스도 붙이지 않습니다.',
  '{"facts":[{"subject":"ZSDNR0010","body":"...","factId":"(기존 갱신일 때만)"}]}',
].join('\n');

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
  return arr
    .map(function (f) {
      return {
        subject: String((f && f.subject) || '').trim().slice(0, MAX_SUBJECT),
        body: String((f && f.body) || '').trim().slice(0, MAX_BODY),
        factId: String((f && f.factId) || '').trim().slice(0, 40) || null,
      };
    })
    .filter(function (f) { return f.subject && f.body; })
    .slice(0, MAX_NEW);
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
      ]);
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
        await ddb.send(new UpdateCommand({
          TableName: T_FACT,
          Key: { subject: prev.subject, factId: prev.factId },
          UpdateExpression: 'SET body = :b, updatedAt = :t, updatedBy = :u, rev = rev + :one',
          ExpressionAttributeValues: { ':b': f.body, ':t': now, ':u': 'ai', ':one': 1 },
        }));
        saved.push(Object.assign({}, prev, { body: f.body, updatedAt: now, updatedBy: 'ai' }));
        continue;
      }
      const item = {
        subject: f.subject, factId: newFactId(), body: f.body,
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
    const subject = String(body.subject || '').trim();
    const factId  = String(body.factId || '').trim();
    const rev     = Number(body.rev);
    if (!subject || !factId) return resp(400, { error: 'subject 와 factId 가 필요합니다.' });
    if (!Number.isInteger(rev) || rev < 1) {
      return resp(400, { error: 'rev 가 필요합니다. 목록을 다시 불러온 뒤 수정하세요.' });
    }

    const sets = ['updatedAt = :t', 'updatedBy = :u', 'rev = rev + :one'];
    const vals = { ':t': new Date().toISOString(), ':u': userKey, ':one': 1, ':rev': rev };
    if (body.body !== undefined) {
      const text = String(body.body).trim().slice(0, MAX_BODY);
      if (!text) return resp(400, { error: '내용이 비어 있습니다.' });
      sets.push('body = :b'); vals[':b'] = text;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) {
        return resp(400, { error: 'status 는 ' + STATUSES.join(' / ') + ' 중 하나여야 합니다.' });
      }
      sets.push('#st = :s'); vals[':s'] = body.status;
    }
    if (sets.length === 3) return resp(400, { error: '바꿀 내용이 없습니다.' });

    try {
      const r = await ddb.send(new UpdateCommand({
        TableName: T_FACT,
        Key: { subject, factId },
        UpdateExpression: 'SET ' + sets.join(', '),
        ConditionExpression: 'rev = :rev',
        ExpressionAttributeValues: vals,
        ExpressionAttributeNames: vals[':s'] !== undefined ? { '#st': 'status' } : undefined,
        ReturnValues: 'ALL_NEW',
      }));
      return resp(200, { fact: r.Attributes });
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') {
        const cur = await ddb.send(new GetCommand({ TableName: T_FACT, Key: { subject, factId } }));
        return resp(409, {
          error: '다른 사람이 먼저 수정했습니다. 아래 최신 내용을 보고 다시 고쳐주세요.',
          fact: cur.Item || null,
        });
      }
      throw e;
    }
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
