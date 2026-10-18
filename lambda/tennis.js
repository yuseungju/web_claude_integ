/**
 * /tennis/* — 대치유수지 예약 사이트 계정 관리 · 예약완료 내역 수집
 *
 * 예약 사이트는 CSRF 토큰도 캡차도 없는 평범한 PHP 폼 로그인이라
 * (POST / 에 act=user.user_login_act), 브라우저 확장 없이 서버에서
 * 바로 로그인하고 페이지를 받아올 수 있다. 그래서 확장 코드는 건드리지 않는다.
 *
 * 한 번 호출에 계정 하나만 처리한다. Lambda 제한 시간 안에 끝내기 위해서고,
 * 계정이 늘어도 프론트가 순서대로 돌리면 된다.
 */
const https = require('https');
const crypto = require('crypto');

const SITE_HOST = 'www.xn--vk1b79znxd34c61h.kr';
const CHECK_PATH = '/?act=info.page&pcode=check';
const MAX_PAGE = 10;

/* ── 예약 사이트 HTTP ─────────────────────────────────────────
 * .kr 권한 네임서버가 가끔 늦어서 첫 조회가 ENOTFOUND 로 떨어진다.
 * 실제로 배포 직후 한 번 겪었고, 몇 초 뒤 재시도하면 정상이었다.
 * 그래서 DNS·연결 계열 오류는 잠깐 쉬었다 다시 시도한다.
 */
const RETRYABLE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function request(method, path, opts = {}) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await requestOnce(method, path, opts);
    } catch (e) {
      last = e;
      if (!RETRYABLE.has(e.code)) throw e;
      if (attempt < 3) await wait(attempt * 700);
    }
  }
  throw last;
}

function requestOnce(method, path, { cookie, form } = {}) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    };
    if (cookie) headers.Cookie = cookie;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
      headers.Referer = 'https://' + SITE_HOST + '/?act=user.user_login';
    }
    const req = https.request({ host: SITE_HOST, path, method, headers, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        html: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('예약 사이트 응답 시간 초과')); });
    if (body) req.write(body);
    req.end();
  });
}

const cookieFrom = res => (res.headers['set-cookie'] || [])
  .map(c => c.split(';')[0]).join('; ');

/** 로그인해서 세션 쿠키를 얻는다. 실패하면 null. */
async function login(loginId, password) {
  const first = await request('GET', '/?act=user.user_login');
  let cookie = cookieFrom(first);

  const res = await request('POST', '/', {
    cookie,
    form: {
      act: 'user.user_login_act',
      reurl: CHECK_PATH,
      user_id: loginId,
      user_passwd: password,
    },
  });
  const fresh = cookieFrom(res);
  if (fresh) cookie = fresh;

  // 응답 내용만으로는 성공/실패를 가릴 수 없다. 이 사이트는 실패해도 200 을 주고
  // 로그인 페이지를 다시 보여줄 뿐이다. 그래서 실제로 보호된 페이지가 열리는지로 판정한다.
  const probe = await request('GET', CHECK_PATH, { cookie });
  if (isLoginRedirect(probe.html)) {
    const msg = (res.html.match(/alert\(['"]([^'"]{2,80})['"]/) || [])[1];
    return { ok: false, message: msg || '로그인 실패 — 아이디/비밀번호를 확인하세요.' };
  }
  return { ok: true, cookie, firstPage: probe.html };
}

/**
 * 비로그인 상태면 사이트가 본문 없이 meta refresh 로 로그인 페이지를 가리킨다.
 *   <meta http-equiv="refresh" content="0; url=?act=user.user_login&reurl=...">
 */
function isLoginRedirect(html) {
  return /<meta[^>]+http-equiv=["']refresh["'][^>]*act=user\.user_login/i.test(html)
    || (html.length < 600 && /act=user\.user_login/.test(html));
}

/* ── 예약확인 페이지 파싱 ───────────────────────────────────── */
const stripTags = s => s.replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

/**
 * 표에서 "예약완료" 행만 뽑는다.
 * 사이트 표 구조를 단정할 수 없으므로 열 위치가 아니라 내용으로 판단한다
 * — 날짜꼴·시간꼴·금액꼴을 각각 찾아 매핑하고, 나머지는 raw 에 그대로 남긴다.
 */
function parseReservations(html, pageNo) {
  const rows = [];
  for (const m of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const tr = m[0];
    const cells = [...tr.matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map(c => stripTags(c[0]));
    if (cells.length < 3) continue;

    const joined = cells.join(' ');
    if (!/예약\s*완료/.test(joined)) continue;      // 완료 건만

    // 실제 표 한 줄의 생김새 (2026-09 기준):
    //   순번 | 접수번호              | 시설            | 일시                     | 단체 | 인원 | 상태
    //   358  | 20260914090010_5061  | 테니스장 - C코트 | 2026-10-22 (19:00~21:00) | sap  | 5명  | 예약완료
    // 열 위치를 고정하지 않고 내용으로 찾는다. 사이트가 열을 늘려도 버티게 하려는 것이다.
    const date = (joined.match(/(20\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/) || []);
    const useDate = date.length
      ? `${date[1]}-${String(date[2]).padStart(2, '0')}-${String(date[3]).padStart(2, '0')}`
      : null;
    const time = (joined.match(/\d{1,2}:\d{2}\s*(?:~|-|–)\s*\d{1,2}:\d{2}/) || [])[0] || '';
    const amount = (joined.match(/([\d,]{3,})\s*원/) || [])[1];   // 이 표엔 금액 칸이 없다

    // 접수번호는 "20260914090010_5061" 처럼 시각 + 밑줄 + 일련번호다.
    // 링크 파라미터에 실려 있을 수도 있어 그쪽도 함께 본다.
    const fromCell = cells.find(c => /^\d{8,14}_\d{2,8}$/.test(c.replace(/\s/g, '')));
    const fromLink = (tr.match(/(?:rno|rsv_no|reserve_no|reserv_no|idx|seq)=["']?([A-Za-z0-9_-]{4,})/i) || [])[1];
    const fromText = (joined.match(/\b(\d{8,14}_\d{2,8})\b/) || [])[1];
    const no = (fromCell && fromCell.replace(/\s/g, '')) || fromLink || fromText || null;

    // 접수번호를 못 읽어도 행을 버리지 않는다. 중복만 막으면 되므로 지문으로 대신한다.
    const fingerprint = 'X-' + crypto.createHash('sha1')
      .update([useDate, time, cells.join('|')].join('~')).digest('hex').slice(0, 16);

    const people = (joined.match(/(\d+)\s*명/) || [])[1];
    const facility = cells.find(c => /코트|구장|체육|테니스|풋살|농구|배드민턴|수영/.test(c)) || '';
    // 단체명 — 숫자·상태·시설·접수번호가 아닌 짧은 칸
    const team = cells.find(c => c && c !== facility
      && !/^\d/.test(c) && !/예약|취소|대기|완료/.test(c) && !/명$/.test(c) && c.length <= 30) || '';

    rows.push({
      reserve_no: no || fingerprint,
      no_from: no ? 'site' : 'fingerprint',
      facility,
      use_date: useDate,
      use_time: time,
      status: '예약완료',
      amount: amount ? Number(amount.replace(/,/g, '')) : null,
      team,
      people: people ? Number(people) : null,
      page_no: pageNo,
      raw: { cells },
    });
  }
  return rows;
}

/** 페이지네이션 후보 파라미터 — 사이트마다 이름이 달라 순서대로 시도한다 */
const pagePaths = n => [
  `${CHECK_PATH}&page=${n}`,
  `${CHECK_PATH}&cpage=${n}`,
  `${CHECK_PATH}&p=${n}`,
];

/**
 * 페이지 파라미터 이름을 1페이지의 "페이지 이동 링크"에서 찾는다.
 * 본문 아무 데나 있는 page= 를 주워오면 엉뚱한 걸 집을 수 있어,
 * 이 페이지(pcode=check)를 가리키는 링크만 본다.
 */
function detectPageParam(html) {
  const links = [...html.matchAll(/(?:href|onclick)\s*=\s*["'][^"']*pcode=check[^"']*["']/gi)]
    .map(m => m[0]);
  for (const l of links) {
    const hit = l.match(/[?&](page|cpage|pageNo|page_no|p)=(\d+)/i);
    if (hit && Number(hit[2]) > 1) return hit[1];
  }
  const any = html.match(/[?&](page|cpage|pageNo|page_no|p)=\d+/i);
  return any ? any[1] : null;
}

const bodyHash = html => crypto.createHash('sha1')
  .update(html.replace(/\s+/g, ' ')).digest('hex').slice(0, 12);

async function collect(cookie, firstPage) {
  const all = [];
  const diag = [];
  const seen = new Set();          // 같은 쪽을 두 번 읽지 않기 위한 내용 지문
  let pageParam = null;

  for (let n = 1; n <= MAX_PAGE; n++) {
    let res = null;

    if (n === 1) {
      res = firstPage ? { status: 200, html: firstPage } : await request('GET', CHECK_PATH, { cookie });
      pageParam = detectPageParam(res.html);
    } else if (pageParam) {
      res = await request('GET', `${CHECK_PATH}&${pageParam}=${n}`, { cookie });
    } else {
      // 링크에서 못 찾았으면 후보를 시도하되, 1쪽과 내용이 달라야 인정한다.
      // 이 사이트는 파라미터가 틀려도 200 에 1쪽을 그대로 돌려주기 때문이다.
      for (const p of pagePaths(n)) {
        const r = await request('GET', p, { cookie });
        if (r.status === 200 && !seen.has(bodyHash(r.html))) {
          res = r;
          pageParam = p.match(/&(\w+)=\d+$/)[1];
          break;
        }
      }
      if (!res) { diag.push({ page: n, note: '페이지 파라미터를 찾지 못해 중단' }); break; }
    }
    if (!res) break;

    // 도중에 세션이 풀리면 남은 페이지는 의미가 없다
    if (isLoginRedirect(res.html)) {
      diag.push({ page: n, note: '세션이 끊겨 로그인 페이지로 돌아감' });
      break;
    }

    // 앞 쪽과 내용이 같으면 더 넘길 페이지가 없다는 뜻이다
    const h = bodyHash(res.html);
    if (seen.has(h)) {
      diag.push({ page: n, note: '앞 페이지와 같은 내용 — 마지막 페이지로 보고 중단' });
      break;
    }
    seen.add(h);

    const rows = parseReservations(res.html, n);
    all.push(...rows);
    diag.push({ page: n, param: pageParam, bytes: res.html.length, rows: rows.length });

    if (n > 1 && rows.length === 0) break;   // 빈 쪽이면 더 볼 것이 없다
  }
  return { rows: all, diag, pageParam };
}

/* ── 예약 신청 폼 구조 확인 (제출하지 않는다) ─────────────────
 * 자동예약을 서버에서 하려면 신청 폼이 어떤 필드를 요구하는지 알아야 한다.
 * 캘린더에서 빈 칸 하나를 찾아 신청 페이지를 "열어보기만" 한다.
 * POST 를 하지 않으므로 실제 예약은 잡히지 않는다.
 */
async function inspectBookingForm(cookie, { type, year, month }) {
  const calPath = `/?act=reservation.reservation_list&type=${type}&cyear=${year}&cmonth=${month}`;
  const cal = await request('GET', calPath, { cookie });
  if (isLoginRedirect(cal.html)) return { ok: false, message: '세션이 끊겼습니다.' };

  // 예약 가능한 칸은 <a class="_rev" data-date data-time data-type> 로 나온다
  const slots = [...cal.html.matchAll(/<a[^>]*class=["'][^"']*_rev[^"']*["'][^>]*>/gi)]
    .map(tag => ({
      date: (tag[0].match(/data-date=["']([^"']+)/) || [])[1],
      time: (tag[0].match(/data-time=["']([^"']+)/) || [])[1],
      type: (tag[0].match(/data-type=["']([^"']+)/) || [])[1],
    }))
    .filter(s => s.date && s.time);

  if (!slots.length) {
    return { ok: false, message: '이 달에 예약 가능한 칸이 없습니다.', calendarBytes: cal.html.length };
  }

  const first = slots[0];
  const appPath = '/?act=reservation.reservation_application'
    + `&rdate=${first.date}&rtime=${first.time}&rtype=${first.type}&setupCode=`;
  const app = await request('GET', appPath, { cookie });

  const form = (app.html.match(/<form[^>]*>[\s\S]*?<\/form>/i) || [])[0] || '';
  // 이 폼에는 사이트가 미리 채워 둔 이름·연락처·이메일이 들어 있다.
  // 구조를 보는 게 목적이므로 값은 마스킹해서 내보낸다.
  const PII = /user_name|hphone|phone|email|addr/i;
  const inputs = [...form.matchAll(/<(input|select|textarea)[^>]*>/gi)]
    .map(m => {
      const name = (m[0].match(/name=["']([^"']+)/) || [])[1] || null;
      const value = (m[0].match(/value=["']([^"']*)/) || [])[1] || null;
      return {
        tag: m[1],
        name,
        type: (m[0].match(/type=["']([^"']+)/) || [])[1] || null,
        value: name && PII.test(name) ? (value ? '(개인정보 — 가림)' : '') : value,
      };
    })
    .filter(x => x.name);

  return {
    ok: true,
    slots: slots.length,
    sampleSlot: first,
    calendarBytes: cal.html.length,
    appBytes: app.html.length,
    formTag: (form.match(/<form[^>]*>/i) || [''])[0],
    inputs,
    submitHints: [...app.html.matchAll(/(?:onclick|action)=["']([^"']{0,120})["']/gi)]
      .map(m => m[1]).filter(v => /reserv|submit|act=/i.test(v)).slice(0, 8),
  };
}


/* ── 라우팅 ──────────────────────────────────────────────────
 * DB 가 없다. RDS 를 해지한 뒤로 이 모듈은 **아무것도 저장하지 않는다.**
 *
 * 계정·예약내역·체크·단가·설정은 전부 브라우저(localStorage)에 있고,
 * 여기 남은 일은 하나뿐이다 — 예약 사이트에 대신 로그인해서 긁어오는 것.
 * 브라우저가 직접 못 하는 이유는 남의 사이트라 CORS 를 우리가 못 열기 때문이다.
 *
 * 그래서 비밀번호도 보관하지 않는다. 호출할 때마다 브라우저가 들고 온다.
 */

async function route(ctx, event, method, path) {
  const { resp, getBody } = ctx;
  if (!path.startsWith('/tennis/')) return null;

  const body = getBody(event);
  const loginId = String(body.login_id || '').trim();
  const password = String(body.password || '');

  if (method !== 'POST') return resp(405, { error: 'POST 로 부르세요.' });
  if (!loginId || !password) {
    return resp(400, { error: '아이디와 비밀번호가 필요합니다.' });
  }

  /* 예약완료 내역 수집 — 긁어서 돌려주기만 한다 */
  if (path === '/tennis/sync') {
    let session;
    try {
      session = await login(loginId, password);
    } catch (e) {
      return resp(200, { ok: false, login_id: loginId, message: '접속 실패: ' + e.message });
    }
    if (!session.ok) return resp(200, { ok: false, login_id: loginId, message: session.message });

    let result;
    try {
      result = await collect(session.cookie, session.firstPage);
    } catch (e) {
      return resp(200, { ok: false, login_id: loginId, message: '수집 실패: ' + e.message });
    }

    // 사이트 접수번호를 못 읽어 지문으로 대신한 건수. 버리지는 않는다.
    const noNumber = result.rows.filter(r => r.no_from === 'fingerprint').length;
    const out = {
      ok: true,
      login_id: loginId,
      found: result.rows.length,
      skipped: noNumber,
      message: '예약완료 ' + result.rows.length + '건',
      rows: result.rows,          // ← 저장은 브라우저가 한다
      diag: result.diag,
    };
    if (body.debug === true) {
      out.sample = result.rows.slice(0, 3).map(r => ({
        reserve_no: r.reserve_no, no_from: r.no_from, use_date: r.use_date,
        use_time: r.use_time, facility: r.facility, amount: r.amount, cells: r.raw.cells,
      }));
    }
    return resp(200, out);
  }

  /* 예약 신청 폼 구조 확인 — 조회만 하고 제출은 하지 않는다 */
  if (path === '/tennis/inspect') {
    const session = await login(loginId, password);
    if (!session.ok) return resp(200, { ok: false, message: session.message });

    const now = new Date();
    return resp(200, await inspectBookingForm(session.cookie, {
      type: body.type || 8,
      year: body.year || now.getFullYear(),
      month: body.month || (now.getMonth() + 2),   // 보통 다음 달이 열려 있다
    }));
  }

  return resp(404, { error: 'Not found' });
}

module.exports = { route };
