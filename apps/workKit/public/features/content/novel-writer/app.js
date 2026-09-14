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

const isLoggedIn = !!getToken();
const me = getUser();

if (isLoggedIn) {
  document.getElementById('toolbarBtns').innerHTML =
    `<button class="btn primary" onclick="addInlineRow()">✏️ 소설 만들기</button>`;
} else {
  document.getElementById('toolbarBtns').innerHTML =
    '<span class="login-notice">🔒 로그인하면 소설을 만들 수 있습니다</span>';
}

if (isLoggedIn) {
  document.getElementById('filterToggles').innerHTML = `
    <button class="f-toggle" id="tMine"  onclick="toggleFilter('mine')">내가 작성한 글</button>
    <button class="f-toggle" id="tDraft" onclick="toggleFilter('draft')">작성중인 글</button>`;
}

let fState = { mine: false, draft: false };
let curPage = 1;
let totalCount = 0;
let totalPages = 1;
const LIMIT = 30;

['fQ','fAuthor'].forEach(id => {
  document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
});

loadNovels(1);

function toggleFilter(key) {
  fState[key] = !fState[key];
  const idMap = { mine: 'tMine', draft: 'tDraft' };
  document.getElementById(idMap[key])?.classList.toggle('on', fState[key]);
  doSearch();
}

function doSearch() { loadNovels(1); }

function resetFilters() {
  document.getElementById('fQ').value = '';
  document.getElementById('fDate').value = '';
  document.getElementById('fAuthor').value = '';
  fState = { mine: false, draft: false };
  document.getElementById('tMine')?.classList.remove('on');
  document.getElementById('tDraft')?.classList.remove('on');
  loadNovels(1);
}

async function loadNovels(page = 1) {
  curPage = page;
  const q      = document.getElementById('fQ')?.value.trim() || '';
  const date   = document.getElementById('fDate')?.value || '';
  const author = document.getElementById('fAuthor')?.value.trim() || '';

  const params = new URLSearchParams({ page });
  if (q)           params.set('q', q);
  if (date)        params.set('date', date);
  if (author)      params.set('author', author);
  if (fState.mine)  params.set('mine', '1');
  if (fState.draft) params.set('draft', '1');

  document.getElementById('tableWrap').innerHTML = '<div class="loading">불러오는 중...</div>';
  document.getElementById('pagination').innerHTML = '';

  try {
    const res = isLoggedIn
      ? await api('/novel/novels?' + params)
      : await fetch(API_BASE + '/novel/novels?' + params);
    if (!res.ok) throw new Error();
    const { novels, total, pages } = await res.json();
    totalCount = total;
    totalPages = pages;
    renderTable(novels, page, total);
    renderPagination(page, pages, total);
  } catch {
    document.getElementById('tableWrap').innerHTML =
      '<div class="empty-state"><span class="ei">⚠️</span><p>목록을 불러오지 못했습니다.</p></div>';
  }
}

function renderTable(novels, page, total) {
  const offset = (page - 1) * LIMIT;

  const bestWrap = document.getElementById('bestWrap');
  if (page === 1) {
    const done = novels.filter(n => n.is_published && (n.likes || 0) > 0);
    if (done.length) {
      const maxLikes = Math.max(...done.map(n => n.likes || 0));
      const bestItems = done.filter(n => (n.likes || 0) === maxLikes);
      bestWrap.innerHTML = `
        <div class="best-section">
          <div class="best-header">🏆 베스트 소설 <span style="font-weight:400;font-size:.68rem">— 좋아요 ${maxLikes}건</span></div>
          <div class="table-scroll-wrap" style="border:none;border-radius:0;box-shadow:none">
            <table class="novel-table" style="table-layout:fixed;width:100%">
              <colgroup>
                <col style="width:36px"><col><col style="width:60px"><col style="width:36px"><col style="width:60px"><col style="width:96px"><col style="width:48px"><col style="width:68px">
              </colgroup>
              <tbody>${bestItems.map(b => `<tr class="best-row">${renderRow(b, '', true)}</tr>`).join('')}</tbody>
            </table>
          </div>
        </div>`;
    } else { bestWrap.innerHTML = ''; }
  } else { bestWrap.innerHTML = ''; }

  document.getElementById('tableWrap').innerHTML = `
    <div class="table-scroll-wrap">
      <table class="novel-table">
        <thead><tr>
          <th class="col-no">번호</th>
          <th class="col-title">제목</th>
          <th class="col-views">조회</th>
          <th class="col-comments">💬</th>
          <th class="col-author">작성자</th>
          <th class="col-date">작성일</th>
          <th class="col-status">상태</th>
          <th class="col-action"></th>
        </tr></thead>
        <tbody id="novelBody">
          ${novels.length === 0
            ? `<tr><td colspan="8"><div class="empty-state"><span class="ei">📖</span><p>소설이 없습니다.</p></div></td></tr>`
            : novels.map((novel, idx) => renderRow(novel, total - offset - idx)).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderPagination(page, pages, total) {
  const el = document.getElementById('pagination');
  if (pages <= 1) { el.innerHTML = ''; return; }
  const startNum = (page - 1) * LIMIT + 1;
  const endNum   = Math.min(page * LIMIT, total);
  let html = `<span class="pg-info">${startNum}–${endNum} / 전체 ${total}건</span>`;
  html += `<button class="pg-btn" onclick="loadNovels(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹ 이전</button>`;
  const start = Math.max(1, page - 2);
  const end   = Math.min(pages, page + 2);
  for (let p = start; p <= end; p++) {
    html += `<button class="pg-btn${p === page ? ' active' : ''}" onclick="loadNovels(${p})">${p}</button>`;
  }
  html += `<button class="pg-btn" onclick="loadNovels(${page + 1})" ${page >= pages ? 'disabled' : ''}>다음 ›</button>`;
  el.innerHTML = html;
}

function renderRow(novel, num, isBest = false) {
  const date = new Date(novel.created_at).toLocaleString('ko-KR', { year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
  const badge = novel.is_published
    ? '<span class="badge badge-done">게시됨</span>'
    : '<span class="badge badge-draft">임시저장</span>';
  const isMyPost = isLoggedIn && me && novel.user_id === me.id;
  const actions = isMyPost ? `
    <button class="act-btn" onclick="event.stopPropagation();editNovel(${novel.id})" title="편집">✏️</button>
    <button class="act-btn del" onclick="event.stopPropagation();deleteNovel(${novel.id}, this)" title="삭제">🗑</button>` : '';
  const likes    = novel.likes    || 0;
  const dislikes = novel.dislikes || 0;
  const isNew    = novel.id === newNovelId;
  const rowClass = isBest ? '' : isNew ? ' row-new' : likes > dislikes && likes > 0 ? ' row-liked' : dislikes > likes && dislikes > 0 ? ' row-disliked' : '';
  const bestBadge = isBest ? '<span class="badge" style="background:#fef3c7;color:#92400e">🏆 베스트</span> ' : '';
  const newBadge  = isNew  ? '<span class="badge" style="background:#fce7f3;color:#be185d;margin-right:.2rem">방금 작성</span> ' : '';
  const href = `write.html?id=${novel.id}${!novel.is_published ? '&mode=edit' : ''}`;
  return `<tr class="${rowClass}">
    <td class="col-no">${num}</td>
    <td class="col-title">
      <div class="title-cell">
        <a href="${href}" class="title-link" title="${escHtml(novel.title)}">${bestBadge}${newBadge}${escHtml(novel.title)}</a>
      </div>
    </td>
    <td class="col-views">👁 ${novel.view_count || 0} &nbsp;👍 ${novel.likes || 0}</td>
    <td class="col-comments">${novel.comment_count || 0}</td>
    <td class="col-author"><span class="author-link" onclick="filterByAuthor('${escHtml(novel.author)}')" title="${escHtml(novel.author)} 글만 보기">${escHtml(novel.author)}</span></td>
    <td class="col-date">${date}</td>
    <td class="col-status">${badge}</td>
    <td class="col-action">${actions}</td>
  </tr>`;
}

function editNovel(id) { location.href = `write.html?id=${id}&mode=edit`; }

function filterByAuthor(name) {
  document.getElementById('fAuthor').value = name;
  doSearch();
}

async function deleteNovel(id, btn) {
  if (!confirm('이 소설을 삭제하시겠습니까?')) return;
  btn.disabled = true;
  try {
    const res = await api(`/novel/novels/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('삭제됐습니다.', 'success');
    loadNovels(curPage);
  } catch (e) { showToast(e.message || '삭제 실패', 'error'); btn.disabled = false; }
}

function addInlineRow() {
  if (!isLoggedIn) { showToast('로그인이 필요합니다.', 'error'); return; }
  if (document.getElementById('inlineRow')) { document.getElementById('inlineTitle').focus(); return; }
  if (!document.querySelector('.novel-table')) renderTable([], 1, 0);
  const tbody = document.getElementById('novelBody');
  const tr = document.createElement('tr');
  tr.id = 'inlineRow'; tr.className = 'inline-row';
  tr.innerHTML = `
    <td></td>
    <td colspan="7">
      <div style="display:flex;gap:.4rem;align-items:center;padding:.1rem 0">
        <input type="text" id="inlineTitle" class="inline-input" style="flex:1;min-width:0" placeholder="소설 제목 입력 후 Enter" maxlength="200" />
        <button class="btn-sm primary" onclick="saveInlineNovel()" style="flex-shrink:0">저장</button>
        <button class="btn-sm" onclick="cancelInlineRow()" style="flex-shrink:0">취소</button>
      </div>
    </td>`;
  tbody.insertBefore(tr, tbody.firstChild);
  const inp = document.getElementById('inlineTitle');
  inp.focus();
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveInlineNovel();
    if (e.key === 'Escape') cancelInlineRow();
  });
}

function cancelInlineRow() { document.getElementById('inlineRow')?.remove(); }

let newNovelId = null;

async function saveInlineNovel() {
  const title = document.getElementById('inlineTitle')?.value.trim();
  if (!title) { showToast('제목을 입력하세요.', 'error'); return; }
  try {
    const res = await api('/novel/novels', { method: 'POST', body: JSON.stringify({ title }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    newNovelId = data.novel.id;
    cancelInlineRow();
    showToast('소설이 추가됐습니다.', 'success');
    loadNovels(1);
  } catch (e) { showToast(e.message || '저장 실패', 'error'); }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let toastTimer;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.innerHTML = msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>');
  el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = `toast ${type}`, 2800);
}
