document.addEventListener('DOMContentLoaded', () => {

  const PREF_KEY = 'resv_prefs'; // 이전 입력값 저장 키

  // ── 이전 입력값 저장 / 불러오기 ──────────────────────────────
  function savePrefs(cfg) {
    const prefs = {
      maxcnt:    cfg.maxcnt,
      personnel: cfg.personnel,
      team:      cfg.team,
      type:      cfg.type,
      courts:    cfg.courts,
      times:     cfg.times,
      weeks:     cfg.weeks,
      user_id:   cfg.user_id,
      user_pw:   cfg.user_pw,
      delay:     cfg.delay,
    };
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  }

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || null; }
    catch { return null; }
  }

  function applyPrefs(prefs) {
    if (!prefs) return;

    // 예약건수
    if (prefs.maxcnt != null)
      document.getElementById('maxcnt').value = prefs.maxcnt;

    // 인원수
    if (prefs.personnel != null)
      document.getElementById('personnel').value = prefs.personnel;

    // 팀명
    if (prefs.team != null)
      document.getElementById('team').value = prefs.team;

    // 종목 (라디오)
    if (Array.isArray(prefs.courts) && prefs.courts.length) {
      document.querySelectorAll('input[name="court"]').forEach(cb => {
        cb.checked = prefs.courts.includes(parseInt(cb.value));
      });
    }
    if (prefs.type != null) {
      const radio = document.querySelector(`input[name="type"][value="${prefs.type}"]`);
      if (radio) radio.checked = true;
    }

    // 시간 체크박스
    if (Array.isArray(prefs.times)) {
      document.querySelectorAll('input[name="time"]').forEach(cb => {
        cb.checked = prefs.times.includes(cb.value);
      });
    }

    // 요일 체크박스
    if (Array.isArray(prefs.weeks)) {
      document.querySelectorAll('input[name="week"]').forEach(cb => {
        cb.checked = prefs.weeks.includes(parseInt(cb.value));
      });
    }

    // 딜레이
    if (prefs.delay != null)
      document.getElementById('delay').value = prefs.delay;

    // 로그인 정보
    if (prefs.user_id) document.getElementById('user-id').value = prefs.user_id;
    if (prefs.user_pw) document.getElementById('user-pw').value = prefs.user_pw;
  }

  // ── 년월 기본값: 다음 달 (12월 → 1월 연도 올림) ───────────────
  const now = new Date();
  let defYear  = now.getFullYear();
  let defMonth = now.getMonth() + 2; // getMonth()는 0-based이므로 +1이 현재월, +2가 다음달
  if (defMonth > 12) { defMonth = 1; defYear += 1; }
  document.getElementById('year').value  = defYear;
  document.getElementById('month').value = String(defMonth).padStart(2, '0');

  // ── 이전 입력값 복원 ─────────────────────────────────────────
  applyPrefs(loadPrefs());

  // ── 테니스일 때만 코트 선택 노출 ─────────────────────────────
  const TENNIS_TYPES = [8, 9, 10];
  function syncCourtCard() {
    const card = document.getElementById('court-card');
    if (!card) return;
    const el = document.querySelector('input[name="type"]:checked');
    const isTennis = TENNIS_TYPES.includes(parseInt(el ? el.value : '8'));
    card.style.display = isTennis ? '' : 'none';
  }
  document.querySelectorAll('input[name="type"]').forEach(r =>
    r.addEventListener('change', syncCourtCard));
  syncCourtCard();

  // ── 익스텐션 ID 감지 ─────────────────────────────────────────
  let detectedExtId = null;

  // downloads/ 에 올려둔 익스텐션 버전. 새로 배포할 때 manifest.json 과 함께 올린다.
  const LATEST_EXT_VERSION = '3.2';
  let detectedExtVersion = null;

  function detectExtension() {
    const id = document.documentElement.dataset.extId;
    detectedExtVersion = document.documentElement.dataset.extVersion || null;
    if (id) {
      detectedExtId = id;
      localStorage.setItem('ext_id', id);
      updateExtStatus(true);
    } else {
      const saved = localStorage.getItem('ext_id');
      if (saved) { detectedExtId = saved; updateExtStatus(true); }
      else { updateExtStatus(false); }
    }
  }

  function updateExtStatus(connected) {
    const badge = document.getElementById('ext-status');
    if (!badge) return;
    if (!connected) {
      badge.textContent = '⚠ 익스텐션 미연결 — 초기 설정 탭을 먼저 완료하세요';
      badge.className = 'ext-badge disconnected';
      return;
    }
    // 구버전이 깔려 있으면 다시 받으라고 알려준다 (버전은 익스텐션이 DOM 에 심는다)
    if (detectedExtVersion && detectedExtVersion !== LATEST_EXT_VERSION) {
      badge.textContent = `⚠ 익스텐션 연결됨 (설치 ${detectedExtVersion} · 최신 ${LATEST_EXT_VERSION}) — 초기 설정 탭에서 파일을 다시 받아 주세요`;
      badge.className = 'ext-badge disconnected';
    } else {
      badge.textContent = detectedExtVersion
        ? `✓ 익스텐션 연결됨 (v${detectedExtVersion})`
        : '✓ 익스텐션 연결됨';
      badge.className = 'ext-badge connected';
    }
  }

  setTimeout(detectExtension, 300);

  // ── 탭 전환 ──────────────────────────────────────────────────
  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.tab === tabName));
    document.querySelectorAll('.tab-panel').forEach(panel =>
      panel.classList.toggle('active', panel.id === 'tab-' + tabName));
    // 예약내역은 표라서 넓은 화면을 쓴다. CSS 의 :has() 를 모르는
    // 브라우저에서도 동작하도록 body 에 표시를 붙여 둔다.
    const panel = document.getElementById('tab-' + tabName);
    document.body.classList.toggle('wide-tab', !!(panel && panel.classList.contains('wide')));
  }
  document.querySelectorAll('[data-tab]').forEach(el =>
    el.addEventListener('click', () => switchTab(el.dataset.tab)));

  // ── 복사 버튼 ─────────────────────────────────────────────────
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy).then(() => {
        btn.textContent = '복사됨!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '복사'; btn.classList.remove('copied'); }, 2000);
      });
    });
  });

  // ── 예약 실행 폼 ──────────────────────────────────────────────
  const form      = document.getElementById('resv-form');
  const errorMsg  = document.getElementById('error-msg');
  const runResult = document.getElementById('run-result');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorMsg.classList.add('hidden');
    runResult.classList.add('hidden');

    // 요일
    const weeks = Array.from(document.querySelectorAll('input[name="week"]:checked'))
      .map(cb => parseInt(cb.value));
    if (weeks.length === 0) { showError('요일을 1개 이상 선택해주세요.'); return; }

    // 시간
    const times = Array.from(document.querySelectorAll('input[name="time"]:checked'))
      .map(cb => cb.value);
    if (times.length === 0) { showError('시간을 1개 이상 선택해주세요.'); return; }
    times.sort((a, b) => b - a);

    // 년월
    const year  = document.getElementById('year').value.trim();
    const month = document.getElementById('month').value.trim().padStart(2, '0');
    if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) {
      showError('년도(4자리)와 월(2자리)을 올바르게 입력해주세요.'); return;
    }

    const typeEl    = document.querySelector('input[name="type"]:checked');
    const type      = parseInt(typeEl ? typeEl.value : '8');

    // 테니스 코트 (A/B/C). 테니스 캘린더 한 장에 세 코트가 모두 나오므로
    // 여기서 고른 코트만 예약 대상으로 삼는다. 축구장·풋살은 코트 구분이 없다.
    const isTennis  = TENNIS_TYPES.includes(type);
    const courts    = isTennis
      ? Array.from(document.querySelectorAll('input[name="court"]:checked')).map(cb => parseInt(cb.value))
      : [type];
    if (isTennis && courts.length === 0) {
      showError('테니스 코트를 1개 이상 선택해주세요.'); return;
    }
    const maxcnt    = parseInt(document.getElementById('maxcnt').value || '120');
    const team      = document.getElementById('team').value.trim() || 'ERP';
    const personnel = document.getElementById('personnel').value || '5';
    const delay     = parseInt(document.getElementById('delay').value || '100');
    const user_id   = document.getElementById('user-id').value.trim();
    const user_pw   = document.getElementById('user-pw').value;

    if (!user_id || !user_pw) {
      showError('아이디와 비밀번호를 입력해주세요.'); return;
    }

    const config = { times, weeks, year, month, type, courts, maxcnt, team, personnel, delay, user_id, user_pw };

    // 익스텐션으로 config 전송
    const extId = detectedExtId || localStorage.getItem('ext_id');
    if (!extId) {
      showError('익스텐션이 연결되지 않았습니다. 초기 설정 탭에서 익스텐션을 먼저 설치하세요.');
      return;
    }

    try {
      await sendToExtension(extId, config);

      // 전송 성공 → 이전 입력값 저장
      savePrefs(config);

      // 로그인 페이지로 먼저 이동 → 익스텐션이 자동 로그인 후 캘린더로 리다이렉트
      const loginUrl = 'https://www.xn--vk1b79znxd34c61h.kr/?act=user.user_login'
        + '&reurl=%2F%3Fact%3Dreservation.reservation_list';
      window.open(loginUrl, '_blank');
      showResult(config);
    } catch (err) {
      showError('익스텐션 연결에 실패했습니다. 익스텐션이 활성화 상태인지 확인하세요.\n(오류: ' + err.message + ')');
    }
  });

  function sendToExtension(extId, config) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(extId, { type: 'setConfig', config }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (response && response.success) resolve();
          else reject(new Error('익스텐션 응답 없음'));
        });
      } catch (err) { reject(err); }
    });
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
  }

  function showResult(cfg) {
    const dayNames   = ['일', '월', '화', '수', '목', '금', '토'];
    const timeNames  = { '3': '오후 1시', '4': '오후 3시', '5': '오후 5시', '6': '오후 7시' };
    const sportNames = { 7: '축구장', 8: '테니스', 11: '풋살' };
    const courtNames = { 8: 'A', 9: 'B', 10: 'C' };
    const courtLabel = TENNIS_TYPES.includes(cfg.type) && Array.isArray(cfg.courts)
      ? ` (${cfg.courts.map(c => courtNames[c]).filter(Boolean).join('·')}코트)` : '';
    runResult.innerHTML = `
      <div class="result-ok">✓ 설정값이 익스텐션에 전달되었습니다. 새 창에서 예약이 시작됩니다.</div>
      <div class="result-summary">
        <span>${cfg.year}년 ${cfg.month}월</span>
        <span>${sportNames[cfg.type]}${courtLabel}</span>
        <span>${cfg.weeks.map(d => dayNames[d]).join('·')}</span>
        <span>${cfg.times.map(t => timeNames[t]).join('·')}</span>
        <span>최대 ${cfg.maxcnt}건</span>
        <span>${cfg.team} / ${cfg.personnel}명</span>
        <span>딜레이 ${cfg.delay}ms</span>
      </div>`;
    runResult.classList.remove('hidden');
  }
});
