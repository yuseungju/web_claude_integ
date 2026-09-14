/* 동영상 제작 — 목록 페이지 (게시판 형식) */

const VM_API = 'https://nynhvk2xl3.execute-api.ap-southeast-2.amazonaws.com';
function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || 'null'); }
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function vmApi(path, options = {}) {
  const token = getToken();
  return fetch(VM_API + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  });
}

const isLoggedIn = !!getToken();
const me = getUser();

let fState = { mine: false };
let curPage = 1;
const LIMIT = 30;

// ── 툴바 초기화 ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const toolbarBtns = document.getElementById('toolbarBtns');
  if (isLoggedIn) {
    toolbarBtns.innerHTML = '<button class="btn primary" id="createBtn" onclick="addInlineRow()">+ 새 프로젝트</button>';
    document.getElementById('filterToggles').innerHTML =
      `<button class="f-toggle" id="tMine" onclick="toggleFilter('mine')">내가 작성한 글</button>`;
  } else {
    toolbarBtns.innerHTML = '<span class="login-notice">🔒 로그인하면 동영상을 제작할 수 있습니다</span>';
  }

  document.getElementById('fQ').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  loadList(1);
});

// ── 필터 ───────────────────────────────────────────────────
function toggleFilter(key) {
  fState[key] = !fState[key];
  document.getElementById('tMine')?.classList.toggle('on', fState.mine);
  doSearch();
}
function doSearch() { loadList(1); }
function resetFilters() {
  document.getElementById('fQ').value = '';
  fState = { mine: false };
  document.getElementById('tMine')?.classList.remove('on');
  loadList(1);
}

// ── 목록 로드 ─────────────────────────────────────────────
async function loadList(page = 1) {
  curPage = page;
  document.getElementById('tableWrap').innerHTML = '<div class="loading">불러오는 중...</div>';
  document.getElementById('pagination').innerHTML = '';
  try {
    const res = await vmApi('/video-maker/projects');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { projects = [], isOwner } = await res.json();

    // 검색 필터
    const q = document.getElementById('fQ').value.trim().toLowerCase();
    let filtered = projects;
    if (q) filtered = filtered.filter(p => (p.title || '').toLowerCase().includes(q));
    if (fState.mine && isLoggedIn) filtered = filtered.filter(p => p.author_name === me?.name);

    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / LIMIT));
    const paged = filtered.slice((page - 1) * LIMIT, page * LIMIT);

    renderTable(paged, page, total, isOwner);
    renderPagination(page, pages, total);
  } catch (e) {
    document.getElementById('tableWrap').innerHTML =
      `<div class="empty-state"><span class="ei">⚠️</span><p>불러오기 실패: ${escHtml(e.message)}</p></div>`;
  }
}

// ── 테이블 렌더링 ─────────────────────────────────────────
function renderTable(projects, page, total, isOwner) {
  const offset = (page - 1) * LIMIT;
  if (!projects.length) {
    document.getElementById('tableWrap').innerHTML =
      `<div class="empty-state"><span class="ei">🎬</span><p>${isLoggedIn ? '아직 프로젝트가 없습니다.' : '게시된 동영상 프로젝트가 없습니다.'}</p></div>`;
    return;
  }
  document.getElementById('tableWrap').innerHTML = `
    <div class="table-scroll-wrap">
      <table class="vm-list-table">
        <colgroup>
          <col style="width:42px">
          <col>
          <col style="width:80px">
          <col style="width:96px">
          <col style="width:68px">
          <col style="width:100px">
        </colgroup>
        <thead>
          <tr>
            <th class="col-no">번호</th>
            <th>제목</th>
            <th>작성자</th>
            <th>상태</th>
            <th>수정일</th>
            <th style="text-align:right">작업</th>
          </tr>
        </thead>
        <tbody id="vmBody">
          ${projects.map((p, i) => renderRow(p, total - offset - i)).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderRow(p, num) {
  const date = p.updated_at ? new Date(p.updated_at).toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' }) : '-';
  const isMyPost = isLoggedIn && me && p.author_name === me.name;
  const badge = p.is_published
    ? '<span class="badge badge-done">게시됨</span>'
    : '<span class="badge badge-draft">임시저장</span>';

  // 제목 클릭: 게시된 건 view.html, 내 것이면 write.html
  const href = isMyPost
    ? `write.html?id=${p.id}`
    : `view.html?id=${p.id}`;

  const titleLink = p.is_published || isMyPost
    ? `<a href="${href}" class="title-link" title="${escHtml(p.title)}">${escHtml(p.title)}</a>`
    : `<span class="title-link" style="color:var(--text-muted)">${escHtml(p.title)}</span>`;

  const actions = isMyPost ? `
    <button class="vm-act-btn" onclick="location.href='write.html?id=${p.id}'">편집</button>
    <button class="vm-act-btn del" onclick="deleteProject(${p.id},'${escHtml(p.title || '').replace(/'/g, "\\'")}')">삭제</button>` : '';

  return `<tr>
    <td class="col-no">${num}</td>
    <td>
      <div class="title-cell">
        ${titleLink}
        ${isMyPost ? `<button class="title-edit-btn" onclick="event.stopPropagation();startProjectTitleEdit(${p.id},this.previousElementSibling)" title="제목 수정">✏</button>` : ''}
      </div>
    </td>
    <td style="font-size:.75rem;color:var(--text-muted)">${escHtml(p.author_name || '-')}</td>
    <td>${badge}</td>
    <td class="col-date">${date}</td>
    <td class="col-action">${actions}</td>
  </tr>`;
}

// ── 페이지네이션 ───────────────────────────────────────────
function renderPagination(page, pages, total) {
  const el = document.getElementById('pagination');
  if (pages <= 1) { el.innerHTML = ''; return; }
  const start = Math.max(1, page - 2), end = Math.min(pages, page + 2);
  let html = `<span class="pg-info">전체 ${total}건</span>`;
  html += `<button class="pg-btn" onclick="loadList(${page-1})" ${page<=1?'disabled':''}>‹ 이전</button>`;
  for (let p = start; p <= end; p++) html += `<button class="pg-btn${p===page?' active':''}" onclick="loadList(${p})">${p}</button>`;
  html += `<button class="pg-btn" onclick="loadList(${page+1})" ${page>=pages?'disabled':''}>다음 ›</button>`;
  el.innerHTML = html;
}

// ── 인라인 새 프로젝트 추가 ───────────────────────────────
let _savingProject = false;
function addInlineRow() {
  if (document.getElementById('vmInlineRow')) { document.getElementById('vmInlineTitle').focus(); return; }
  if (!document.getElementById('vmBody')) loadList(1).then(addInlineRow);
  const tbody = document.getElementById('vmBody') || (() => {
    document.getElementById('tableWrap').innerHTML = `
      <div class="table-scroll-wrap"><table class="vm-list-table">
        <thead><tr><th class="col-no">#</th><th>제목</th><th>작성자</th><th>상태</th><th>수정일</th><th></th></tr></thead>
        <tbody id="vmBody"></tbody>
      </table></div>`;
    return document.getElementById('vmBody');
  })();
  const tr = document.createElement('tr');
  tr.id = 'vmInlineRow'; tr.className = 'vm-inline-row';
  tr.innerHTML = `
    <td></td>
    <td colspan="5">
      <div style="display:flex;gap:.4rem;align-items:center">
        <input type="text" id="vmInlineTitle" class="vm-inline-input" placeholder="프로젝트 제목 입력 후 Enter" maxlength="200" />
        <button class="vm-act-btn" onclick="saveInlineProject()">저장</button>
        <button class="vm-act-btn" onclick="cancelInlineRow()">취소</button>
      </div>
    </td>`;
  tbody.insertBefore(tr, tbody.firstChild);
  const inp = document.getElementById('vmInlineTitle');
  inp.focus();
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveInlineProject();
    if (e.key === 'Escape') cancelInlineRow();
  });
}
function cancelInlineRow() { document.getElementById('vmInlineRow')?.remove(); }

async function saveInlineProject() {
  if (_savingProject) return;
  const title = document.getElementById('vmInlineTitle')?.value.trim();
  if (!title) { document.getElementById('vmInlineTitle')?.focus(); return; }
  _savingProject = true;
  try {
    const res = await vmApi('/video-maker/projects', { method: 'POST', body: JSON.stringify({ title }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const data = await res.json();
    location.href = `write.html?id=${data.project.id}`;
  } catch (e) { showToast('생성 실패: ' + e.message); _savingProject = false; }
}

// ── 인라인 제목 수정 ──────────────────────────────────────
function startProjectTitleEdit(id, titleEl) {
  const currentTitle = titleEl.textContent || titleEl.getAttribute('title') || '';
  const input = document.createElement('input');
  input.type = 'text'; input.value = currentTitle;
  input.className = 'vm-inline-input'; input.style.cssText = 'width:100%;max-width:280px';
  titleEl.replaceWith(input);
  input.focus(); input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const newTitle = input.value.trim();
    if (!save || !newTitle || newTitle === currentTitle) { loadList(curPage); return; }
    try {
      const res = await vmApi(`/video-maker/projects/${id}`, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
      if (!res.ok) throw new Error();
      showToast('저장됨');
      loadList(curPage);
    } catch { showToast('저장 실패'); loadList(curPage); }
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ── 삭제 ─────────────────────────────────────────────────
async function deleteProject(id, title) {
  if (!confirm(`"${title}"을 삭제하시겠습니까?`)) return;
  try {
    const res = await vmApi(`/video-maker/projects/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    showToast('삭제됨');
    loadList(curPage);
  } catch { showToast('삭제에 실패했습니다.'); }
}

// ── 토스트 ────────────────────────────────────────────────
let _toastTimer;
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}
