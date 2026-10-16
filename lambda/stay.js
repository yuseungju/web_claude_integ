/**
 * 숙소 찾기 — 사진·정보만 가져오고, 예약은 공급자 쪽 링크로 보낸다.
 *
 * 우리는 결제를 받지 않는다. 그래서 필요한 건 두 가지뿐이다.
 *   ① 콘텐츠  — 이름·사진·주소·좌표
 *   ② 링크    — "예약하기" 를 눌렀을 때 보낼 곳
 * 예약·재고·요금 API 는 쓰지 않는다. 그쪽은 계약과 책임이 따라온다.
 *
 * 공급원이 바뀌어도 화면은 그대로이도록 어댑터로 감싼다. Amadeus Self-Service 가
 * 2026-07-17 에 예고 없이 사라진 일이 있어서, 갈아끼우기 쉬운 쪽이 중요해졌다.
 *
 * 환경변수
 *   TOURAPI_KEY   국내 — 한국관광공사 TourAPI (공공데이터포털). 없으면 국내 검색이 꺼진다.
 *   LITEAPI_KEY   해외 — 선택. 없으면 해외 검색만 꺼지고 국내는 정상 동작한다.
 */

'use strict';

const TOURAPI_BASE = 'https://apis.data.go.kr/B551011/KorService2';
const LITEAPI_BASE = 'https://api.liteapi.travel/v3.0';

/* ── 공통 형태 ─────────────────────────────────────────────
   공급원이 무엇이든 화면은 이 모양만 안다. price 는 없을 수 있다 —
   TourAPI 에는 요금이 아예 없으므로 처음부터 null 을 허용한다. */
function stay(o) {
  return {
    stayId: String(o.stayId || ''),
    supplier: o.supplier,
    name: o.name || '',
    type: o.type || '',
    address: o.address || '',
    lat: typeof o.lat === 'number' ? o.lat : null,
    lng: typeof o.lng === 'number' ? o.lng : null,
    photos: (o.photos || []).filter(Boolean).slice(0, 8),
    tel: o.tel || '',
    // 공급원마다 없을 수 있다. TourAPI 에는 평점도 요금도 없다.
    rating: typeof o.rating === 'number' ? o.rating : null,
    price: o.price || null,
    link: o.link || '',
  };
}

/** 사용자를 보낼 곳. 공급자 상세 페이지가 없으면 검색으로 보낸다. */
function searchLink(name, region) {
  const q = encodeURIComponent([name, region].filter(Boolean).join(' '));
  return 'https://search.naver.com/search.naver?query=' + q;
}

/* ── 국내: 한국관광공사 TourAPI ────────────────────────────
   공공데이터라 "정보 제공" 이 목적이고 예약 기능이 없다. 링크로 내보내는
   우리 구조와 정확히 맞는다. contentTypeId 32 가 숙박이다. */

async function tourapi(path, params) {
  const key = process.env.TOURAPI_KEY;
  if (!key) throw new Error('국내 숙소 검색에는 TOURAPI_KEY 가 필요합니다.');

  const qs = new URLSearchParams(Object.assign({
    MobileOS: 'ETC',
    MobileApp: 'travel',
    _type: 'json',
  }, params));
  // 인증키는 이미 인코딩된 형태로 발급된다. URLSearchParams 로 다시 인코딩하면
  // %2B 가 %252B 가 돼 401 이 난다. 그래서 직접 이어 붙인다.
  const url = TOURAPI_BASE + path + '?' + qs.toString() + '&serviceKey=' + key;

  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error('TourAPI HTTP ' + r.status + ' — ' + text.slice(0, 200));

  let j;
  try { j = JSON.parse(text); } catch (e) {
    // 키가 틀리면 JSON 이 아니라 XML 오류 문서가 돌아온다 — 그 편이 원인을 말해준다
    const m = text.match(/<returnAuthMsg>([^<]*)</) || text.match(/<errMsg>([^<]*)</);
    throw new Error('TourAPI 응답을 읽지 못했습니다' + (m ? ' — ' + m[1] : '') );
  }
  const body = j.response && j.response.body;
  const items = body && body.items && body.items.item;
  return Array.isArray(items) ? items : (items ? [items] : []);
}

function fromTourapi(it) {
  const num = v => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };
  return stay({
    stayId: 'kr:' + it.contentid,
    supplier: 'tourapi',
    name: it.title,
    type: '숙박',
    address: [it.addr1, it.addr2].filter(Boolean).join(' '),
    lat: num(it.mapy),           // TourAPI 는 y 가 위도, x 가 경도다
    lng: num(it.mapx),
    photos: [it.firstimage, it.firstimage2],
    tel: it.tel,
    link: searchLink(it.title, it.addr1),
  });
}

/** 지역명으로 검색. 키워드 검색이 지역코드보다 쓰기 쉽다. */
async function searchKR(q, limit) {
  const items = await tourapi('/searchKeyword2', {
    keyword: q,
    contentTypeId: '32',                   // 숙박
    arrange: 'O',                          // 제목순(대표이미지 우선은 Q/R)
    numOfRows: String(Math.min(limit, 50)),
    pageNo: '1',
  });
  return items.map(fromTourapi);
}

/* ── 해외: LiteAPI ────────────────────────────────────────
   콘텐츠(이름·사진·주소)만 쓴다. 요금·예약 엔드포인트는 부르지 않는다. */

async function liteapi(path) {
  const key = process.env.LITEAPI_KEY;
  if (!key) throw new Error('해외 숙소 검색에는 LITEAPI_KEY 가 필요합니다.');

  const r = await fetch(LITEAPI_BASE + path, {
    headers: { 'X-API-Key': key, Accept: 'application/json' },
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('LiteAPI 응답을 읽지 못했습니다.'); }
  if (!r.ok) {
    const e = j && j.error;
    throw new Error('LiteAPI ' + r.status + ' — ' + ((e && (e.description || e.message)) || text.slice(0, 200)));
  }
  return j;
}

/**
 * 지역명 → 숙소.
 *
 * /data/hotels 는 지역명을 받지 않는다. 국가코드·좌표·placeId 중 하나가 있어야 해서,
 * 먼저 /data/places 로 "Tokyo" 같은 말을 placeId 로 바꾼 뒤 조회한다.
 * 한 번에 안 되는 게 번거롭지만, 사용자가 국가를 고르게 하는 것보다는 낫다.
 */
async function searchIntl(q, limit) {
  const places = await liteapi('/data/places?textQuery=' + encodeURIComponent(q));
  const place = (places.data || [])[0];
  if (!place) throw new Error('"' + q + '" 에 해당하는 지역을 찾지 못했습니다.');

  const j = await liteapi('/data/hotels?placeId=' + encodeURIComponent(place.placeId)
    + '&limit=' + Math.min(limit, 50));

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return (j.data || []).map(function (h) {
    return stay({
      stayId: 'intl:' + h.id,
      supplier: 'liteapi',
      name: h.name,
      // 별점이 있으면 그게 가장 알아보기 쉽다
      type: h.stars ? h.stars + '성급' : '',
      address: [h.address, h.city, h.country].filter(Boolean).join(', '),
      lat: num(h.latitude),
      lng: num(h.longitude),
      // 목록 응답에는 사진이 2장뿐이다(큰 것/썸네일). 상세를 부르면 더 있지만
      // 카드 한 장에 한 장만 쓰므로 목록만으로 충분하다.
      photos: [h.main_photo, h.thumbnail],
      rating: num(h.rating),
      link: searchLink(h.name, h.city),
    });
  });
}

/* ── 라우트 ────────────────────────────────────────────── */

async function route({ resp }, event, path, body) {
  if (!path.startsWith('/stay/')) return null;

  if (path === '/stay/search') {
    const q = String((body && body.q) || '').trim();
    const where = (body && body.where) === 'intl' ? 'intl' : 'kr';
    const limit = Math.min(Number(body && body.limit) || 20, 50);
    if (!q) return resp(400, { error: '검색어를 입력하세요.' });

    try {
      const items = where === 'kr' ? await searchKR(q, limit) : await searchIntl(q, limit);
      return resp(200, { where, count: items.length, items });
    } catch (e) {
      console.error('[stay] ' + where + ' 검색 실패:', e.message);
      return resp(502, { error: e.message });
    }
  }

  /** 어느 공급원이 켜져 있는지 화면이 미리 알 수 있게 한다. */
  if (path === '/stay/sources') {
    return resp(200, {
      kr: Boolean(process.env.TOURAPI_KEY),
      intl: Boolean(process.env.LITEAPI_KEY),
    });
  }

  return resp(404, { error: 'Not found' });
}

module.exports = { route };
