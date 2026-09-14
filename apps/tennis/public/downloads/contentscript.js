/*
  대치유수지 예약 자동화 — 예약 사이트에서만 실행된다 (manifest matches 참고).

  [v3.1 변경점]
  - 동작 상태를 콘솔에 남긴다. 설정이 없어서 안 도는 건지, 돌다가 막힌 건지 구분이 안 됐다.
  - 무한 새로고침 방지: 예약 칸이 안 보일 때 재시도 횟수를 제한한다.
  - localStorage.clear() 대신 이 스크립트가 쓰는 키만 지운다 (사이트의 다른 값 보존).
  - http→https 교정 코드 제거. MutationObserver 콜백은 파서가 요청을 이미 보낸 뒤에
    실행돼서 Mixed Content 차단을 막지 못한다. 게다가 이 사이트에서 http 로 걸린 건
    폰트 CSS 하나뿐이고, 그 오류는 익스텐션 없이도 똑같이 난다(사이트 자체 문제).
  - 익스텐션 ID 주입은 런처 페이지에서만 하고, 예약 사이트가 아니면 자동화는 돌지 않는다.

  [v3.2 변경점]
  - 테니스 코트(A/B/C) 선택 지원. 테니스 캘린더 한 장에 세 코트가 모두 나오는데
    지금까지는 코트를 안 가려서 아무 코트나 잡혔다. 이제 런처에서 고른 코트만 예약한다.
    (courts 가 없는 예전 설정은 전부 허용해 기존 동작을 유지한다)
*/

const SITE = 'xn--vk1b79znxd34c61h.kr';
const LOG = '[대치예약]';

// ── 런처 페이지(Amplify · localhost)에서는 익스텐션 ID만 심고 끝낸다 ──
// 런처가 chrome.runtime.sendMessage(extId, ...) 를 쓰려면 ID를 알아야 한다.
// 예약 사이트가 아니면 자동화 로직은 실행하지 않는다.
if (!window.location.hostname.endsWith(SITE)) {
  document.documentElement.dataset.extId = chrome.runtime.id;
  document.documentElement.dataset.extVersion = chrome.runtime.getManifest().version;
} else {
const KEYS = ['cachedJsonArray', 'count'];        // 이 스크립트가 localStorage 에 쓰는 키
const MAX_RELOAD = 20;                            // 예약 칸이 안 보일 때 최대 재시도
const RELOAD_KEY = 'dc_reload_tries';

const clearOwnKeys = () => KEYS.forEach(k => localStorage.removeItem(k));

const c_type_order = {
  10: 3, // 테니스 c코트
  8:  1, // 테니스 a코트
  9:  2, // 테니스 b코트
  7:  4, // 축구장
  11: 5  // 풋살장
};

function getRandomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// chrome.storage에서 config 읽은 후 전체 로직 실행
chrome.storage.local.get('ext_config', (result) => {
  if (chrome.runtime.lastError) {
    console.error(LOG, 'storage 읽기 실패:', chrome.runtime.lastError.message);
    return;
  }
  if (!result.ext_config) {
    // 예전에는 아무 말 없이 끝나서 "익스텐션이 고장났다"고 오해하기 쉬웠다.
    console.warn(LOG, '설정(ext_config)이 없어 대기합니다. 웹 런처에서 [실행하기]를 눌러 설정을 보내세요.');
    return;
  }
  const _cfg = result.ext_config;

  const c_times     = _cfg.times;
  const c_weeks     = _cfg.weeks;
  const c_year      = _cfg.year;
  const c_month     = _cfg.month;
  const c_type      = _cfg.type;
  const c_maxcnt    = _cfg.maxcnt;
  const c_team      = _cfg.team;
  const c_personnel = _cfg.personnel;
  const c_user_id   = _cfg.user_id   || '';
  const c_user_pw   = _cfg.user_pw   || '';
  const c_rev_delay = _cfg.delay != null ? _cfg.delay : 100;
  // 테니스 캘린더 한 장에 A(8)·B(9)·C(10) 코트가 모두 나오므로 고른 코트만 남긴다.
  // 예전 런처가 보낸 설정에는 courts 가 없다 → 그때는 전부 허용(기존 동작 유지).
  const c_courts = Array.isArray(_cfg.courts) && _cfg.courts.length
    ? _cfg.courts.map(Number) : null;

  // HTTP/HTTPS 자동 대응 (사이트가 https로 바뀌어도 정상 동작)
  const BASE = window.location.origin; // 예: https://www.xn--vk1b79znxd34c61h.kr

  const c_calenderUrl = BASE + '/?act=reservation.reservation_list'
    + '&type=' + c_type + '&cyear=' + c_year + '&cmonth=' + c_month;

  console.info(LOG, '설정 적용됨 —',
    { 종목: c_type, 코트: c_courts || '전체', 연월: `${c_year}-${c_month}`,
      요일: c_weeks, 시간: c_times, 최대: c_maxcnt });

  function resvOpen() {
    const cachedJsonArray = localStorage.getItem('cachedJsonArray');
    if (cachedJsonArray !== null && cachedJsonArray !== '[]') {
      const jsonArray = JSON.parse(cachedJsonArray);
      const item = jsonArray.splice(0, 1)[0];
      localStorage.setItem('cachedJsonArray', JSON.stringify(jsonArray));

      const { date, time, type } = item;
      const url = BASE + '/?act=reservation.reservation_application'
        + '&rdate=' + date
        + '&rtime=' + time
        + '&rtype=' + type
        + '&setupCode=';

      const count = (parseInt(localStorage.getItem('count')) || 0);
      if (count < c_maxcnt) {
        localStorage.setItem('count', count + 1);
        console.info(LOG, `예약 창 열기 (${count + 1}/${c_maxcnt})`, { date, time, type });
        window.open(url);
      } else {
        console.info(LOG, `최대 건수(${c_maxcnt})에 도달해 더 열지 않습니다.`);
      }
    }
  }

  function main() {
  const href = window.location.href;

  /////////////////////////////////////////////////////////////////////
  // page_login. 로그인 페이지 → 자동 입력 후 제출
  if (href.indexOf(SITE + '/?act=user.user_login') !== -1) {
    if (!c_user_id || !c_user_pw) {
      console.warn(LOG, '로그인 페이지인데 아이디/비밀번호 설정이 비어 있습니다.');
      return;
    }
    setTimeout(() => {
      const idField = document.getElementById('userId');
      const pwField = document.getElementById('userPasswd');
      const btn     = document.getElementById('user_login');
      if (idField && pwField && btn) {
        idField.value = c_user_id;
        pwField.value = c_user_pw;
        btn.click(); // 클릭 후 서버가 reurl로 리다이렉트 → page0이 이어서 처리
      } else {
        console.warn(LOG, '로그인 입력칸을 찾지 못했습니다. 사이트 구조가 바뀌었을 수 있습니다.');
      }
    }, 500);
  }

  /////////////////////////////////////////////////////////////////////
  // page0. 원하는 종목&월 캘린더가 아닌 경우 → 올바른 캘린더로 이동
  else if (href.indexOf(SITE + '/?act=reservation.reservation_list') !== -1
    && href.indexOf(c_calenderUrl) === -1) {
    clearOwnKeys();
    sessionStorage.removeItem(RELOAD_KEY);
    console.info(LOG, '목표 캘린더로 이동합니다:', c_calenderUrl);
    window.location.href = c_calenderUrl;
  }

  /////////////////////////////////////////////////////////////////////
  // page1. 예약 캘린더 화면
  else if (href.indexOf(c_calenderUrl) !== -1) {
    clearOwnKeys();

    const rev_elements = document.querySelectorAll('a._rev[data-date]');

    // 예약 가능 목록이 아직 없으면 새로고침으로 재시도 (횟수 제한 — 무한 반복 방지)
    if (rev_elements.length === 0) {
      const tries = (parseInt(sessionStorage.getItem(RELOAD_KEY)) || 0) + 1;
      if (tries > MAX_RELOAD) {
        console.error(LOG, `예약 칸을 ${MAX_RELOAD}번 시도해도 찾지 못했습니다. 로그인 상태나 종목/월 설정을 확인하세요.`);
        return;
      }
      sessionStorage.setItem(RELOAD_KEY, tries);
      console.warn(LOG, `예약 칸이 없어 새로고침 (${tries}/${MAX_RELOAD})`);
      setTimeout(() => location.reload(), getRandomBetween(300, 700));
      return;
    }
    sessionStorage.removeItem(RELOAD_KEY);

    // 요일 & 시간 필터
    const filtered = Array.from(rev_elements).map(el => {
      const date = el.getAttribute('data-date');
      const time = el.getAttribute('data-time');
      const type = el.getAttribute('data-type');
      if (c_courts && !c_courts.includes(Number(type))) return null;
      if (c_weeks.includes((new Date(date)).getDay()) && c_times.includes(time)) {
        return { date, time, type };
      }
      return null;
    }).filter(Boolean);

    // 정렬: 늦은시간 → 코트순서 → 뒷날짜 순
    filtered.sort((a, b) => {
      if (b.time - a.time !== 0) return b.time - a.time;
      const tc = c_type_order[a.type] - c_type_order[b.type];
      if (tc !== 0) return tc;
      return new Date(b.date) - new Date(a.date);
    });

    // 중복 제거
    const unique = Array.from(new Set(filtered.map(JSON.stringify))).map(JSON.parse);
    console.info(LOG, `예약 가능 ${rev_elements.length}칸 중 조건에 맞는 ${unique.length}건`);
    if (unique.length === 0) {
      console.warn(LOG, '조건(요일·시간)에 맞는 칸이 없습니다. 설정을 확인하세요.');
    }
    localStorage.setItem('cachedJsonArray', JSON.stringify(unique));
    resvOpen();
  }

  /////////////////////////////////////////////////////////////////////
  // page2. 예약 정보 상세 입력 팝업
  else if (href.indexOf(SITE + '/?act=reservation.reservation_application') !== -1) {
    setTimeout(() => {
      try {
        sessionStorage.setItem('popupId', href);
        document.querySelector('input[name="reserv_app_company"]').value = c_team;
        document.querySelector('input[name="reserv_app_use_num"]').value = c_personnel;
        document.querySelector('.btn_confirm button').click();
      } catch (e) {
        console.warn(LOG, '예약 입력칸을 채우지 못했습니다:', e.message);
      } finally {
        if (sessionStorage.getItem('subPopup') === null) {
          resvOpen();
        }
      }
    }, c_rev_delay);
  }

  /////////////////////////////////////////////////////////////////////
  // page3. 예약 신청 결과 (루트 페이지)
  else if (href.replace(/^https?:\/\//, '') === 'www.' + SITE + '/') {
    const random_value = getRandomBetween(80, 110);
    const element = document.getElementById('__dlgAlert__');
    if (element !== null) {
      setTimeout(() => {
        sessionStorage.setItem('subPopup', true);
        window.location.href = sessionStorage.getItem('popupId');
      }, random_value);
    }
  }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
});
}
