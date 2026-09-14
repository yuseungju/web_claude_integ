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
const MAX_PAGE = 4;

/* ── 비밀번호 암호화 ────────────────────────────────────────────
 * 예약 사이트 비밀번호는 우리가 대신 로그인해야 해서 되돌릴 수 있어야 한다.
 * 그래서 해시가 아니라 AES-256-GCM 으로 암호화해 둔다.
 * 키는 ACCOUNT_ENC_KEY 를 쓰고, 없으면 JWT_SECRET 에서 파생한다
 * (이 경우 JWT_SECRET 을 바꾸면 저장된 비밀번호를 못 읽으니 주의).
 */
function encKey() {
  const raw = process.env.ACCOUNT_ENC_KEY || process.env.JWT_SECRET;
  if (!raw) throw new Error('ACCOUNT_ENC_KEY 또는 JWT_SECRET 이 필요합니다.');
  return crypto.createHash('sha256').update('tn-account:' + raw).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const out = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), out.toString('base64')].join(':');
}

function decrypt(stored) {
  const [iv, tag, data] = String(stored).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

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

    const date = (joined.match(/(20\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/) || []);
    const useDate = date.length
      ? `${date[1]}-${String(date[2]).padStart(2, '0')}-${String(date[3]).padStart(2, '0')}`
      : null;
    const time = (joined.match(/\d{1,2}:\d{2}\s*(?:~|-|–)\s*\d{1,2}:\d{2}/) || [])[0] || '';
    const amount = (joined.match(/([\d,]{3,})\s*원/) || [])[1];
    // 예약번호로 볼 만한 것: 6자리 이상 숫자 또는 영문+숫자 조합
    // 예약번호는 사이트마다 형태가 달라 여러 갈래로 찾는다.
    //   1) 링크·onclick 파라미터에 실린 번호 (가장 확실하다)
    //   2) 칸 하나가 통째로 숫자/영문+숫자인 경우
    //   3) 본문 어디든 6자리 이상 숫자
    // 그래도 못 찾으면 계정·날짜·시간·시설로 만든 지문을 대신 쓴다.
    // 예전에는 여기서 포기하고 행을 통째로 버려서 "예약번호를 못 읽은 N건 제외"가 났다.
    const fromLink = (tr.match(/(?:rno|rsv_no|reserve_no|reserv_no|idx|seq|no)=["']?([A-Za-z0-9_-]{4,})/i) || [])[1];
    const fromCell = cells.find(c => /^[A-Za-z]{0,4}[-]?\d{4,}$/.test(c.replace(/\s/g, '')));
    const fromText = (joined.match(/\b([A-Z]{0,3}\d{6,})\b/) || [])[1];
    const no = fromLink || (fromCell && fromCell.replace(/\s/g, '')) || fromText || null;

    // 번호가 없어도 같은 예약을 두 번 저장하지 않도록 지문을 만든다
    const fingerprint = 'X-' + crypto.createHash('sha1')
      .update([useDate, time, cells.join('|')].join('~')).digest('hex').slice(0, 16);

    rows.push({
      reserve_no: no || fingerprint,
      no_from: no ? 'site' : 'fingerprint',
      facility: cells.find(c => /코트|구장|체육|테니스|풋살|농구|배드민턴/.test(c)) || cells[1] || '',
      use_date: useDate,
      use_time: time,
      status: '예약완료',
      amount: amount ? Number(amount.replace(/,/g, '')) : null,
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

async function collect(cookie, firstPage) {
  const all = [];
  const diag = [];
  let pageParam = null;

  for (let n = 1; n <= MAX_PAGE; n++) {
    let res = null;
    if (n === 1) {
      res = firstPage ? { status: 200, html: firstPage } : await request('GET', CHECK_PATH, { cookie });
    } else if (pageParam) {
      res = await request('GET', `${CHECK_PATH}&${pageParam}=${n}`, { cookie });
    } else {
      // 1페이지에서 파라미터 이름을 못 찾았으면 후보를 한 번씩 시도
      for (const p of pagePaths(n)) {
        const r = await request('GET', p, { cookie });
        if (r.status === 200) { res = r; pageParam = p.match(/&(\w+)=\d+$/)[1]; break; }
      }
    }
    if (!res) break;

    // 도중에 세션이 풀리면 남은 페이지는 의미가 없다
    if (isLoginRedirect(res.html)) {
      diag.push({ page: n, note: '세션이 끊겨 로그인 페이지로 돌아감' });
      break;
    }

    // 1페이지에서 실제 페이지 파라미터 이름을 찾아 둔다
    if (n === 1 && !pageParam) {
      const hit = res.html.match(/[?&](page|cpage|p)=\d+/i);
      if (hit) pageParam = hit[1];
    }

    const rows = parseReservations(res.html, n);
    all.push(...rows);
    diag.push({ page: n, bytes: res.html.length, rows: rows.length });

    // 더 이상 페이지가 없으면 멈춘다
    if (n > 1 && rows.length === 0) break;
  }
  return { rows: all, diag, pageParam };
}

/* ── 라우팅 ────────────────────────────────────────────────── */
async function route(ctx, event, method, path) {
  const { pool, resp, getBody, verifyToken } = ctx;
  if (!path.startsWith('/tennis/')) return null;

  const user = verifyToken(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const uid = user.id;
  const body = getBody(event);

  /* 계정 목록 — 비밀번호는 내려보내지 않는다 */
  if (path === '/tennis/accounts' && method === 'GET') {
    const { rows } = await pool.query(
      `SELECT a.id, a.login_id, a.label, a.is_active, a.last_sync_at, a.last_sync_status,
              (SELECT count(*)::int FROM tn_reservations r WHERE r.account_id = a.id) AS reservations
         FROM tn_accounts a WHERE a.user_id = $1 ORDER BY a.id`, [uid]);
    return resp(200, { accounts: rows });
  }

  /* 계정 추가 / 비밀번호 변경 */
  if (path === '/tennis/accounts' && method === 'POST') {
    const loginId = (body.login_id || '').trim();
    const password = body.password || '';
    const label = (body.label || '').trim();
    if (!loginId || !password) return resp(400, { error: '아이디와 비밀번호를 입력하세요.' });

    const { rows } = await pool.query(
      `INSERT INTO tn_accounts (user_id, login_id, password_enc, label)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, login_id)
       DO UPDATE SET password_enc = EXCLUDED.password_enc,
                     label = EXCLUDED.label,
                     updated_at = NOW()
         RETURNING id, login_id, label, is_active`,
      [uid, loginId, encrypt(password), label]);
    return resp(200, { account: rows[0] });
  }

  const acctM = path.match(/^\/tennis\/accounts\/(\d+)$/);
  if (acctM && method === 'DELETE') {
    const r = await pool.query('DELETE FROM tn_accounts WHERE id=$1 AND user_id=$2', [acctM[1], uid]);
    if (!r.rowCount) return resp(404, { error: '계정을 찾을 수 없습니다.' });
    return resp(200, { ok: true });
  }
  if (acctM && method === 'PUT') {
    const r = await pool.query(
      'UPDATE tn_accounts SET is_active=$1, label=COALESCE($2,label), updated_at=NOW() WHERE id=$3 AND user_id=$4',
      [body.is_active !== false, body.label ?? null, acctM[1], uid]);
    if (!r.rowCount) return resp(404, { error: '계정을 찾을 수 없습니다.' });
    return resp(200, { ok: true });
  }

  /* 한 계정 수집 — 로그인 → 1~4페이지 → 예약완료만 저장 */
  if (path === '/tennis/sync' && method === 'POST') {
    const accountId = body.account_id;
    const debug = body.debug === true;
    if (!accountId) return resp(400, { error: 'account_id 가 필요합니다.' });

    const { rows: accs } = await pool.query(
      'SELECT id, login_id, password_enc FROM tn_accounts WHERE id=$1 AND user_id=$2', [accountId, uid]);
    if (!accs.length) return resp(404, { error: '계정을 찾을 수 없습니다.' });
    const acc = accs[0];

    const fail = async msg => {
      await pool.query('UPDATE tn_accounts SET last_sync_at=NOW(), last_sync_status=$1 WHERE id=$2', [msg, acc.id]);
      return resp(200, { ok: false, login_id: acc.login_id, message: msg });
    };

    let session;
    try {
      session = await login(acc.login_id, decrypt(acc.password_enc));
    } catch (e) {
      return fail('접속 실패: ' + e.message);
    }
    if (!session.ok) return fail(session.message);

    let result;
    try {
      result = await collect(session.cookie, session.firstPage);
    } catch (e) {
      return fail('수집 실패: ' + e.message);
    }

    let saved = 0;
    for (const r of result.rows) {
      const q = await pool.query(
        `INSERT INTO tn_reservations
           (user_id, account_id, reserve_no, facility, use_date, use_time, status, amount, page_no, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (account_id, reserve_no) DO UPDATE
           SET facility=EXCLUDED.facility, use_date=EXCLUDED.use_date, use_time=EXCLUDED.use_time,
               status=EXCLUDED.status, amount=EXCLUDED.amount, raw=EXCLUDED.raw, collected_at=NOW()
         RETURNING (xmax = 0) AS inserted`,
        [uid, acc.id, r.reserve_no, r.facility, r.use_date, r.use_time, r.status, r.amount, r.page_no, r.raw]);
      if (q.rows[0].inserted) saved++;
    }

    // 사이트 예약번호를 못 읽어 지문으로 저장한 건수. 버리지는 않는다.
    const noNumber = result.rows.filter(r => r.no_from === 'fingerprint').length;
    const status = `예약완료 ${result.rows.length}건 · 신규 ${saved}건`;
    await pool.query('UPDATE tn_accounts SET last_sync_at=NOW(), last_sync_status=$1 WHERE id=$2', [status, acc.id]);

    const out = {
      ok: true, login_id: acc.login_id, found: result.rows.length,
      saved, skipped: noNumber, message: status, diag: result.diag,
    };
    // 파싱이 어긋났을 때 구조를 보려면 debug:true 로 부른다 (앞 3행만)
    if (debug) out.sample = result.rows.slice(0, 3).map(r => ({
      reserve_no: r.reserve_no, no_from: r.no_from, use_date: r.use_date,
      use_time: r.use_time, facility: r.facility, amount: r.amount, cells: r.raw.cells,
    }));
    return resp(200, out);
  }

  /* 모든 계정의 예약완료 내역 취합 */
  if (path === '/tennis/reservations' && method === 'GET') {
    const { rows } = await pool.query(
      `SELECT r.id, r.reserve_no, r.facility, r.use_date, r.use_time, r.status, r.amount,
              r.collected_at, a.login_id, a.label
         FROM tn_reservations r
         JOIN tn_accounts a ON a.id = r.account_id
        WHERE r.user_id = $1
        ORDER BY r.use_date DESC NULLS LAST, r.id DESC
        LIMIT 2000`, [uid]);
    return resp(200, { reservations: rows, total: rows.length });
  }

  return null;
}

module.exports = { route };
