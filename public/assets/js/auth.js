const API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || 'null'); }

function requireAuth() {
  if (!getToken()) { window.location.href = '/index.html'; return false; }
  return true;
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/index.html';
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
  if (!el || !user) return;
  el.innerHTML = `
    <div class="header-user">
      <a href="mypage.html" class="header-username header-mypage-link">${user.name}</a>
      <button class="btn-logout" onclick="logout()">로그아웃</button>
    </div>`;
}
