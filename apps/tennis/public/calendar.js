/**
 * 구글 캘린더 연동 — 예약내역을 캘린더 일정으로 만든다.
 *
 * 백엔드를 거치지 않는다. Google Identity Services 의 토큰 모델을 쓰면
 * 브라우저가 직접 구글 동의창을 띄우고 1시간짜리 액세스 토큰을 받아,
 * 그 토큰으로 Calendar API 를 호출할 수 있다. 그래서 클라이언트 보안 비밀도,
 * 서버에 토큰을 보관할 일도 없다. 필요한 건 클라이언트 ID 하나뿐이다.
 *
 * 우리가 만든 일정은 제목 끝에 "(AI작성)" 이 붙는다. 다시 넣을 때는 그 표시가
 * 붙은 것만 지우고 새로 만들기 때문에, 손으로 만든 일정은 건드리지 않는다.
 *
 * window.TennisCal 로 화면(history.js)이 쓸 것만 내보낸다.
 */
(function () {
  'use strict';

  var SCOPE = 'https://www.googleapis.com/auth/calendar.events';
  var CAL_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  var MARK = '(AI작성)';
  var TZ = 'Asia/Seoul';

  var $ = function (id) { return document.getElementById(id); };
  var token = null;          // { value, expiresAt }

  /* ── 토큰 ─────────────────────────────────────────────── */
  function haveToken() {
    return token && token.value && token.expiresAt > Date.now() + 30000;
  }

  /**
   * 액세스 토큰을 얻는다. 이미 구글에 로그인돼 있고 전에 동의했다면
   * 창이 잠깐 떴다 사라지고, 아니면 로그인·동의창이 뜬다.
   */
  function getToken(clientId) {
    if (haveToken()) return Promise.resolve(token.value);
    return new Promise(function (resolve, reject) {
      if (!window.google || !google.accounts || !google.accounts.oauth2) {
        return reject(new Error('구글 스크립트를 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.'));
      }
      if (!clientId) return reject(new Error('구글 클라이언트 ID 를 입력하고 설정을 저장하세요.'));

      var client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: function (res) {
          if (res && res.access_token) {
            token = { value: res.access_token, expiresAt: Date.now() + (res.expires_in || 3600) * 1000 };
            resolve(token.value);
          } else {
            reject(new Error((res && res.error_description) || '구글 인증을 받지 못했습니다.'));
          }
        },
        error_callback: function (err) {
          reject(new Error((err && err.message) || '구글 인증 창이 닫혔습니다.'));
        },
      });
      client.requestAccessToken();
    });
  }

  function calApi(path, opts) {
    opts = opts || {};
    return fetch(CAL_API + (path || ''), {
      method: opts.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + token.value,
        'Content-Type': 'application/json',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (res.status === 204) return {};
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var m = (data.error && (data.error.message || data.error.status)) || ('HTTP ' + res.status);
          throw new Error(m);
        }
        return data;
      });
    });
  }

  /* ── 예약 한 건 → 캘린더 일정 ─────────────────────────── */

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

  function buildEvent(row, opts) {
    var t = timeRange(row.use_time);
    if (!t || !row.use_date) return null;
    var date = String(row.use_date).slice(0, 10);
    var court = courtOf(row.facility);

    // 설명은 사이트 표의 원본 칸을 그대로 쓴다 — 나중에 대조하기 좋다
    var cells = (row.raw && row.raw.cells) || [];
    var desc = cells.length
      ? cells.join('  ')
      : [row.reserve_no, row.facility, date + ' (' + row.use_time + ')',
         row.team, (row.people || '') + '명', row.status].filter(Boolean).join('  ');

    return {
      summary: (opts.titlePrefix || '테니슈웅 (대치유수지)') + '-' + court + ' ' + MARK,
      description: desc,
      visibility: 'private',
      start: { dateTime: date + 'T' + t[0] + ':00', timeZone: TZ },
      end: { dateTime: date + 'T' + t[1] + ':00', timeZone: TZ },
      attendees: (opts.guests || []).map(function (e) { return { email: e }; }),
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    };
  }

  /* ── 실행 ─────────────────────────────────────────────── */

  /**
   * @param rows   화면이 이미 걸러 둔 예약 목록 (기간 · 체크 적용된 것)
   * @param opts   { clientId, titlePrefix, guests, from, to, log }
   */
  function sync(rows, opts) {
    var log = opts.log || function () {};

    return getToken(opts.clientId).then(function () {
      // 지울 범위는 기간 필터와 같게 잡는다
      var qs = '?singleEvents=true&maxResults=2500'
        + '&timeMin=' + encodeURIComponent(opts.from + 'T00:00:00+09:00')
        + '&timeMax=' + encodeURIComponent(opts.to + 'T23:59:59+09:00')
        + '&q=' + encodeURIComponent(MARK);
      log('기존 ' + MARK + ' 일정을 확인합니다...');
      return calApi(qs);
    }).then(function (data) {
      // q 는 부분 일치라 넓게 잡히므로, 제목에 표시가 있는 것만 고른다
      var mine = (data.items || []).filter(function (e) {
        return e.summary && e.summary.indexOf(MARK) >= 0;
      });
      log('지울 일정 ' + mine.length + '건');

      return mine.reduce(function (chain, e) {
        return chain.then(function () {
          return calApi('/' + encodeURIComponent(e.id), { method: 'DELETE' })
            .then(function () { log('  삭제 ' + e.summary); })
            .catch(function (err) { log('  ✗ 삭제 실패 ' + e.summary + ' — ' + err.message); });
        });
      }, Promise.resolve());
    }).then(function () {
      var events = rows.map(function (r) { return buildEvent(r, opts); }).filter(Boolean);
      log('추가할 일정 ' + events.length + '건');

      var made = 0;
      return events.reduce(function (chain, ev) {
        return chain.then(function () {
          return calApi('?sendUpdates=none', { method: 'POST', body: ev })
            .then(function () {
              made++;
              log('  ✓ ' + ev.summary + '  ' + ev.start.dateTime.slice(0, 16).replace('T', ' '));
            })
            .catch(function (err) { log('  ✗ ' + ev.summary + ' — ' + err.message); });
        });
      }, Promise.resolve()).then(function () { return { created: made, total: events.length }; });
    });
  }

  window.TennisCal = { sync: sync, buildEvent: buildEvent, courtOf: courtOf, timeRange: timeRange, MARK: MARK };
})();
