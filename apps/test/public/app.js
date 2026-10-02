/**
 * Hermes 대화형 AI — 로컬 Hermes API 서버에 직접 붙는다.
 *
 * 왜 브라우저가 직접 부르는가
 *   Hermes 는 내 PC의 127.0.0.1 에서만 듣는다. 서버(Lambda)를 거치면
 *   그 서버에서 내 PC로 들어올 길이 없다. 브라우저는 같은 PC에 있으니
 *   직접 부르는 것이 유일하면서도 가장 단순한 길이다.
 *
 * 대화 기억
 *   Hermes 의 /v1/responses 는 previous_response_id 를 주면 앞 대화를
 *   서버 쪽에서 이어준다. 그래서 전체 대화를 매번 올려보내지 않아도 된다.
 *   브라우저에는 "어떤 대화가 있었는지"와 마지막 response id 만 남긴다.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var CFG_KEY = 'hermes-cfg';
  var CHATS_KEY = 'hermes-chats';

  var cfg = load(CFG_KEY, { url: 'http://127.0.0.1:8642', key: '', model: '' });
  var chats = load(CHATS_KEY, []);
  var cur = null;

  function load(k, dflt) {
    try { return JSON.parse(localStorage.getItem(k)) || dflt; } catch (e) { return dflt; }
  }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 사생활 보호 모드 등 */ }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /** 마크다운을 전부 렌더하진 않는다. 코드와 강조만 읽히면 대화에는 충분하다. */
  function lite(md) {
    return esc(md)
      .replace(/```(\w*)\n([\s\S]*?)```/g, function (_, l, c) { return '<pre><code>' + c.replace(/\n$/, '') + '</code></pre>'; })
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  /* ── Hermes 호출 ──────────────────────────────────────── */

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (cfg.key) h.Authorization = 'Bearer ' + cfg.key;
    if (cur && cur.id) h['X-Hermes-Session-Id'] = cur.id;
    return h;
  }

  function health() {
    return fetch(cfg.url.replace(/\/+$/, '') + '/health', { headers: headers() })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  /**
   * /v1/responses 로 보낸다. previous_response_id 가 있으면 Hermes 가
   * 앞 대화를 이어받는다 — 이것이 "메모리"의 실체다.
   */
  function send(text) {
    var body = {
      input: text,
      store: true,
    };
    if (cfg.model) body.model = cfg.model;
    if (cur.lastId) body.previous_response_id = cur.lastId;

    return fetch(cfg.url.replace(/\/+$/, '') + '/v1/responses', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!r.ok) throw new Error((j && (j.error && j.error.message || j.error)) || ('HTTP ' + r.status + ' — ' + t.slice(0, 200)));
        return j;
      });
    });
  }

  /** 응답 본문에서 글자만 뽑아낸다 (형태가 버전마다 조금씩 다르다) */
  function textOf(j) {
    if (!j) return '';
    if (typeof j.output_text === 'string' && j.output_text) return j.output_text;
    var out = [];
    (j.output || []).forEach(function (o) {
      (o.content || []).forEach(function (c) { if (c.text) out.push(c.text); });
    });
    if (out.length) return out.join('\n');
    if (j.choices && j.choices[0]) return (j.choices[0].message || {}).content || '';
    return '';
  }

  /* ── 대화 관리 ────────────────────────────────────────── */

  function newChat() {
    cur = { id: 'c' + Date.now(), title: '새 대화', lastId: null, msgs: [] };
    chats.unshift(cur);
    save(CHATS_KEY, chats);
    renderList();
    renderLog();
  }

  function pick(id) {
    var c = chats.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    cur = c;
    renderList();
    renderLog();
  }

  function renderList() {
    if (!chats.length) { $('chatList').innerHTML = '<div class="empty">대화가 없습니다</div>'; return; }
    $('chatList').innerHTML = chats.map(function (c) {
      return '<div class="chat' + (cur && c.id === cur.id ? ' on' : '') + '" data-id="' + c.id + '">'
        + '<span class="chat-t">' + esc(c.title) + '</span>'
        + '<button class="chat-x" data-del="' + c.id + '" title="삭제">×</button>'
        + '</div>';
    }).join('');
  }

  function renderLog() {
    $('title').textContent = cur ? cur.title : '새 대화';
    $('memo').textContent = cur && cur.lastId ? '🧠 이어지는 대화' : '';
    if (!cur || !cur.msgs.length) {
      $('log').innerHTML = document.getElementById('log').dataset.hello || '';
      if (!$('log').innerHTML) $('log').innerHTML = '<div class="hello"><p>메시지를 입력해 시작하세요.</p></div>';
      return;
    }
    $('log').innerHTML = cur.msgs.map(function (m) {
      return '<div class="msg ' + m.role + '">'
        + '<div class="who">' + (m.role === 'user' ? '나' : 'Hermes') + '</div>'
        + '<div class="bubble">' + (m.role === 'user' ? esc(m.text) : lite(m.text)) + '</div>'
        + '</div>';
    }).join('');
    $('log').scrollTop = $('log').scrollHeight;
  }

  function push(role, text) {
    cur.msgs.push({ role: role, text: text });
    if (cur.msgs.length === 1) cur.title = text.slice(0, 30) || '새 대화';
    save(CHATS_KEY, chats);
    renderLog();
  }

  function go() {
    var t = $('input').value.trim();
    if (!t) return;
    if (!cur) newChat();
    $('input').value = '';
    $('input').style.height = 'auto';
    push('user', t);

    $('send').disabled = true;
    $('log').insertAdjacentHTML('beforeend',
      '<div class="msg assistant" id="pending"><div class="who">Hermes</div><div class="bubble typing">생각하는 중…</div></div>');
    $('log').scrollTop = $('log').scrollHeight;

    send(t).then(function (j) {
      if (j && j.id) cur.lastId = j.id;      // 다음 턴에 이어붙일 실마리
      var out = textOf(j) || '(빈 응답)';
      var p = $('pending'); if (p) p.remove();
      push('assistant', out);
    }).catch(function (e) {
      var p = $('pending'); if (p) p.remove();
      push('assistant', '⚠️ ' + e.message
        + '\n\n`hermes gateway` 가 켜져 있는지, 좌측 하단 **연결 설정**의 주소·키가 맞는지 확인하세요.');
    }).then(function () {
      $('send').disabled = false;
      $('input').focus();
    });
  }

  /* ── 설정 ─────────────────────────────────────────────── */

  function openCfg() {
    $('cfgUrl').value = cfg.url;
    $('cfgKey').value = cfg.key;
    $('cfgModel').value = cfg.model;
    $('cfgResult').hidden = true;
    $('cfgModal').classList.add('on');
  }

  function checkStatus() {
    health().then(function (ok) {
      $('status').textContent = ok ? '🟢 Hermes 연결됨' : '🔴 연결 안 됨';
      $('status').className = 'status ' + (ok ? 'ok' : 'ng');
    });
  }

  /* ── 바인딩 ───────────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', function () {
    $('log').dataset.hello = $('log').innerHTML;

    $('newChat').addEventListener('click', newChat);

    $('chatList').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        var id = del.dataset.del;
        chats = chats.filter(function (c) { return c.id !== id; });
        if (cur && cur.id === id) cur = chats[0] || null;
        save(CHATS_KEY, chats);
        renderList(); renderLog();
        return;
      }
      var row = e.target.closest('.chat');
      if (row) pick(row.dataset.id);
    });

    $('send').addEventListener('click', go);
    $('input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
    });
    $('input').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    });

    $('cfgBtn').addEventListener('click', openCfg);
    $('cfgClose').addEventListener('click', function () { $('cfgModal').classList.remove('on'); });
    $('cfgModal').addEventListener('click', function (e) {
      if (e.target === $('cfgModal')) $('cfgModal').classList.remove('on');
    });
    $('cfgSave').addEventListener('click', function () {
      cfg = { url: $('cfgUrl').value.trim() || 'http://127.0.0.1:8642', key: $('cfgKey').value, model: $('cfgModel').value.trim() };
      save(CFG_KEY, cfg);
      $('cfgModal').classList.remove('on');
      checkStatus();
    });
    $('cfgTest').addEventListener('click', function () {
      var box = $('cfgResult');
      box.hidden = false;
      box.textContent = '확인 중…';
      var u = ($('cfgUrl').value.trim() || 'http://127.0.0.1:8642').replace(/\/+$/, '');
      var h = { 'Content-Type': 'application/json' };
      if ($('cfgKey').value) h.Authorization = 'Bearer ' + $('cfgKey').value;
      fetch(u + '/v1/models', { headers: h })
        .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, s: r.status, t: t }; }); })
        .then(function (r) {
          box.textContent = r.ok
            ? '✅ 연결 성공 — ' + r.t.slice(0, 200)
            : '❌ HTTP ' + r.s + ' — ' + r.t.slice(0, 200);
        })
        .catch(function (e) {
          box.textContent = '❌ 연결 실패 — ' + e.message
            + '\n\nhermes gateway 가 켜져 있는지, .env 의 API_SERVER_CORS_ORIGINS 에 이 주소('
            + location.origin + ')가 들어있는지 확인하세요.';
        });
    });

    if (chats.length) { cur = chats[0]; }
    renderList();
    renderLog();
    checkStatus();
  });
})();
