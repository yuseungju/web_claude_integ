const API_BASE = 'https://nynhvk2xl3.execute-api.ap-southeast-2.amazonaws.com';

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || 'null'); }

async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  return res;
}

if (!getToken()) {
  document.getElementById('loadMsg').textContent = '로그인이 필요합니다.';
} else {
  loadFolders();
}

let foldersData = [];

async function loadFolders() {
  try {
    const res = await api('/bookmarks');
    if (!res.ok) throw new Error();
    const data = await res.json();
    foldersData = data.folders || [];
    renderFolders();
    document.getElementById('loadMsg').style.display = 'none';
    document.getElementById('pageContent').style.display = '';
  } catch {
    document.getElementById('loadMsg').textContent = '데이터를 불러오지 못했습니다.';
  }
}

function renderFolders() {
  const el = document.getElementById('folderList');
  if (!foldersData.length) {
    el.innerHTML = '<p style="font-size:.78rem;color:var(--text-muted);padding:.3rem 0">아직 폴더가 없습니다.</p>';
    return;
  }
  el.innerHTML = foldersData.map(f => `
    <div class="folder-item" id="folder-${f.id}">
      <div class="folder-row" onclick="toggleFolder(${f.id})">
        <span class="folder-toggle" id="ftog-${f.id}">▶</span>
        <span class="folder-name">📁 ${escHtml(f.name)}</span>
        <span class="folder-count">${f.links.length}개</span>
        <button class="btn-del-folder" onclick="event.stopPropagation();deleteFolder(${f.id})" title="폴더 삭제">🗑</button>
      </div>
      <div class="folder-body" id="fbody-${f.id}">
        ${f.links.length
          ? f.links.map(l => `
            <div class="link-item" id="link-${l.id}">
              <div class="link-title">
                <a href="${l.url.replace(/"/g,'&quot;')}" target="_blank" rel="noopener" title="${escHtml(l.url)}">${escHtml(l.title || l.url)}</a>
              </div>
              <button class="btn-del-link" onclick="deleteLink(${l.id}, ${f.id})" title="삭제">✕</button>
            </div>`).join('')
          : '<p class="empty-folder">링크가 없습니다.</p>'}
        <div class="add-link-row">
          <input type="url" class="link-input link-url-in" id="lurl-${f.id}" placeholder="https://..." />
          <input type="text" class="link-input link-title-in" id="ltitle-${f.id}" placeholder="제목(선택)" />
          <button class="btn-add-link" onclick="addLink(${f.id})">+ 추가</button>
        </div>
      </div>
    </div>`).join('');
}

function toggleFolder(id) {
  const body = document.getElementById(`fbody-${id}`);
  const tog  = document.getElementById(`ftog-${id}`);
  const open = body.classList.toggle('open');
  tog.classList.toggle('open', open);
}

function showNewFolderRow() {
  document.getElementById('newFolderRow').style.display = 'flex';
  document.getElementById('newFolderName').focus();
}
function hideNewFolderRow() {
  document.getElementById('newFolderRow').style.display = 'none';
  document.getElementById('newFolderName').value = '';
}

async function createFolder() {
  const name = document.getElementById('newFolderName').value.trim();
  if (!name) { showToast('폴더 이름을 입력하세요.', 'error'); return; }
  try {
    const res = await api('/bookmarks/folders', { method: 'POST', body: JSON.stringify({ name }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    foldersData.push(data.folder);
    renderFolders();
    hideNewFolderRow();
    showToast(`"${name}" 폴더가 생성됐습니다.`, 'success');
  } catch (e) { showToast(e.message || '생성 실패', 'error'); }
}

async function deleteFolder(id) {
  const f = foldersData.find(x => x.id === id);
  if (!confirm(`"${f?.name}" 폴더와 링크 ${f?.links.length}개를 모두 삭제하시겠습니까?`)) return;
  try {
    const res = await api(`/bookmarks/folders/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    foldersData = foldersData.filter(x => x.id !== id);
    renderFolders();
    showToast('폴더가 삭제됐습니다.', 'success');
  } catch { showToast('삭제 실패', 'error'); }
}

async function addLink(folderId) {
  const url   = document.getElementById(`lurl-${folderId}`)?.value.trim();
  const title = document.getElementById(`ltitle-${folderId}`)?.value.trim();
  if (!url || !/^https?:\/\//i.test(url)) { showToast('올바른 URL을 입력하세요.', 'error'); return; }
  try {
    const res = await api(`/bookmarks/folders/${folderId}/links`, {
      method: 'POST', body: JSON.stringify({ url, title }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const folder = foldersData.find(f => f.id === folderId);
    if (folder) folder.links.push(data.link);
    renderFolders();
    // 해당 폴더 펼치기
    const body = document.getElementById(`fbody-${folderId}`);
    const tog  = document.getElementById(`ftog-${folderId}`);
    if (body && !body.classList.contains('open')) { body.classList.add('open'); tog?.classList.add('open'); }
    showToast('링크가 추가됐습니다.', 'success');
  } catch (e) { showToast(e.message || '추가 실패', 'error'); }
}

async function deleteLink(linkId, folderId) {
  try {
    const res = await api(`/bookmarks/links/${linkId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    const folder = foldersData.find(f => f.id === folderId);
    if (folder) folder.links = folder.links.filter(l => l.id !== linkId);
    renderFolders();
    const body = document.getElementById(`fbody-${folderId}`);
    const tog  = document.getElementById(`ftog-${folderId}`);
    if (body) { body.classList.add('open'); tog?.classList.add('open'); }
    showToast('링크가 삭제됐습니다.', 'success');
  } catch { showToast('삭제 실패', 'error'); }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let toastTimer;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = `toast ${type}`, 2800);
}

document.getElementById('newFolderName')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') createFolder();
  if (e.key === 'Escape') hideNewFolderRow();
});
