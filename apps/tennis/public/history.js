/**
 * 예약내역 탭 — 대치유수지 예약 사이트 계정 목록과 예약완료 내역.
 *
 * 이 웹의 로그인과는 아무 상관이 없다. 브라우저가 한 번 발급한 기기 키로
 * 목록을 구분한다(포켓몬 보관함과 같은 방식). 여기 등록하는 건 오로지
 * 대치유수지 사이트에 자동 로그인할 계정이다. 여러 개 등록할 수 있다.
 *
 * 서버(lambda/tennis.js)가 계정마다 직접 로그인해서 긁어오므로
 * 이 화면은 목록을 보여주고 수집을 시작시키는 역할만 한다.
 */
(function () {
  'use strict';

  var API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';
  var LS_KEY = 'tennis.deviceKey.v1';

  var $ = function (id) { return document.getElementById(id); };

  /** 이 브라우저의 기기 키 — 없으면 만들어 저장한다 */
  function deviceKey() {
    var k = '';
    try { k = localStorage.getItem(LS_KEY) || ''; } catch (e) { /* 저장이 막힌 환경 */ }
    if (!/^[A-Za-z0-9-]{8,64}$/.test(k)) {
      k = (crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(LS_KEY, k); } catch (e) { /* 이번 세션만 유지된다 */ }
    }
    return k;
  }

  function api(path, opts) {
    opts = opts || {};
    var body = opts.body || {};
    var url = API + path;
    if (!opts.method || opts.method === 'GET' || opts.method === 'DELETE') {
      url += (path.indexOf('?') < 0 ? '?' : '&') + 'key=' + encodeURIComponent(deviceKey());
    } else {
      body.key = deviceKey();
    }
    return fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: (opts.method && opts.method !== 'GET') ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('요청 실패 (' + res.status + ')'));
        return data;
      });
    });
  }

  // 다크 배경이라 성공/실패 색을 밝은 쪽으로 잡는다
  function msg(el, text, isError) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    el.style.color = isError ? '#f85149' : '#3fb950';
  }

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  /* ── 계정 ─────────────────────────────────────────────── */
  function loadAccounts() {
    return api('/tennis/accounts').then(function (d) { renderAccounts(d.accounts || []); })
      .catch(function (e) { msg($('acc-msg'), e.message, true); });
  }

  function renderAccounts(list) {
    var box = $('acc-list');
    var cnt = $('acc-count');
    if (cnt) cnt.textContent = list.length ? '(' + list.length + '개)' : '';
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<p class="resv-empty">등록된 계정이 없습니다. 위에서 추가하세요.</p>';
      return;
    }
    box.innerHTML = list.map(function (a) {
      var sync = a.last_sync_at
        ? new Date(a.last_sync_at).toLocaleString('ko-KR',
            { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '아직 없음';
      return '<div class="acc-row" data-id="' + a.id + '">' +
        '<div class="acc-main">' +
          '<strong>' + esc(a.login_id) + '</strong>' +
          (a.label ? '<span class="acc-tag">' + esc(a.label) + '</span>' : '') +
        '</div>' +
        '<div class="acc-actions">' +
          '<button type="button" class="acc-sync">수집</button>' +
          '<button type="button" class="acc-del">삭제</button>' +
        '</div>' +
        '<div class="acc-meta">' +
          '예약 ' + (a.reservations || 0) + '건 · 최근 수집 ' + esc(sync) +
          (a.last_sync_status ? '<br><span class="acc-status">' + esc(a.last_sync_status) + '</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function addAccount() {
    var id = ($('acc-id') || {}).value || '';
    var pw = ($('acc-pw') || {}).value || '';
    var label = ($('acc-label') || {}).value || '';
    if (!id.trim() || !pw) return msg($('acc-msg'), '아이디와 비밀번호를 입력하세요.', true);
    msg($('acc-msg'), '저장 중...');
    api('/tennis/accounts', { method: 'POST', body: { login_id: id.trim(), password: pw, label: label.trim() } })
      .then(function () {
        $('acc-id').value = ''; $('acc-pw').value = ''; $('acc-label').value = '';
        $('acc-id').focus();                       // 연달아 여러 개 넣기 쉽게
        msg($('acc-msg'), '저장했습니다. 계속 추가할 수 있습니다.');
        return loadAccounts();
      })
      .catch(function (e) { msg($('acc-msg'), e.message, true); });
  }

  /* ── 수집 ─────────────────────────────────────────────── */
  function log(line) {
    var box = $('sync-log');
    if (!box) return;
    box.classList.remove('hidden');
    var cls = /^✓/.test(line) ? 'ok' : (/^✗/.test(line) ? 'fail' : '');
    box.innerHTML += (cls ? '<span class="' + cls + '">' + esc(line) + '</span>' : esc(line)) + '<br>';
    box.scrollTop = box.scrollHeight;
  }

  function syncOne(id, loginId) {
    return api('/tennis/sync', { method: 'POST', body: { account_id: id } })
      .then(function (d) { log((d.ok ? '✓ ' : '✗ ') + (d.login_id || loginId || id) + ' — ' + d.message); return d; })
      .catch(function (e) { log('✗ ' + (loginId || id) + ' — ' + e.message); });
  }

  function syncAll() {
    var rows = [].slice.call(document.querySelectorAll('#acc-list .acc-row'));
    if (!rows.length) return;
    var btn = $('sync-btn');
    if (btn) { btn.disabled = true; btn.textContent = '수집 중...'; }
    var box = $('sync-log');
    if (box) { box.innerHTML = ''; box.classList.remove('hidden'); }
    log('계정 ' + rows.length + '개 수집을 시작합니다.');

    // 사이트에 부담을 주지 않도록 한 번에 하나씩 순서대로 돈다
    rows.reduce(function (chain, row) {
      return chain.then(function () {
        var name = (row.querySelector('.acc-main strong') || {}).textContent;
        return syncOne(Number(row.dataset.id), name);
      });
    }, Promise.resolve()).then(function () {
      log('수집이 끝났습니다.');
      if (btn) { btn.disabled = false; btn.textContent = '전체 계정 수집'; }
      loadAccounts();
      loadReservations();
    });
  }

  /* ── 내역 ─────────────────────────────────────────────── */
  function loadReservations() {
    return api('/tennis/reservations').then(function (d) { renderReservations(d.reservations || []); })
      .catch(function (e) {
        var box = $('resv-table');
        if (box) box.innerHTML = '<p class="error-msg">' + esc(e.message) + '</p>';
      });
  }

  function renderReservations(list) {
    var box = $('resv-table');
    var cnt = $('resv-count');
    if (cnt) cnt.textContent = list.length ? '(' + list.length + '건)' : '';
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<p class="resv-empty">아직 수집한 내역이 없습니다.</p>';
      return;
    }
    // 모든 계정의 내역을 한 표로 합치고, 어느 계정으로 잡은 건지는 맨 뒤에 붙인다
    box.innerHTML =
      '<table class="resv-table"><thead><tr>' +
      '<th>#</th><th>이용일</th><th>요일</th><th>시간</th><th>시설</th>' +
      '<th>단체</th><th>인원</th><th>접수번호</th><th>계정</th>' +
      '</tr></thead><tbody>' +
      list.map(function (r, i) {
        var d = r.use_date ? String(r.use_date).slice(0, 10) : '';
        var dow = d ? '일월화수목금토'.charAt(new Date(d + 'T00:00:00').getDay()) : '';
        return '<tr>' +
          '<td class="resv-idx">' + (i + 1) + '</td>' +
          '<td>' + esc(d || '-') + '</td>' +
          '<td class="resv-dow">' + esc(dow) + '</td>' +
          '<td>' + esc(r.use_time || '-') + '</td>' +
          '<td>' + esc(r.facility || '-') + '</td>' +
          '<td>' + esc(r.team || '-') + '</td>' +
          '<td class="resv-amt">' + (r.people != null ? r.people + '명' : '-') + '</td>' +
          '<td class="resv-no">' + esc(/^X-/.test(r.reserve_no) ? '—' : r.reserve_no) + '</td>' +
          '<td class="resv-acct">' + esc(r.login_id) +
            (r.label ? '<span class="acc-tag">' + esc(r.label) + '</span>' : '') + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  /* ── 연결 ─────────────────────────────────────────────── */
  function init() {
    var addBtn = $('acc-add-btn');
    if (addBtn) addBtn.addEventListener('click', addAccount);

    // 메모 칸에서 엔터 → 바로 추가 (여러 개 넣을 때 편하다)
    var labelField = $('acc-label');
    if (labelField) labelField.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addAccount(); }
    });

    var syncBtn = $('sync-btn');
    if (syncBtn) syncBtn.addEventListener('click', syncAll);

    var list = $('acc-list');
    if (list) list.addEventListener('click', function (e) {
      var row = e.target.closest('.acc-row');
      if (!row) return;
      var id = Number(row.dataset.id);
      var name = (row.querySelector('.acc-main strong') || {}).textContent;
      if (e.target.classList.contains('acc-sync')) {
        var box = $('sync-log');
        if (box) { box.innerHTML = ''; box.classList.remove('hidden'); }
        syncOne(id, name).then(function () { loadAccounts(); loadReservations(); });
      } else if (e.target.classList.contains('acc-del')) {
        if (!confirm(name + ' 계정을 삭제할까요? 수집한 예약내역도 함께 지워집니다.')) return;
        api('/tennis/accounts/' + id, { method: 'DELETE' })
          .then(function () { loadAccounts(); loadReservations(); })
          .catch(function (err) { msg($('acc-msg'), err.message, true); });
      }
    });

    loadAccounts();
    loadReservations();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
