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

  /**
   * 아래쪽 계산(합계·정산·지시문)은 표에서 고른 것이 기준이다.
   * 체크나 기간이 바뀌면 그 결과가 낡은 것이 되므로, 자동으로 다시 계산하지 않고
   * "다시 누르세요" 라고 알린 뒤 버튼을 살려 둔다. 누르면 계산하고 그 버튼만 잠근다.
   *
   * 안내 문구는 한 번이라도 계산해 본 뒤에만 띄운다.
   * 처음 열었을 때부터 "바뀌었습니다" 라고 하면 이상하기 때문이다.
   */
  var PANELS = { price: ['price-save', 'price-stale'], cal: ['cal-make', 'cal-stale'] };

  function stale(which) {
    Object.keys(PANELS).forEach(function (k) {
      if (which && k !== which) return;
      var btn = $(PANELS[k][0]);
      var note = $(PANELS[k][1]);
      if (btn) btn.disabled = false;
      if (note) note.classList.toggle('hidden', note.dataset.used !== '1');
    });
  }

  function done(which) {
    var btn = $(PANELS[which][0]);
    var note = $(PANELS[which][1]);
    if (btn) btn.disabled = true;
    if (note) { note.dataset.used = '1'; note.classList.add('hidden'); }
  }

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

  var ymd = function (d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  };

  /** 차월 1일 ~ 말일 — 기본 기간이다 */
  function nextMonthRange() {
    var n = new Date();
    return {
      from: ymd(new Date(n.getFullYear(), n.getMonth() + 1, 1)),
      to: ymd(new Date(n.getFullYear(), n.getMonth() + 2, 0)),
    };
  }

  /** 기간 필터를 적용한 목록. 캘린더도 이 결과를 그대로 쓴다. */
  function filtered() {
    var from = ($('f-from') || {}).value || '';
    var to = ($('f-to') || {}).value || '';
    return state.rows.filter(function (r) {
      if (!r.use_date) return !from && !to;
      var d = String(r.use_date).slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

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
        renderReservations();          // 금액 열까지 다시 그린다 (여기서 stale 이 켜진다)
        renderSummary();               // 합계·정산은 이 버튼을 눌렀을 때만 계산한다
        done('price');
        msg($('price-msg'), '저장했습니다. 아래 합계와 정산을 다시 계산했습니다.');
      })
      .catch(function (e) { msg($('price-msg'), e.message, true); });
  }

  /** "19:00~21:00" 에서 시작 시각(19)을 뽑는다 */
  function startHour(useTime) {
    var m = String(useTime || '').match(/(\d{1,2}):\d{2}/);
    return m ? Number(m[1]) : null;
  }

  /** 시간대 단가로 매긴 기본 금액 */
  function basePriceOf(row) {
    var h = startHour(row.use_time);
    if (h == null) return 0;
    for (var i = 0; i < state.prices.length; i++) {
      if (state.prices[i].hour === h) return state.prices[i].price || 0;
    }
    return 0;
  }

  /** 실제로 쓸 금액 — 직접 넣은 값이 있으면 그게 이긴다 */
  function priceOf(row) {
    if (row.amount_override !== null && row.amount_override !== undefined && row.amount_override !== '') {
      return Number(row.amount_override) || 0;
    }
    return basePriceOf(row);
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
    var list = filtered();
    if (cnt) {
      cnt.textContent = list.length
        ? '(' + list.length + '건' + (list.length !== state.rows.length ? ' / 전체 ' + state.rows.length : '') + ')'
        : '';
    }
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<p class="resv-empty">아직 수집한 내역이 없습니다.</p>';
      stale();
      return;
    }
    // 모든 계정의 내역을 한 표로 합치고, 어느 계정으로 잡은 건지는 맨 뒤에 붙인다
    box.innerHTML =
      '<table class="resv-table"><thead><tr>' +
      '<th class="resv-chk"><input type="checkbox" id="chk-all" title="전체 선택"></th>' +
      '<th>#</th><th>이용일</th><th>요일</th><th>시간</th><th>시설</th>' +
      '<th>단체</th><th>인원</th><th>금액</th><th>양도자</th><th>접수번호</th><th>계정</th>' +
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
          '<td class="resv-amt">' +
            '<input type="number" class="amt-input" min="0" step="100" value="' + priceOf(r) + '"' +
            (r.amount_override != null && r.amount_override !== '' ? ' data-own="1"' : '') +
            ' title="비우면 시간대 단가(' + basePriceOf(r) + '원)로 되돌아갑니다">' +
          '</td>' +
          '<td class="resv-tr">' +
            '<input type="text" class="tr-input" maxlength="20" value="' + esc(r.transferee || '') + '"' +
            ' placeholder="' + (on ? '' : '넘겨받은 사람') + '"' +
            (on ? ' disabled title="체크를 해제하면 입력할 수 있습니다"' : '') + '>' +
          '</td>' +
          '<td class="resv-no">' + esc(/^X-/.test(r.reserve_no) ? '—' : r.reserve_no) + '</td>' +
          '<td class="resv-acct">' + esc(r.person || r.login_id) +
            (r.person ? '<span class="acc-tag">' + esc(r.login_id) + '</span>' : '') + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';

    var all = $('chk-all');
    if (all) all.checked = list.length > 0 && list.every(function (r) { return r.checked !== false; });
    stale();                     // 아래 계산은 이제 낡았다
  }

  /* ── 정산 ─────────────────────────────────────────────── */
  function renderSummary() {
    var box = $('sum-table');
    if (!box) return;

    var all = filtered();
    renderTransfers(all);                              // 체크 해제 + 양도자 이름
    var picked = all.filter(function (r) { return r.checked !== false && r.use_date; });
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

    renderSettle(picked, all);
  }

  /* ── 정산 ─────────────────────────────────────────────────
   * 총액을 전체 인원으로 나눠 1인당 부담액을 구하고,
   * 이름별로 "낸 돈 - 부담액" 을 낸다. 양수면 받을 돈, 음수면 낼 돈이다.
   * 인원을 사람 수가 아니라 직접 받는 이유는, 예약을 잡지 않은 사람도
   * 함께 쓰는 경우가 있어서다.
   */
  /**
   * 양도 정산 — 체크를 해제하고 넘겨받은 사람 이름을 적은 건들.
   * 그 사람이 그 금액을 내야 하므로, 위 정산과 섞지 않고 따로 보여준다.
   * 이름으로 묶으므로 한 사람이 여러 건을 받아도 한 줄로 합쳐진다.
   */
  /** 양도자별로 "받은 돈" 을 모은다. 정산에서 그만큼 빼기 위한 것이다. */
  function transferTotals(rows) {
    var got = {};
    (rows || []).forEach(function (r) {
      if (r.checked !== false) return;                 // 체크된 건은 우리가 쓴 것
      var who = String(r.transferee || '').trim();
      if (!who) return;                                // 이름을 안 적었으면 집계에서 뺀다
      got[who] = (got[who] || 0) + priceOf(r);
    });
    return got;
  }

  function renderTransfers(rows) {
    var box = $('transfer-table');
    if (!box) return;

    var got = transferTotals(rows);
    var names = Object.keys(got).sort();
    var total = names.reduce(function (acc, n) { return acc + got[n]; }, 0);

    if (!names.length) {
      box.innerHTML = '<p class="resv-empty">체크를 해제하고 양도자 이름을 적으면 여기에 모입니다.</p>';
      return;
    }

    box.innerHTML =
      '<table class="resv-table sum-table"><thead><tr>' +
      '<th>양도자</th><th class="resv-amt">건수</th><th class="resv-amt">받은 돈</th>' +
      '</tr></thead><tbody>' +
      names.map(function (n) {
        var cnt = (rows || []).filter(function (r) {
          return r.checked === false && String(r.transferee || '').trim() === n;
        }).length;
        return '<tr><td class="resv-acct">' + esc(n) + '</td>' +
          '<td class="resv-amt">' + cnt + '건</td>' +
          '<td class="resv-amt settle-pay">-' + won(got[n]) + '</td></tr>';
      }).join('') +
      '<tr class="sum-row"><td>합계</td><td class="resv-amt"></td>' +
      '<td class="resv-amt sum-cell">-' + won(total) + '</td></tr>' +
      '</tbody></table>';
  }

  function renderSettle(picked, all) {
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

    // 양도자는 그 자리를 넘기고 돈을 받았다. 받은 만큼 낸 돈에서 뺀다.
    // 이렇게 해야 "덜 낸 사람" 으로 잡혀 정산에서 마이너스가 된다.
    var got = transferTotals(all);
    Object.keys(got).forEach(function (n) {
      paid[n] = (paid[n] || 0) - got[n];
    });

    var names = Object.keys(paid).sort();
    var headcount = Number(($('settle-people') || {}).value) || 0;
    if (!names.length || headcount < 1) {
      box.innerHTML = '<p class="resv-empty">체크된 내역과 전체 인원을 입력하면 정산이 나옵니다.</p>';
      return;
    }

    // 양도로 들어온 돈은 밖에서 들어온 수입이라 그룹의 순지출을 줄인다.
    // 개인의 낸 돈에서만 빼면 총액과 개인 합이 어긋나므로 여기서도 뺀다.
    var gotSum = Object.keys(got).reduce(function (a, n) { return a + got[n]; }, 0);
    var net = total - gotSum;
    var share = Math.round(net / headcount);
    box.innerHTML =
      '<table class="resv-table sum-table"><thead><tr>' +
      '<th>이름</th><th class="resv-amt">낸 돈</th><th class="resv-amt">부담액</th>' +
      '<th class="resv-amt">정산</th></tr></thead><tbody>' +
      names.map(function (n) {
        var diff = paid[n] - share;
        var cls = diff > 0 ? 'settle-get' : (diff < 0 ? 'settle-pay' : 'settle-even');
        var text = diff > 0 ? won(diff) + ' 받기'
          : (diff < 0 ? won(-diff) + ' 내기' : '정산 없음');
        var p = paid[n];
        return '<tr><td class="resv-acct">' + esc(n) + '</td>' +
          '<td class="resv-amt' + (p < 0 ? ' settle-pay' : '') + '">' +
            (p < 0 ? '-' + won(-p) : won(p)) + '</td>' +
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
      '<td class="resv-amt">' + won(net) + '</td>' +
      '<td class="resv-amt">' + headcount + '명 × ' + won(share) + '</td>' +
      '<td class="resv-amt sum-cell">1인당 ' + won(share) + '</td></tr>' +
      '</tbody></table>';

    renderPayments(paid, names, share, headcount);
  }

  /**
   * 누가 누구에게 얼마를 보낼지.
   *
   * 받을 사람(+)과 낼 사람(−)을 각각 큰 금액부터 놓고 앞에서부터 짝지어
   * 가능한 만큼 보낸다. 한 번 짝지을 때마다 둘 중 적어도 한 쪽은 잔액이
   * 0이 되므로, 송금 횟수가 (사람 수 − 1) 을 넘지 않는다. 모두가 한 사람에게
   * 몰아주는 방식보다 대체로 적고, 무엇보다 각자 한두 번만 보내면 끝난다.
   *
   * 이름이 없는 인원("그 외 N명")도 각자 한 사람으로 세어 번호를 붙인다.
   * 뭉뚱그리면 누가 누구에게 보내야 하는지가 안 나오기 때문이다.
   */
  function renderPayments(paid, names, share, headcount) {
    var box = $('pay-table');
    if (!box) return;

    var bal = [];
    names.forEach(function (n) { bal.push({ name: n, v: paid[n] - share }); });
    var rest = headcount - names.length;
    for (var i = 1; i <= rest; i++) bal.push({ name: '그 외 ' + i, v: -share });

    var plus = bal.filter(function (x) { return x.v > 0; })
      .sort(function (a, b) { return b.v - a.v; });
    var minus = bal.filter(function (x) { return x.v < 0; })
      .map(function (x) { return { name: x.name, v: -x.v }; })
      .sort(function (a, b) { return b.v - a.v; });

    if (!plus.length || !minus.length) {
      box.innerHTML = '<p class="resv-empty">주고받을 것이 없습니다.</p>';
      return;
    }

    var pays = [];
    var pi = 0, mi = 0;
    while (pi < plus.length && mi < minus.length) {
      var amount = Math.min(plus[pi].v, minus[mi].v);
      if (amount > 0) pays.push({ from: minus[mi].name, to: plus[pi].name, amount: amount });
      plus[pi].v -= amount;
      minus[mi].v -= amount;
      if (plus[pi].v === 0) pi++;
      if (minus[mi].v === 0) mi++;
    }

    var totalPay = pays.reduce(function (a, p) { return a + p.amount; }, 0);
    box.innerHTML =
      '<table class="resv-table sum-table"><thead><tr>' +
      '<th>보내는 사람</th><th></th><th>받는 사람</th><th class="resv-amt">금액</th>' +
      '</tr></thead><tbody>' +
      pays.map(function (p) {
        return '<tr>' +
          '<td class="settle-pay">' + esc(p.from) + '</td>' +
          '<td class="pay-arrow">→</td>' +
          '<td class="settle-get">' + esc(p.to) + '</td>' +
          '<td class="resv-amt sum-cell">' + won(p.amount) + '</td></tr>';
      }).join('') +
      '<tr class="sum-row"><td>' + pays.length + '번</td><td></td><td></td>' +
      '<td class="resv-amt">' + won(totalPay) + '</td></tr>' +
      '</tbody></table>';
  }

  /** 행의 금액을 직접 고친다. 비우면 시간대 단가로 되돌아간다. */
  function setAmount(no, raw) {
    var row = null;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].reserve_no === no) { row = state.rows[i]; break; }
    }
    if (!row) return;

    var trimmed = String(raw == null ? '' : raw).trim();
    var value = trimmed === '' ? null : Math.max(0, Math.round(Number(trimmed) || 0));
    row.amount_override = value;

    // 표를 통째로 다시 그리면 입력 중 포커스가 튄다. 아래 계산만 낡음으로 표시한다.
    stale();
    api('/tennis/check', { method: 'POST', body: { reserve_no: no, amount: value } })
      .catch(function (e) { msg($('price-msg'), '금액 저장 실패: ' + e.message, true); });
  }

  /** 체크를 해제한 건을 넘기고 돈을 받은 사람. 받은 만큼 정산에서 빠진다. */
  function setTransferee(no, name) {
    var row = null;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].reserve_no === no) { row = state.rows[i]; break; }
    }
    if (!row) return;
    row.transferee = String(name || '').trim();

    // 표를 다시 그리면 입력 중 포커스가 튄다. 아래 계산만 낡음으로 표시한다.
    stale();
    api('/tennis/check', { method: 'POST', body: { reserve_no: no, transferee: row.transferee } })
      .catch(function (e) { msg($('price-msg'), '양도자 저장 실패: ' + e.message, true); });
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
    var target = filtered();          // 화면에 보이는 것만 바꾼다
    target.forEach(function (r) { r.checked = on; });
    renderReservations();
    // 한꺼번에 보내면 사이트가 아니라 우리 서버라 부담은 적지만, 순서대로 보낸다
    target.reduce(function (chain, r) {
      return chain.then(function () {
        return api('/tennis/check', { method: 'POST', body: { reserve_no: r.reserve_no, checked: on } });
      });
    }, Promise.resolve()).catch(function (e) {
      msg($('price-msg'), '체크 저장 실패: ' + e.message, true);
    });
  }

  /* ── 클로드에게 시킬 지시문 ───────────────────────────────
   * 회사 구글 계정이라 OAuth 클라이언트를 만들 수 없어서, 캘린더 API 를
   * 직접 부르는 대신 사람이 읽고 그대로 실행할 수 있는 지시문을 만든다.
   * 구글 캘린더에 로그인된 브라우저에서 클로드에게 붙여넣으면 된다.
   *
   * 지시문은 앞뒤 맥락 없이 처음 보는 클로드도 알아들을 수 있어야 한다.
   * 그래서 대상 캘린더 · 삭제 규칙 · 공통 설정 · 건별 정보를 모두 적는다.
   */
  var DOW = '일월화수목금토';

  /** "테니스장 - A코트" 에서 "A코트" 만 뽑는다 */
  function courtOf(facility) {
    var m = String(facility || '').match(/([A-Z]\s*코트)/);
    if (m) return m[1].replace(/\s/g, '');
    var parts = String(facility || '').split(/\s*-\s*/);
    return (parts[parts.length - 1] || '').trim();
  }

  /** "19:00~21:00" → ["19:00","21:00"] */
  function timeRange(useTime) {
    var m = String(useTime || '').match(/(\d{1,2}):(\d{2})\s*[~\-–]\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return [pad(m[1]) + ':' + m[2], pad(m[3]) + ':' + m[4]];
  }

  // 제목과 참석자는 늘 같다. 건마다 달라지는 건 코트명과 예약 상세뿐이다.
  var TITLE_PREFIX = '테니슈웅 (대치유수지)';
  var GUESTS = ['이길환', '한사라', '홍석기', '이태인'];

  function buildPrompt(rows, from, to) {
    var lines = [];
    lines.push('구글 캘린더에 테니스 예약 일정을 정리해 줘. 지금 이 브라우저는 구글 캘린더에 로그인돼 있어.');
    lines.push('');
    lines.push('대상: https://calendar.google.com/calendar/u/0/r  (기본 캘린더)');
    lines.push('기간: ' + from + ' ~ ' + to);
    lines.push('');
    lines.push('[1단계] 위 기간에서 제목에 "(AI작성)" 이 들어간 일정을 모두 삭제해 줘.');
    lines.push('        "(AI작성)" 이 없는 일정은 절대 건드리지 마. 손으로 만든 일정이야.');
    lines.push('');
    lines.push('[2단계] 아래 ' + rows.length + '건을 새로 만들어 줘.');
    lines.push('');
    lines.push('모든 일정 공통:');
    lines.push('  - 공개 설정: 비공개');
    lines.push('  - 알림: 10분 전 팝업');
    lines.push('  - 시간대: 한국 시간(KST)');
    lines.push('  - 참석자: ' + GUESTS.join(', ') + ' (조직 주소록에서 이름으로 찾아 추가)');
    lines.push('  - 참석자에게 초대 메일은 보내지 마.');
    lines.push('');

    rows.forEach(function (r, i) {
      var d = String(r.use_date).slice(0, 10);
      var t = timeRange(r.use_time);
      var dow = DOW.charAt(new Date(d + 'T00:00:00').getDay());
      var cells = (r.raw && r.raw.cells) || [];
      var desc = cells.length ? cells.join('  ')
        : [r.reserve_no, r.facility, d + ' (' + r.use_time + ')', r.team,
           (r.people || '') + '명', r.status].filter(Boolean).join('  ');
      lines.push((i + 1) + ') 제목: ' + TITLE_PREFIX + '-' + courtOf(r.facility) + ' (AI작성)');
      lines.push('   일시: ' + d + '(' + dow + ') ' + (t ? t[0] + ' ~ ' + t[1] : r.use_time));
      lines.push('   설명: ' + desc);
      lines.push('');
    });

    lines.push('[확인] 끝나면 삭제한 일정 수와 새로 만든 일정 수를 알려 줘.');
    return lines.join('\n');
  }

  function refreshPrompt() {
    var box = $('cal-out');
    if (!box) return null;

    var from = ($('f-from') || {}).value || '';
    var to = ($('f-to') || {}).value || '';
    if (!from || !to) return { error: '기간을 먼저 지정하세요.' };

    // 화면에서 보고 있는 그대로 — 기간 안의 체크된 예약완료 건
    var rows = filtered().filter(function (r) {
      return r.checked !== false && r.use_date && timeRange(r.use_time);
    });
    if (!rows.length) {
      if ($('cal-text')) $('cal-text').value = '';
      if ($('cal-out-info')) $('cal-out-info').textContent = '';
      return { error: '기간 안에 체크된 예약이 없습니다.' };
    }

    var text = buildPrompt(rows, from, to);
    box.classList.remove('hidden');
    if ($('cal-text')) $('cal-text').value = text;
    if ($('cal-out-info')) $('cal-out-info').textContent = rows.length + '건 · ' + text.length + '자';
    return { count: rows.length };
  }

  function makePrompt() {
    var r = refreshPrompt();
    if (!r) return;
    if (r.error) return msg($('cal-msg'), r.error, true);
    done('cal');
    msg($('cal-msg'), '아래 내용을 복사해 클로드에게 붙여넣으세요.');
  }

  function copyPrompt() {
    var field = $('cal-text');
    if (!field || !field.value) return;
    var done = function () { msg($('cal-msg'), '복사했습니다. 클로드에게 붙여넣으세요.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(field.value).then(done, function () {
        field.select();
        msg($('cal-msg'), '복사가 막혀 있습니다. 선택된 내용을 Ctrl+C 로 복사하세요.', true);
      });
    } else {
      field.select();
      done();
    }
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
    // 단가 값을 고치면 다시 저장할 수 있어야 한다
    if (priceBox) priceBox.addEventListener('input', function () { stale('price'); });
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

    var range = nextMonthRange();
    if ($('f-from') && !$('f-from').value) $('f-from').value = range.from;
    if ($('f-to') && !$('f-to').value) $('f-to').value = range.to;
    ['f-from', 'f-to'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', renderReservations);
    });
    var fNext = $('f-next');
    if (fNext) fNext.addEventListener('click', function () {
      var r = nextMonthRange();
      $('f-from').value = r.from; $('f-to').value = r.to;
      renderReservations();
    });
    var fAll = $('f-all');
    if (fAll) fAll.addEventListener('click', function () {
      $('f-from').value = ''; $('f-to').value = '';
      renderReservations();
    });

    var calMake = $('cal-make');
    if (calMake) calMake.addEventListener('click', makePrompt);
    var calCopy = $('cal-copy');
    if (calCopy) calCopy.addEventListener('click', copyPrompt);

    var table = $('resv-table');
    if (table) table.addEventListener('change', function (e) {
      if (e.target.id === 'chk-all') return setAll(e.target.checked);
      var tr = e.target.closest('tr');
      if (e.target.classList.contains('row-chk')) {
        if (tr) setChecked(tr.dataset.no, e.target.checked);
      } else if (e.target.classList.contains('amt-input')) {
        if (tr) {
          setAmount(tr.dataset.no, e.target.value);
          e.target.dataset.own = String(e.target.value).trim() === '' ? '' : '1';
        }
      } else if (e.target.classList.contains('tr-input')) {
        if (tr) setTransferee(tr.dataset.no, e.target.value);
      }
    });

    loadAccounts();
    api('/tennis/settings')
      .then(function (d) {
        var st = d.settings || {};
        if (st.headcount && $('settle-people')) $('settle-people').value = st.headcount;
      })
      .catch(function () { /* 없으면 기본값을 쓴다 */ })
      .then(function () { return loadPrices(); })
      .then(loadReservations);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
