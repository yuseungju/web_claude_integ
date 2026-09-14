// Auth header injection for feature pages.
// Provides login/register UI identical to the main page.

const AH_API = 'https://nynhvk2xl3.execute-api.ap-southeast-2.amazonaws.com';
let _ahEmailChecked = false;

document.addEventListener('DOMContentLoaded', () => {
  _ahInject();
  updateAuthUI();
});

function _ahInject() {
  const inner = document.querySelector('.header-inner');
  if (!inner || document.getElementById('authArea')) return;

  const div = document.createElement('div');
  div.id = 'authArea';
  inner.appendChild(div);

  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="authModal">
      <div class="modal-box">
        <div class="modal-header">
          <span class="modal-title">계정</span>
          <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <div class="modal-tabs">
          <div class="modal-tab active" id="tabLogin" onclick="switchTab('login')">로그인</div>
          <div class="modal-tab" id="tabRegister" onclick="switchTab('register')">회원가입</div>
        </div>
        <div id="msgBox" class="modal-msg"></div>
        <form class="modal-form" id="loginForm" onsubmit="doLogin(event)">
          <div class="input-wrap"><input type="email" id="loginEmail" placeholder="이메일" required /></div>
          <div class="input-wrap"><input type="password" id="loginPw" placeholder="비밀번호" required /></div>
          <button type="submit" class="modal-submit" id="loginBtn">로그인</button>
        </form>
        <form class="modal-form" id="registerForm" style="display:none" onsubmit="doRegister(event)">
          <div class="input-wrap"><input type="text" id="regName" placeholder="이름" required /></div>
          <div class="email-row">
            <div class="input-wrap">
              <input type="email" id="regEmail" placeholder="이메일 (아이디)" required oninput="resetEmailCheck()" />
            </div>
            <button type="button" class="btn-check-email" onclick="checkEmailDup()">중복확인</button>
          </div>
          <div class="input-hint" id="emailHint"></div>
          <div class="input-wrap">
            <input type="password" id="regPw" placeholder="비밀번호" required oninput="updatePwRules()" />
          </div>
          <div class="pw-rules" id="pwRules">
            <span class="pw-rule" id="rule-len">8자 이상</span>
            <span class="pw-rule" id="rule-upper">대문자</span>
            <span class="pw-rule" id="rule-lower">소문자</span>
            <span class="pw-rule" id="rule-num">숫자</span>
            <span class="pw-rule" id="rule-special">특수문자</span>
          </div>
          <div class="input-wrap">
            <input type="password" id="regPwConfirm" placeholder="비밀번호 확인" required oninput="checkPwMatch()" />
          </div>
          <div class="input-hint" id="pwMatchHint"></div>
          <button type="submit" class="modal-submit" id="regBtn">회원가입</button>
        </form>
      </div>
    </div>
  `);
}

/* ── Auth state ────────────────────────────────────────── */
function updateAuthUI() {
  const area = document.getElementById('authArea');
  if (!area) return;
  const user = JSON.parse(localStorage.getItem('user') || 'null');
  if (user) {
    const initial = (user.name || user.email || '?')[0].toUpperCase();
    area.innerHTML = `<div class="auth-user">
      <div class="auth-avatar">${initial}</div>
      <span class="auth-name">${user.name || user.email}</span>
      <button class="auth-logout" onclick="logout()">로그아웃</button>
    </div>`;
  } else {
    area.innerHTML = `<button class="auth-btn" onclick="openModal('login')">로그인</button>`;
  }
}

function logout() {
  localStorage.removeItem('token'); localStorage.removeItem('user');
  updateAuthUI();
}

/* ── Modal ─────────────────────────────────────────────── */
function openModal(tab) {
  document.getElementById('authModal').classList.add('open');
  switchTab(tab || 'login'); clearMsg();
}
function closeModal() {
  document.getElementById('authModal').classList.remove('open'); clearMsg();
}
function switchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('loginForm').style.display = isLogin ? '' : 'none';
  document.getElementById('registerForm').style.display = isLogin ? 'none' : '';
  document.getElementById('tabLogin').classList.toggle('active', isLogin);
  document.getElementById('tabRegister').classList.toggle('active', !isLogin);
  clearMsg();
}
function showMsg(text, type) {
  const el = document.getElementById('msgBox');
  el.textContent = text; el.className = 'modal-msg ' + type;
}
function clearMsg() {
  const el = document.getElementById('msgBox');
  el.textContent = ''; el.className = 'modal-msg';
}

/* ── Password rules ─────────────────────────────────────── */
function updatePwRules() {
  const pw = document.getElementById('regPw').value;
  document.getElementById('pwRules').classList.toggle('show', pw.length > 0);
  const rules = {
    'rule-len':     pw.length >= 8,
    'rule-upper':   /[A-Z]/.test(pw),
    'rule-lower':   /[a-z]/.test(pw),
    'rule-num':     /[0-9]/.test(pw),
    'rule-special': /[!@#$%^&*()_+\-=\[\]{}|;':",.<>?/`~]/.test(pw),
  };
  Object.entries(rules).forEach(([id, pass]) => {
    document.getElementById(id).classList.toggle('pass', pass);
  });
  checkPwMatch();
}
function checkPwMatch() {
  const pw = document.getElementById('regPw').value;
  const c  = document.getElementById('regPwConfirm').value;
  const hint = document.getElementById('pwMatchHint');
  if (!c) { hint.className = 'input-hint'; hint.textContent = ''; return; }
  if (pw === c) {
    hint.className = 'input-hint show ok'; hint.textContent = '비밀번호가 일치합니다.';
    document.getElementById('regPwConfirm').className = 'input-ok';
  } else {
    hint.className = 'input-hint show err'; hint.textContent = '비밀번호가 일치하지 않습니다.';
    document.getElementById('regPwConfirm').className = 'input-err';
  }
}

/* ── Email duplicate check ──────────────────────────────── */
function resetEmailCheck() {
  _ahEmailChecked = false;
  const hint = document.getElementById('emailHint');
  hint.className = 'input-hint'; hint.textContent = '';
  document.getElementById('regEmail').className = '';
}
async function checkEmailDup() {
  const email = document.getElementById('regEmail').value.trim();
  const hint = document.getElementById('emailHint');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    hint.className = 'input-hint show err'; hint.textContent = '올바른 이메일을 입력하세요.'; return;
  }
  try {
    const res = await fetch(AH_API + '/auth/check-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) { hint.className = 'input-hint show err'; hint.textContent = data.error || '확인 중 오류가 발생했습니다.'; return; }
    if (data.available) {
      _ahEmailChecked = true;
      hint.className = 'input-hint show ok'; hint.textContent = '사용 가능한 이메일입니다.';
      document.getElementById('regEmail').className = 'input-ok';
    } else {
      _ahEmailChecked = false;
      hint.className = 'input-hint show err'; hint.textContent = '이미 사용 중인 이메일입니다.';
      document.getElementById('regEmail').className = 'input-err';
    }
  } catch { hint.className = 'input-hint show err'; hint.textContent = '확인 중 오류가 발생했습니다.'; }
}

/* ── Login ──────────────────────────────────────────────── */
async function doLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = '로그인 중...';
  try {
    const res = await fetch(AH_API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('loginEmail').value, password: document.getElementById('loginPw').value }),
    });
    const data = await res.json();
    if (!res.ok) { showMsg(data.error || '로그인 실패', 'error'); return; }
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    closeModal(); updateAuthUI();
  } catch { showMsg('서버 연결 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '로그인'; }
}

/* ── Register ───────────────────────────────────────────── */
async function doRegister(e) {
  e.preventDefault();
  if (!_ahEmailChecked) { showMsg('이메일 중복확인을 해주세요.', 'error'); return; }
  const pw  = document.getElementById('regPw').value;
  const pw2 = document.getElementById('regPwConfirm').value;
  if (pw !== pw2) { showMsg('비밀번호가 일치하지 않습니다.', 'error'); return; }
  const btn = document.getElementById('regBtn');
  btn.disabled = true; btn.textContent = '처리 중...';
  try {
    const res = await fetch(AH_API + '/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('regEmail').value, password: pw, name: document.getElementById('regName').value }),
    });
    const data = await res.json();
    if (!res.ok) { showMsg(data.error || '회원가입 실패', 'error'); return; }
    showMsg('회원가입 성공! 로그인해주세요.', 'success');
    setTimeout(() => switchTab('login'), 1500);
  } catch { showMsg('서버 연결 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '회원가입'; }
}
