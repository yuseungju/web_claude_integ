/**
 * 예약내역 탭 — 예약 사이트 계정 관리와 예약완료 내역 수집.
 *
 * 서버(lambda/tennis.js)가 계정별로 직접 로그인해서 긁어오므로
 * 이 화면은 목록을 보여주고 수집을 시작시키는 역할만 한다.
 * 로그인 토큰은 Work Kit 과 같은 localStorage.token 을 쓴다.
 */
(function () {
  'use strict';

  var API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';

  var $ = function (id) { return document.getElementById(id); };
  var show = function (el, on) { if (el) el.classList.toggle('hidden', !on); };
  var token = function () { try { return localStorage.getItem('token') || ''; } catch (e) { return ''; } };

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
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

  /* ── 로그인 ───────────────────────────────────────────── */
  function refreshAuth() {
    var logged = !!token();
    show($('hist-login'), !logged);
    show($('hist-main'), logged);
    if (logged) { loadAccounts(); loadReservations(); }
  }

  function doLogin() {
    var email = ($('hist-email') || {}).value || '';
    var pw = ($('hist-pw') || {}).value || '';
    if (!email || !pw) return msg($('hist-login-msg'), '이메일과 비밀번호를 입력하세요.', true);
    msg($('hist-login-msg'), '로그인 중...');
    api('/auth/login', { method: 'POST', body: { email: email, password: pw } })
      .then(function (d) {
        try {
          localStorage.setItem('token', d.token);
          localStorage.setItem('user', JSON.stringify(d.user));
        } catch (e) { /* 저장이 막혀 있어도 이번 세션은 동작한다 */ }
        msg($('hist-login-msg'), '');
        refreshAuth();
      })
      .catch(function (e) { msg($('hist-login-msg'), e.message, true); });
  }

  /* ── 계정 ─────────────────────────────────────────────── */
  function loadAccounts() {
    return api('/tennis/accounts').then(function (d) { renderAccounts(d.accounts || []); })
      .catch(function (e) { msg($('acc-msg'), e.message, true); });
  }

  function renderAccounts(list) {
    var box = $('acc-list');
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
        msg($('acc-msg'), '저장했습니다.');
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
      '<th>#</th><th>이용일</th><th>시간</th><th>시설</th><th>금액</th><th>예약번호</th><th>계정</th>' +
      '</tr></thead><tbody>' +
      list.map(function (r, i) {
        return '<tr>' +
          '<td class="resv-idx">' + (i + 1) + '</td>' +
          '<td>' + esc(r.use_date ? String(r.use_date).slice(0, 10) : '-') + '</td>' +
          '<td>' + esc(r.use_time || '-') + '</td>' +
          '<td>' + esc(r.facility || '-') + '</td>' +
          '<td class="resv-amt">' + (r.amount != null ? Number(r.amount).toLocaleString('ko-KR') + '원' : '-') + '</td>' +
          '<td class="resv-no">' + esc(/^X-/.test(r.reserve_no) ? '—' : r.reserve_no) + '</td>' +
          '<td class="resv-acct">' + esc(r.login_id) +
            (r.label ? '<span class="acc-tag">' + esc(r.label) + '</span>' : '') + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  /* ── 연결 ─────────────────────────────────────────────── */
  function init() {
    var loginBtn = $('hist-login-btn');
    if (loginBtn) loginBtn.addEventListener('click', doLogin);
    var pwField = $('hist-pw');
    if (pwField) pwField.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

    var addBtn = $('acc-add-btn');
    if (addBtn) addBtn.addEventListener('click', addAccount);

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

    refreshAuth();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
