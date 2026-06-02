const API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || 'null'); }

function requireAuth() {
  if (!getToken()) { openLoginModal(); return false; }
  return true;
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = 'issues.html';
}

async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  return res;
}

function renderHeader(containerSelector) {
  const user = getUser();
  const el = document.querySelector(containerSelector);
  if (!el) return;
  if (user) {
    el.innerHTML = `
      <div class="header-user">
        <a href="mypage.html" class="header-username header-mypage-link">${user.name}</a>
        <button class="btn-logout" onclick="logout()">로그아웃</button>
      </div>`;
  } else {
    el.innerHTML = `<button class="btn-header-login" onclick="openLoginModal()">로그인 / 회원가입</button>`;
  }
}

/* ── 로그인 모달 ── */
let _mEmailChecked = false;

function openLoginModal() {
  _ensureModalStyles();
  _ensureModal();
  document.getElementById('authModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLoginModal() {
  const m = document.getElementById('authModal');
  if (m) m.classList.remove('open');
  document.body.style.overflow = '';
}

function _ensureModalStyles() {
  if (document.getElementById('authModalStyles')) return;
  const s = document.createElement('style');
  s.id = 'authModalStyles';
  s.textContent = `
    .modal-overlay{position:fixed;inset:0;z-index:900;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.48);padding:1rem}
    .modal-overlay.open{display:flex}
    .modal-backdrop-click{position:absolute;inset:0}
    .modal-box{background:var(--bg-card);border-radius:var(--radius-md);box-shadow:0 8px 32px rgba(0,0,0,.18);padding:1.75rem;width:100%;max-width:400px;position:relative;max-height:90vh;overflow-y:auto;z-index:1}
    .modal-close{position:absolute;top:.6rem;right:.6rem;background:none;border:none;font-size:1.05rem;cursor:pointer;color:var(--text-muted);padding:.2rem .48rem;border-radius:var(--radius-sm);line-height:1;transition:background .12s}
    .modal-close:hover{background:var(--border)}
    .m-tabs{display:flex;margin-bottom:1.25rem;border-bottom:2px solid var(--border)}
    .m-tab{flex:1;text-align:center;padding:.5rem;font-size:.88rem;font-weight:700;cursor:pointer;color:var(--text-muted);border-bottom:2.5px solid transparent;margin-bottom:-2px;transition:all .15s;user-select:none}
    .m-tab.active{color:var(--primary);border-bottom-color:var(--primary)}
    .m-form{display:flex;flex-direction:column;gap:.8rem}
    .m-field{display:flex;flex-direction:column;gap:.25rem}
    .m-field label{font-size:.75rem;font-weight:600;color:var(--text-secondary)}
    .m-field input{padding:.6rem .8rem;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:.9rem;font-family:var(--font-sans);outline:none;background:var(--bg);color:var(--text-primary);transition:border-color .15s;width:100%;box-sizing:border-box}
    .m-field input:focus{border-color:var(--primary);background:#fff}
    .m-field input.ok{border-color:var(--success)}
    .m-field input.err{border-color:var(--danger)}
    .m-hint{font-size:.7rem}
    .m-hint.ok{color:#059669}
    .m-hint.err{color:var(--danger)}
    .m-email-row{display:flex;gap:.35rem}
    .m-email-row input{flex:1;min-width:0}
    .m-btn-check{padding:0 .72rem;white-space:nowrap;flex-shrink:0;border:1.5px solid var(--primary);background:#fff;border-radius:var(--radius-sm);font-size:.74rem;font-weight:700;cursor:pointer;color:var(--primary);transition:all .15s;font-family:var(--font-sans)}
    .m-btn-check:hover{background:var(--primary);color:#fff}
    .m-pw-rules{display:none;flex-wrap:wrap;gap:.28rem;margin-top:.1rem}
    .m-pw-rules.show{display:flex}
    .m-pw-rule{font-size:.65rem;padding:.08rem .36rem;border-radius:100px;background:#e2e8f0;color:var(--text-muted);transition:all .15s}
    .m-pw-rule.pass{background:var(--success-light);color:#065f46}
    .m-btn-submit{width:100%;padding:.68rem;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-sm);font-size:.9rem;font-weight:700;cursor:pointer;transition:background .15s;margin-top:.2rem;font-family:var(--font-sans);min-height:42px}
    .m-btn-submit:hover:not(:disabled){background:var(--primary-dark)}
    .m-btn-submit:disabled{opacity:.6;cursor:not-allowed}
    .m-msg{font-size:.8rem;text-align:center;padding:.42rem .6rem;border-radius:var(--radius-sm);display:none;margin-bottom:.4rem}
    .m-msg.error{background:var(--danger-light);color:#991b1b;display:block}
    .m-msg.success{background:var(--success-light);color:#065f46;display:block}
    @media(max-width:480px){.modal-box{padding:1.25rem}.m-field input{font-size:16px}}
  `;
  document.head.appendChild(s);
}

function _ensureModal() {
  if (document.getElementById('authModal')) return;
  const div = document.createElement('div');
  div.id = 'authModal';
  div.className = 'modal-overlay';
  div.innerHTML = `
    <div class="modal-backdrop-click" onclick="closeLoginModal()"></div>
    <div class="modal-box">
      <button class="modal-close" onclick="closeLoginModal()">✕</button>
      <div style="text-align:center;margin-bottom:1rem">
        <div style="font-size:1.7rem;margin-bottom:.25rem">📋</div>
        <div style="font-size:1rem;font-weight:800;color:var(--primary)">이슈보드</div>
      </div>
      <div class="m-tabs">
        <div class="m-tab active" id="mTabLogin" onclick="modalSwitchTab('login')">로그인</div>
        <div class="m-tab" id="mTabRegister" onclick="modalSwitchTab('register')">회원가입</div>
      </div>
      <div id="mMsg" class="m-msg"></div>
      <form id="mLoginForm" class="m-form" onsubmit="doModalLogin(event)">
        <div class="m-field">
          <label>이메일</label>
          <input type="email" id="mLoginEmail" placeholder="example@email.com" required autocomplete="email" />
        </div>
        <div class="m-field">
          <label>비밀번호</label>
          <input type="password" id="mLoginPw" placeholder="비밀번호" required autocomplete="current-password" />
        </div>
        <button type="submit" class="m-btn-submit" id="mBtnLogin">로그인</button>
      </form>
      <form id="mRegisterForm" class="m-form" style="display:none" onsubmit="doModalRegister(event)">
        <div class="m-field">
          <label>이름</label>
          <input type="text" id="mRegName" placeholder="홍길동" required autocomplete="name" />
        </div>
        <div class="m-field">
          <label>이메일</label>
          <div class="m-email-row">
            <input type="email" id="mRegEmail" placeholder="example@email.com" required oninput="mResetEmailCheck()" autocomplete="email" />
            <button type="button" class="m-btn-check" onclick="mCheckEmailDup()">중복확인</button>
          </div>
          <span class="m-hint" id="mEmailHint"></span>
        </div>
        <div class="m-field">
          <label>비밀번호</label>
          <input type="password" id="mRegPw" placeholder="8자 이상" required oninput="mUpdatePwRules()" autocomplete="new-password" />
          <div class="m-pw-rules" id="mPwRules">
            <span class="m-pw-rule" id="mr-len">8자 이상</span>
            <span class="m-pw-rule" id="mr-upper">대문자</span>
            <span class="m-pw-rule" id="mr-lower">소문자</span>
            <span class="m-pw-rule" id="mr-num">숫자</span>
          </div>
        </div>
        <div class="m-field">
          <label>비밀번호 확인</label>
          <input type="password" id="mRegPwConfirm" placeholder="비밀번호 재입력" required oninput="mCheckPwMatch()" autocomplete="new-password" />
          <span class="m-hint" id="mPwHint"></span>
        </div>
        <button type="submit" class="m-btn-submit" id="mBtnRegister">회원가입</button>
      </form>
    </div>
  `;
  document.body.appendChild(div);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLoginModal(); });
}

function modalSwitchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('mLoginForm').style.display    = isLogin ? '' : 'none';
  document.getElementById('mRegisterForm').style.display = isLogin ? 'none' : '';
  document.getElementById('mTabLogin').classList.toggle('active', isLogin);
  document.getElementById('mTabRegister').classList.toggle('active', !isLogin);
  _mClearMsg();
}
function _mShowMsg(text, type) {
  const el = document.getElementById('mMsg');
  if (el) { el.textContent = text; el.className = 'm-msg ' + type; }
}
function _mClearMsg() {
  const el = document.getElementById('mMsg');
  if (el) { el.textContent = ''; el.className = 'm-msg'; }
}

function mUpdatePwRules() {
  const pw = document.getElementById('mRegPw')?.value || '';
  document.getElementById('mPwRules')?.classList.toggle('show', pw.length > 0);
  document.getElementById('mr-len')?.classList.toggle('pass', pw.length >= 8);
  document.getElementById('mr-upper')?.classList.toggle('pass', /[A-Z]/.test(pw));
  document.getElementById('mr-lower')?.classList.toggle('pass', /[a-z]/.test(pw));
  document.getElementById('mr-num')?.classList.toggle('pass', /[0-9]/.test(pw));
  mCheckPwMatch();
}
function mCheckPwMatch() {
  const pw = document.getElementById('mRegPw')?.value || '';
  const c  = document.getElementById('mRegPwConfirm')?.value || '';
  const hint = document.getElementById('mPwHint');
  if (!hint) return;
  if (!c) { hint.className = 'm-hint'; hint.textContent = ''; return; }
  if (pw === c) { hint.className = 'm-hint ok'; hint.textContent = '비밀번호가 일치합니다.'; }
  else          { hint.className = 'm-hint err'; hint.textContent = '비밀번호가 일치하지 않습니다.'; }
}
function mResetEmailCheck() {
  _mEmailChecked = false;
  const hint = document.getElementById('mEmailHint');
  const inp  = document.getElementById('mRegEmail');
  if (hint) { hint.className = 'm-hint'; hint.textContent = ''; }
  if (inp)  inp.className = '';
}
async function mCheckEmailDup() {
  const email = document.getElementById('mRegEmail')?.value.trim();
  const hint  = document.getElementById('mEmailHint');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (hint) { hint.className = 'm-hint err'; hint.textContent = '올바른 이메일을 입력하세요.'; }
    return;
  }
  try {
    const res = await fetch(API + '/auth/check-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    const inp = document.getElementById('mRegEmail');
    if (data.available) {
      _mEmailChecked = true;
      if (hint) { hint.className = 'm-hint ok'; hint.textContent = '사용 가능한 이메일입니다.'; }
      if (inp)  inp.className = 'ok';
    } else {
      _mEmailChecked = false;
      if (hint) { hint.className = 'm-hint err'; hint.textContent = '이미 사용 중인 이메일입니다.'; }
      if (inp)  inp.className = 'err';
    }
  } catch {
    if (hint) { hint.className = 'm-hint err'; hint.textContent = '확인 중 오류가 발생했습니다.'; }
  }
}

async function doModalLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('mBtnLogin');
  btn.disabled = true; btn.textContent = '로그인 중...';
  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('mLoginEmail').value,
        password: document.getElementById('mLoginPw').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) { _mShowMsg(data.error || '로그인 실패', 'error'); return; }
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    closeLoginModal();
    window.location.reload();
  } catch { _mShowMsg('서버 연결 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '로그인'; }
}

async function doModalRegister(e) {
  e.preventDefault();
  if (!_mEmailChecked) { _mShowMsg('이메일 중복확인을 해주세요.', 'error'); return; }
  const pw  = document.getElementById('mRegPw').value;
  const pw2 = document.getElementById('mRegPwConfirm').value;
  if (pw !== pw2) { _mShowMsg('비밀번호가 일치하지 않습니다.', 'error'); return; }
  if (pw.length < 8) { _mShowMsg('비밀번호는 8자 이상이어야 합니다.', 'error'); return; }
  const btn = document.getElementById('mBtnRegister');
  btn.disabled = true; btn.textContent = '처리 중...';
  try {
    const res = await fetch(API + '/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('mRegEmail').value,
        password: pw,
        name: document.getElementById('mRegName').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) { _mShowMsg(data.error || '회원가입 실패', 'error'); return; }
    _mShowMsg('회원가입 성공! 로그인해주세요.', 'success');
    setTimeout(() => modalSwitchTab('login'), 1500);
  } catch { _mShowMsg('서버 연결 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '회원가입'; }
}
