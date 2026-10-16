/**
 * 연결현황 — 지금 무엇이 붙어 있고 무엇이 비어 있는지 한 화면에서 본다.
 *
 * 공급사가 예고 없이 사라지거나(Amadeus 2026-07-17), 키가 만료되거나,
 * 로컬 워커가 꺼져 있는 일이 잦다. 그때마다 코드를 뒤지는 대신 여기서 본다.
 *
 * 비밀은 절대 내보내지 않는다. "있다/없다" 와, 끝 네 글자 정도의 지문만 준다 —
 * 키를 바꿔 넣었는지 확인하려면 그 정도는 필요하고, 그 이상은 위험하다.
 */

'use strict';

/** 키가 바뀌었는지만 알 수 있을 만큼. 값을 복원할 수는 없다. */
function fingerprint(v) {
  if (!v) return null;
  return '…' + String(v).slice(-4) + ' (' + String(v).length + '자)';
}

/** 외부에 실제로 닿는지 본다. 키가 있어도 만료됐을 수 있다. */
async function ping(name, run) {
  const t0 = Date.now();
  try {
    const detail = await run();
    return { name, ok: true, ms: Date.now() - t0, detail: detail || '' };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, detail: String(e.message || e).slice(0, 160) };
  }
}

async function liteapiCheck() {
  const key = process.env.LITEAPI_KEY;
  if (!key) throw new Error('LITEAPI_KEY 없음');
  const r = await fetch('https://api.liteapi.travel/v3.0/data/countries',
    { headers: { 'X-API-Key': key, Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const n = (j.data || []).length;
  return n + '개국' + (key.startsWith('sand_') ? ' · 샌드박스' : ' · 운영');
}

async function tourapiCheck() {
  const key = process.env.TOURAPI_KEY;
  if (!key) throw new Error('TOURAPI_KEY 없음');
  const url = 'https://apis.data.go.kr/B551011/KorService2/areaCode2'
    + '?MobileOS=ETC&MobileApp=travel&_type=json&numOfRows=1&serviceKey=' + key;
  const r = await fetch(url);
  const t = await r.text();
  const m = t.match(/<returnAuthMsg>([^<]*)</) || t.match(/<errMsg>([^<]*)</);
  if (m) throw new Error(m[1]);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return '정상';
}

async function route({ resp }, event, path) {
  if (path !== '/status/links') return null;

  // 키가 꽂혀 있는지(설정)와 실제로 닿는지(연결)는 다른 문제다. 둘 다 본다.
  const checks = await Promise.all([
    ping('LiteAPI (해외 숙소·항공)', liteapiCheck),
    ping('TourAPI (국내 숙소)', tourapiCheck),
  ]);

  return resp(200, {
    checkedAt: new Date().toISOString(),
    links: checks,
    // 외부 호출 없이 설정만 보는 것들
    config: [
      { name: 'AI 모델 (Hermes 프록시)', set: Boolean(process.env.HERMES_URL && process.env.PROXY_TOKEN),
        note: process.env.AI_MODEL || 'openai/gpt-6-luna' },
      { name: 'DynamoDB', set: true, note: (process.env.AWS_REGION || 'ap-southeast-2') },
      { name: 'PostgreSQL (RDS)', set: Boolean(process.env.DB_HOST),
        note: 'RDS 해지됨 — /workKit /tennis 가 멈춘 이유' },
    ],
    keys: {
      LITEAPI_KEY: fingerprint(process.env.LITEAPI_KEY),
      TOURAPI_KEY: fingerprint(process.env.TOURAPI_KEY),
    },
  });
}

module.exports = { route };
