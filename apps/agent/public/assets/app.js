/* /agent 공통 스크립트.
   서버 주소 고르기와 사용자 이름은 화면마다 똑같이 필요하다. 복붙하면 한쪽만
   고치게 되므로 여기 모은다. sap-local 과 같은 localStorage 키를 써서,
   한 화면에서 입력하면 다른 화면에도 그대로 적용된다. */
(function (global) {
  var AWS_API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';

  var Agent = {
    api: AWS_API,

    /** 저장된 설정을 읽어 반영한다. 화면마다 맨 먼저 부른다. */
    init: function (opts) {
      opts = opts || {};
      var who = opts.who, apiSel = opts.api;
      try {
        if (who) { var w = localStorage.getItem('sapUserKey'); if (w) who.value = w; }
        if (apiSel) { var a = localStorage.getItem('sapApi'); if (a) apiSel.value = a; }
      } catch (e) {}

      if (apiSel) {
        var apply = function () {
          Agent.api = apiSel.value === 'local' ? location.origin : AWS_API;
          try { localStorage.setItem('sapApi', apiSel.value); } catch (e) {}
          if (opts.onApiChange) opts.onApiChange();
        };
        apply();
        apiSel.addEventListener('change', apply);
      }
      if (who) {
        who.addEventListener('change', function () { Agent.userKey(who); });
      }
      Agent._who = who;
      return Agent;
    },

    /** 서버가 받는 형식(영숫자·._@-, 3~64자)으로 맞춘다. 비었으면 익명으로 남긴다. */
    userKey: function (who) {
      who = who || Agent._who;
      var v = who ? who.value.trim().replace(/\s+/g, '-') : '';
      try { if (who) localStorage.setItem('sapUserKey', who.value.trim()); } catch (e) {}
      return /^[A-Za-z0-9._@-]{3,64}$/.test(v) ? v : 'local-test';
    },

    /** 서버 호출. 오류를 던지므로 부르는 쪽은 catch 한 곳에서 처리하면 된다. */
    call: function (path, opts) {
      opts = opts || {};
      var method = opts.method || 'GET';
      var url = Agent.api + path;
      var init = { method: method, headers: { 'Content-Type': 'application/json' } };

      if (method === 'GET') {
        var q = Object.assign({ userKey: Agent.userKey() }, opts.query || {});
        var parts = [];
        for (var k in q) if (q[k] !== undefined && q[k] !== '') {
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k]));
        }
        url += (url.indexOf('?') < 0 ? '?' : '&') + parts.join('&');
      } else {
        init.body = JSON.stringify(Object.assign({ userKey: Agent.userKey() }, opts.body || {}));
      }

      return fetch(url, init).then(function (r) {
        // 게이트웨이가 만든 오류는 JSON 이 아니다. 상태코드라도 남겨야 원인을 안다.
        return r.json()
          .catch(function () { return { error: 'HTTP ' + r.status }; })
          .then(function (d) {
            if (d && d.error) {
              var err = new Error(d.error);
              err.status = r.status;
              err.payload = d;
              throw err;
            }
            return d;
          });
      });
    },

    /** 머리말의 공통 조각. 화면마다 같은 마크업을 쓰려고 뽑았다. */
    barHtml: function () {
      return '<input class="who" id="who" placeholder="내 이름/이메일" spellcheck="false"'
           + ' title="저장한 글의 작성자로 기록됩니다">'
           + '<select id="api" title="어느 서버를 부를지">'
           + '<option value="aws">서버: AWS</option>'
           + '<option value="local">서버: 로컬</option></select>';
    },

    fmtTime: function (iso) {
      return String(iso || '').slice(0, 16).replace('T', ' ');
    },
  };

  global.Agent = Agent;
})(window);
