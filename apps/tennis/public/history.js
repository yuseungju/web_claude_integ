/**
 * 예약내역 탭 — 대치유수지 계정 목록 · 예약완료 내역 · 계정별 월 정산.
 *
 * 이 웹의 로그인과는 아무 상관이 없다. 내부에서 함께 보는 하나의 공용
 * 목록이라 열쇠를 나누지 않는다. 여기 등록하는 건 오로지 대치유수지
 * 사이트에 자동 로그인할 계정이고, 여러 개 등록할 수 있다.
 *
 * 서버(lambda/tennis.js)가 계정마다 직접 로그인해서 긁어오므로
 * 이 화면은 목록을 보여주고 수집을 시작시키는 역할만 한다.
 *
 * 금액은 서버가 아니라 여기서 계산한다. 체크를 껐다 켤 때마다 곧바로
 * 합계가 바뀌어야 하는데, 그때마다 서버를 다시 부르면 굼뜨기 때문이다.
 */
(function () {
  'use strict';

  var API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';
  // 서버는 이 값으로 행을 묶을 뿐이다. 나중에 목록을 나누고 싶으면 여기만 바꾸면 된다.
  var LIST_KEY = 'tennis-shared-list';

  var $ = function (id) { return document.getElementById(id); };

  var state = { rows: [], prices: [] };     // 화면이 들고 있는 현재 자료

  function api(path, opts) {
    opts = opts || {};
    var body = opts.body || {};
    var url = API + path;
    var method = opts.method || 'GET';
    if (method === 'GET' || method === 'DELETE') {
      url += (path.indexOf('?') < 0 ? '?' : '&') + 'key=' + encodeURIComponent(LIST_KEY);
    } else {
      body.key = LIST_KEY;
    }
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
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

  var won = function (n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; };

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
        '<div class="acc-main"><strong>' + esc(a.login_id) + '</strong>' +
          (a.person ? '<span class="acc-tag">' + esc(a.person) + '</span>' : '') + '</div>' +
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
    var person = ($('acc-person') || {}).value || '';
    if (!id.trim() || !pw) return msg($('acc-msg'), '아이디와 비밀번호를 입력하세요.', true);
    msg($('acc-msg'), '저장 중...');
    api('/tennis/accounts', { method: 'POST', body: { login_id: id.trim(), password: pw, person: person.trim() } })
      .then(function () {
        $('acc-id').value = ''; $('acc-pw').value = '';
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

  /* ── 단가 ─────────────────────────────────────────────── */
  function loadPrices() {
    return api('/tennis/prices').then(function (d) {
      state.prices = (d.prices || []).map(function (p) {
        return { hour: Number(p.start_hour), price: Number(p.price) };
      });
      renderPrices();
    }).catch(function (e) { msg($('price-msg'), e.message, true); });
  }

  function renderPrices() {
    var box = $('price-list');
    if (!box) return;
    if (!state.prices.length) state.prices = [{ hour: 19, price: 0 }];
    box.innerHTML = state.prices.map(function (p, i) {
      return '<div class="price-row" data-i="' + i + '">' +
        '<input type="number" class="price-hour" min="0" max="23" value="' + p.hour + '">' +
        '<span class="price-sep">시 시작 →</span>' +
        '<input type="number" class="price-won" min="0" step="100" value="' + p.price + '">' +
        '<span class="price-sep">원</span>' +
        '<button type="button" class="price-del">삭제</button>' +
      '</div>';
    }).join('');
  }

  function readPrices() {
    return [].slice.call(document.querySelectorAll('#price-list .price-row')).map(function (row) {
      return {
        hour: Number((row.querySelector('.price-hour') || {}).value),
        price: Number((row.querySelector('.price-won') || {}).value),
      };
    }).filter(function (p) { return Number.isInteger(p.hour) && p.hour >= 0 && p.hour <= 23; });
  }

  function savePrices() {
    state.prices = readPrices();
    msg($('price-msg'), '저장 중...');
    api('/tennis/prices', { method: 'POST', body: { prices: state.prices } })
      .then(function (d) {
        state.prices = (d.prices || []).map(function (p) {
          return { hour: Number(p.start_hour), price: Number(p.price) };
        });
        renderPrices();
        renderReservations();          // 금액 열까지 다시 그린다
        msg($('price-msg'), '저장했습니다.');
      })
      .catch(function (e) { msg($('price-msg'), e.message, true); });
  }

  /** "19:00~21:00" 에서 시작 시각(19)을 뽑는다 */
  function startHour(useTime) {
    var m = String(useTime || '').match(/(\d{1,2}):\d{2}/);
    return m ? Number(m[1]) : null;
  }

  function priceOf(row) {
    var h = startHour(row.use_time);
    if (h == null) return 0;
    for (var i = 0; i < state.prices.length; i++) {
      if (state.prices[i].hour === h) return state.prices[i].price || 0;
    }
    return 0;
  }

  /* ── 내역 ─────────────────────────────────────────────── */
  function loadReservations() {
    return api('/tennis/reservations').then(function (d) {
      state.rows = d.reservations || [];
      renderReservations();
    }).catch(function (e) {
      var box = $('resv-table');
      if (box) box.innerHTML = '<p class="error-msg">' + esc(e.message) + '</p>';
    });
  }

  function renderReservations() {
    var box = $('resv-table');
    var cnt = $('resv-count');
    var list = state.rows;
    if (cnt) cnt.textContent = list.length ? '(' + list.length + '건)' : '';
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<p class="resv-empty">아직 수집한 내역이 없습니다.</p>';
      renderSummary();
      return;
    }
    // 모든 계정의 내역을 한 표로 합치고, 어느 계정으로 잡은 건지는 맨 뒤에 붙인다
    box.innerHTML =
      '<table class="resv-table"><thead><tr>' +
      '<th class="resv-chk"><input type="checkbox" id="chk-all" title="전체 선택"></th>' +
      '<th>#</th><th>이용일</th><th>요일</th><th>시간</th><th>시설</th>' +
      '<th>단체</th><th>인원</th><th>금액</th><th>접수번호</th><th>계정</th>' +
      '</tr></thead><tbody>' +
      list.map(function (r, i) {
        var d = r.use_date ? String(r.use_date).slice(0, 10) : '';
        var dow = d ? '일월화수목금토'.charAt(new Date(d + 'T00:00:00').getDay()) : '';
        var on = r.checked !== false;
        return '<tr class="' + (on ? '' : 'row-off') + '" data-no="' + esc(r.reserve_no) + '">' +
          '<td class="resv-chk"><input type="checkbox" class="row-chk"' + (on ? ' checked' : '') + '></td>' +
          '<td class="resv-idx">' + (i + 1) + '</td>' +
          '<td>' + esc(d || '-') + '</td>' +
          '<td class="resv-dow">' + esc(dow) + '</td>' +
          '<td>' + esc(r.use_time || '-') + '</td>' +
          '<td>' + esc(r.facility || '-') + '</td>' +
          '<td>' + esc(r.team || '-') + '</td>' +
          '<td class="resv-amt">' + (r.people != null ? r.people + '명' : '-') + '</td>' +
          '<td class="resv-amt">' + won(priceOf(r)) + '</td>' +
          '<td class="resv-no">' + esc(/^X-/.test(r.reserve_no) ? '—' : r.reserve_no) + '</td>' +
          '<td class="resv-acct">' + esc(r.person || r.login_id) +
            (r.person ? '<span class="acc-tag">' + esc(r.login_id) + '</span>' : '') + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';

    var all = $('chk-all');
    if (all) all.checked = list.every(function (r) { return r.checked !== false; });
    renderSummary();
  }

  /* ── 정산 ─────────────────────────────────────────────── */
  function renderSummary() {
    var box = $('sum-table');
    if (!box) return;

    var picked = state.rows.filter(function (r) { return r.checked !== false && r.use_date; });
    if (!picked.length) {
      box.innerHTML = '<p class="resv-empty">체크된 내역이 없습니다.</p>';
      return;
    }

    // 최근 3개월(이번 달 포함). 앞으로 잡힌 예약도 그 달에 합산한다.
    var now = new Date();
    var months = [];
    for (var k = 2; k >= 0; k--) {
      var d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    picked.forEach(function (r) {
      var ym = String(r.use_date).slice(0, 7);
      if (months.indexOf(ym) < 0) months.push(ym);
    });
    months = months.sort().slice(-3);

    var byAcct = {};
    picked.forEach(function (r) {
      var ym = String(r.use_date).slice(0, 7);
      if (months.indexOf(ym) < 0) return;
      var who = r.person || r.login_id;      // 이름이 없으면 아이디로 묶는다
      byAcct[who] = byAcct[who] || {};
      byAcct[who][ym] = (byAcct[who][ym] || 0) + priceOf(r);
    });

    var names = Object.keys(byAcct).sort();
    if (!names.length) {
      box.innerHTML = '<p class="resv-empty">최근 3개월에 해당하는 체크 내역이 없습니다.</p>';
      return;
    }

    var totals = {};
    months.forEach(function (m) {
      totals[m] = names.reduce(function (a, n) { return a + (byAcct[n][m] || 0); }, 0);
    });

    box.innerHTML =
      '<table class="resv-table sum-table"><thead><tr><th>이름</th>' +
      months.map(function (m) { return '<th class="resv-amt">' + esc(m) + '</th>'; }).join('') +
      '<th class="resv-amt">합계</th></tr></thead><tbody>' +
      names.map(function (n) {
        var sum = months.reduce(function (a, m) { return a + (byAcct[n][m] || 0); }, 0);
        return '<tr><td class="resv-acct">' + esc(n) + '</td>' +
          months.map(function (m) {
            var v = byAcct[n][m] || 0;
            return '<td class="resv-amt">' + (v ? won(v) : '-') + '</td>';
          }).join('') +
          '<td class="resv-amt sum-cell">' + won(sum) + '</td></tr>';
      }).join('') +
      '<tr class="sum-row"><td>합계</td>' +
      months.map(function (m) { return '<td class="resv-amt">' + won(totals[m]) + '</td>'; }).join('') +
      '<td class="resv-amt sum-cell">' +
        won(months.reduce(function (a, m) { return a + totals[m]; }, 0)) + '</td></tr>' +
      '</tbody></table>';

    renderSettle(picked);
  }

  /* ── 정산 ─────────────────────────────────────────────────
   * 총액을 전체 인원으로 나눠 1인당 부담액을 구하고,
   * 이름별로 "낸 돈 - 부담액" 을 낸다. 양수면 받을 돈, 음수면 낼 돈이다.
   * 인원을 사람 수가 아니라 직접 받는 이유는, 예약을 잡지 않은 사람도
   * 함께 쓰는 경우가 있어서다.
   */
  function renderSettle(picked) {
    var box = $('settle-table');
    if (!box) return;

    var paid = {};
    var total = 0;
    (picked || []).forEach(function (r) {
      var who = r.person || r.login_id;
      var v = priceOf(r);
      paid[who] = (paid[who] || 0) + v;
      total += v;
    });

    var names = Object.keys(paid).sort();
    var headcount = Number(($('settle-people') || {}).value) || 0;
    if (!names.length || headcount < 1) {
      box.innerHTML = '<p class="resv-empty">체크된 내역과 전체 인원을 입력하면 정산이 나옵니다.</p>';
      return;
    }

    var share = Math.round(total / headcount);
    box.innerHTML =
      '<table class="resv-table sum-table"><thead><tr>' +
      '<th>이름</th><th class="resv-amt">낸 돈</th><th class="resv-amt">부담액</th>' +
      '<th class="resv-amt">정산</th></tr></thead><tbody>' +
      names.map(function (n) {
        var diff = paid[n] - share;
        var cls = diff > 0 ? 'settle-get' : (diff < 0 ? 'settle-pay' : 'settle-even');
        var text = diff > 0 ? won(diff) + ' 받기'
          : (diff < 0 ? won(-diff) + ' 내기' : '정산 없음');
        return '<tr><td class="resv-acct">' + esc(n) + '</td>' +
          '<td class="resv-amt">' + won(paid[n]) + '</td>' +
          '<td class="resv-amt">' + won(share) + '</td>' +
          '<td class="resv-amt ' + cls + '">' + text + '</td></tr>';
      }).join('') +
      // 예약을 잡지 않은 인원도 부담액을 낸다. 이름을 모르니 묶어서 보여준다.
      (headcount > names.length
        ? '<tr><td class="settle-rest">그 외 ' + (headcount - names.length) + '명</td>' +
          '<td class="resv-amt">0원</td>' +
          '<td class="resv-amt">' + won(share) + '</td>' +
          '<td class="resv-amt settle-pay">각 ' + won(share) + ' 내기</td></tr>'
        : '') +
      '<tr class="sum-row"><td>합계</td>' +
      '<td class="resv-amt">' + won(total) + '</td>' +
      '<td class="resv-amt">' + headcount + '명 × ' + won(share) + '</td>' +
      '<td class="resv-amt sum-cell">1인당 ' + won(share) + '</td></tr>' +
      '</tbody></table>';
  }

  /* ── 체크 ─────────────────────────────────────────────── */
  function setChecked(no, on) {
    var row = null;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].reserve_no === no) { row = state.rows[i]; break; }
    }
    if (!row) return Promise.resolve();
    row.checked = on;                       // 먼저 화면을 바꾸고
    renderReservations();                   // 합계가 곧바로 반영된다
    return api('/tennis/check', { method: 'POST', body: { reserve_no: no, checked: on } })
      .catch(function (e) {                 // 실패하면 되돌린다
        row.checked = !on;
        renderReservations();
        msg($('price-msg'), '체크 저장 실패: ' + e.message, true);
      });
  }

  function setAll(on) {
    state.rows.forEach(function (r) { r.checked = on; });
    renderReservations();
    // 한꺼번에 보내면 사이트가 아니라 우리 서버라 부담은 적지만, 순서대로 보낸다
    state.rows.reduce(function (chain, r) {
      return chain.then(function () {
        return api('/tennis/check', { method: 'POST', body: { reserve_no: r.reserve_no, checked: on } });
      });
    }, Promise.resolve()).catch(function (e) {
      msg($('price-msg'), '체크 저장 실패: ' + e.message, true);
    });
  }

  /* ── 연결 ─────────────────────────────────────────────── */
  function init() {
    var addBtn = $('acc-add-btn');
    if (addBtn) addBtn.addEventListener('click', addAccount);

    var pwField = $('acc-pw');
    if (pwField) pwField.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addAccount(); }
    });

    var syncBtn = $('sync-btn');
    if (syncBtn) syncBtn.addEventListener('click', syncAll);

    var addPrice = $('price-add');
    if (addPrice) addPrice.addEventListener('click', function () {
      state.prices = readPrices();
      state.prices.push({ hour: 17, price: 0 });
      renderPrices();
    });

    var savePrice = $('price-save');
    if (savePrice) savePrice.addEventListener('click', savePrices);

    var priceBox = $('price-list');
    if (priceBox) priceBox.addEventListener('click', function (e) {
      if (!e.target.classList.contains('price-del')) return;
      state.prices = readPrices();
      var row = e.target.closest('.price-row');
      state.prices.splice(Number(row.dataset.i), 1);
      renderPrices();
    });

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

    var people = $('settle-people');
    if (people) {
      people.addEventListener('input', function () { renderSummary(); });
      people.addEventListener('change', function () {
        api('/tennis/settings', { method: 'POST', body: { settings: { headcount: people.value } } })
          .catch(function () { /* 저장 실패해도 화면 계산은 그대로 된다 */ });
      });
    }

    var table = $('resv-table');
    if (table) table.addEventListener('change', function (e) {
      if (e.target.id === 'chk-all') return setAll(e.target.checked);
      if (!e.target.classList.contains('row-chk')) return;
      var tr = e.target.closest('tr');
      if (tr) setChecked(tr.dataset.no, e.target.checked);
    });

    loadAccounts();
    api('/tennis/settings')
      .then(function (d) {
        var n = (d.settings || {}).headcount;
        if (n && $('settle-people')) $('settle-people').value = n;
      })
      .catch(function () { /* 없으면 기본값을 쓴다 */ })
      .then(function () { return loadPrices(); })
      .then(loadReservations);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
