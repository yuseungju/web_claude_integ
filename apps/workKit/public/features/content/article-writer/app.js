const API_BASE = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';

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

const CATEGORIES = ['문화', '정치', '경제', '사회', '스포츠', '연예', 'IT/과학', '국제', '교육', '건강'];

function getCatCookie() {
  const m = document.cookie.match(/selCat=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '문화';
}
function setCatCookie(v) {
  document.cookie = `selCat=${encodeURIComponent(v)};max-age=${60*60*24*365};path=/`;
}

const isLoggedIn = !!getToken();
const me = getUser();

// 필터 분류 select 옵션 채우기
const fCatEl = document.getElementById('fCat');
CATEGORIES.forEach(c => {
  const o = document.createElement('option'); o.value = c; o.textContent = c; fCatEl.appendChild(o);
});

// 로그인 상태 툴바
if (isLoggedIn) {
  const selCat = getCatCookie();
  const catOptions = CATEGORIES.map(c =>
    `<option value="${c}"${c === selCat ? ' selected' : ''}>${c}</option>`
  ).join('');
  document.getElementById('toolbarBtns').innerHTML = `
    <select class="cat-select" id="catSelect" onchange="setCatCookie(this.value)">${catOptions}</select>
    <button class="btn ai" id="btnAI" onclick="addAIIssue()">🤖 AI 이슈 만들기</button>
    <button class="btn primary" onclick="addInlineRow()">✏️ 이슈 만들기</button>`;
} else {
  document.getElementById('toolbarBtns').innerHTML =
    '<span class="login-notice">🔒 로그인하면 이슈를 만들 수 있습니다</span>';
}

// 로그인 시 토글 버튼 추가
if (isLoggedIn) {
  document.getElementById('filterToggles').innerHTML = `
    <button class="f-toggle" id="tMine"  onclick="toggleFilter('mine')">내가 작성한 글</button>
    <button class="f-toggle" id="tDraft" onclick="toggleFilter('draft')">작성중인 글</button>
    <button class="f-toggle" id="tEdit"  onclick="toggleFilter('edit')">편집 배정된 글</button>`;
}

// 필터 상태
let fState = { mine: false, draft: false, edit: false };
let curPage = 1;
let totalCount = 0;
let totalPages = 1;
const LIMIT = 30;

// Enter 키 검색
['fQ','fAuthor'].forEach(id => {
  document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
});

loadIssues(1);

function toggleFilter(key) {
  fState[key] = !fState[key];
  const idMap = { mine: 'tMine', draft: 'tDraft', edit: 'tEdit' };
  document.getElementById(idMap[key])?.classList.toggle('on', fState[key]);
  doSearch();
}

function doSearch() {
  loadIssues(1);
}

function resetFilters() {
  document.getElementById('fQ').value = '';
  document.getElementById('fDate').value = '';
  document.getElementById('fAuthor').value = '';
  document.getElementById('fCat').value = '';
  fState = { mine: false, draft: false, edit: false };
  document.getElementById('tMine')?.classList.remove('on');
  document.getElementById('tDraft')?.classList.remove('on');
  document.getElementById('tEdit')?.classList.remove('on');
  loadIssues(1);
}

async function loadIssues(page = 1) {
  curPage = page;
  const q      = document.getElementById('fQ')?.value.trim() || '';
  const date   = document.getElementById('fDate')?.value || '';
  const author = document.getElementById('fAuthor')?.value.trim() || '';

  const fCat = document.getElementById('fCat')?.value || '';

  const params = new URLSearchParams({ page });
  if (q)               params.set('q', q);
  if (date)            params.set('date', date);
  if (author)          params.set('author', author);
  if (fCat)            params.set('category', fCat);
  if (fState.mine)     params.set('mine', '1');
  if (fState.draft)    params.set('draft', '1');
  if (fState.edit)     params.set('edit', '1');

  document.getElementById('tableWrap').innerHTML =
    '<div class="loading">불러오는 중...</div>';
  document.getElementById('pagination').innerHTML = '';

  try {
    const res = isLoggedIn
      ? await api('/issues?' + params)
      : await fetch(API_BASE + '/issues?' + params);
    if (!res.ok) throw new Error();
    const { issues, total, pages } = await res.json();
    totalCount = total;
    totalPages = pages;
    renderTable(issues, page, total);
    renderPagination(page, pages, total);
  } catch {
    document.getElementById('tableWrap').innerHTML =
      '<div class="empty-state"><span class="ei">⚠️</span><p>목록을 불러오지 못했습니다.</p></div>';
  }
}

function renderTable(issues, page, total) {
  const offset = (page - 1) * LIMIT;

  // 베스트: 완료 글 중 좋아요 최다 1개 (첫 페이지만)
  const bestWrap = document.getElementById('bestWrap');
  if (page === 1) {
    const done = issues.filter(i => !i.is_draft && (i.likes || 0) > 0);
    if (done.length) {
      const maxLikes = Math.max(...done.map(i => i.likes || 0));
      const bestItems = done.filter(i => (i.likes || 0) === maxLikes);
      bestWrap.innerHTML = `
        <div class="best-section">
          <div class="best-header">🏆 베스트 글 <span style="font-weight:400;font-size:.68rem">— 좋아요 ${maxLikes}건</span></div>
          <div class="table-scroll-wrap" style="border:none;border-radius:0;box-shadow:none">
            <table class="issue-table" style="table-layout:fixed;width:100%">
              <colgroup>
                <col style="width:36px"><col><col style="width:48px"><col style="width:54px"><col style="width:36px"><col style="width:60px"><col style="width:96px"><col style="width:48px"><col style="width:68px">
              </colgroup>
              <tbody>${bestItems.map(b => `<tr class="best-row">${renderRow(b, '', true)}</tr>`).join('')}</tbody>
            </table>
          </div>
        </div>`;
    } else { bestWrap.innerHTML = ''; }
  } else { bestWrap.innerHTML = ''; }

  document.getElementById('tableWrap').innerHTML = `
    <div class="table-scroll-wrap">
      <table class="issue-table">
        <thead><tr>
          <th class="col-no">번호</th>
          <th class="col-title">제목</th>
          <th class="col-category">분류</th>
          <th class="col-views">조회</th>
          <th class="col-comments">💬</th>
          <th class="col-author">작성자</th>
          <th class="col-date">작성일</th>
          <th class="col-status">상태</th>
          <th class="col-action"></th>
        </tr></thead>
        <tbody id="issueBody">
          ${issues.length === 0
            ? `<tr><td colspan="8"><div class="empty-state"><span class="ei">📄</span><p>이슈가 없습니다.</p></div></td></tr>`
            : issues.map((issue, idx) => renderRow(issue, total - offset - idx)).join('')}
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

  html += `<button class="pg-btn" onclick="loadIssues(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹ 이전</button>`;

  const start = Math.max(1, page - 2);
  const end   = Math.min(pages, page + 2);
  for (let p = start; p <= end; p++) {
    html += `<button class="pg-btn${p === page ? ' active' : ''}" onclick="loadIssues(${p})">${p}</button>`;
  }

  html += `<button class="pg-btn" onclick="loadIssues(${page + 1})" ${page >= pages ? 'disabled' : ''}>다음 ›</button>`;
  el.innerHTML = html;
}

function renderRow(issue, num, isBest = false) {
  const date = new Date(issue.created_at).toLocaleString('ko-KR', { year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
  const badge = issue.is_draft
    ? '<span class="badge badge-draft">임시저장</span>'
    : '<span class="badge badge-done">게시됨</span>';
  const isMyPost = isLoggedIn && me && issue.user_id === me.id;
  const actions = isMyPost ? `
    <button class="act-btn" onclick="event.stopPropagation();editIssue(${issue.id})" title="편집">✏️</button>
    <button class="act-btn del" onclick="event.stopPropagation();deleteIssue(${issue.id}, this)" title="삭제">🗑</button>` : '';
  const likes    = issue.likes    || 0;
  const dislikes = issue.dislikes || 0;
  const isNew    = issue.id === newIssueId;
  const rowClass = isBest ? '' : isNew ? ' row-new' : likes > dislikes && likes > 0 ? ' row-liked' : dislikes > likes && dislikes > 0 ? ' row-disliked' : '';
  const bestBadge = isBest ? '<span class="badge" style="background:#fef3c7;color:#92400e">🏆 베스트</span> ' : '';
  const newBadge  = isNew  ? '<span class="badge" style="background:#e0e7ff;color:#3730a3;margin-right:.2rem">방금 작성</span> ' : '';
  return `<tr class="${rowClass}">
    <td class="col-no">${num}</td>
    <td class="col-title">
      <div class="title-cell">
        <a href="write.html?id=${issue.id}${issue.is_draft ? '&mode=edit' : ''}" class="title-link" title="${escHtml(issue.title)}">${bestBadge}${newBadge}${escHtml(issue.title)}</a>
      </div>
    </td>
    <td class="col-category">${escHtml(issue.category || '문화')}</td>
    <td class="col-views">👁 ${issue.view_count || 0} &nbsp;👍 ${issue.likes || 0}</td>
    <td class="col-comments">${issue.comment_count || 0}</td>
    <td class="col-author"><span class="author-link" onclick="filterByAuthor('${escHtml(issue.author)}')" title="${escHtml(issue.author)} 글만 보기">${escHtml(issue.author)}</span></td>
    <td class="col-date">${date}</td>
    <td class="col-status">${badge}</td>
    <td class="col-action">${actions}</td>
  </tr>`;
}

function editIssue(id) { location.href = `write.html?id=${id}&mode=edit`; }

function filterByAuthor(name) {
  document.getElementById('fAuthor').value = name;
  doSearch();
}

async function deleteIssue(id, btn) {
  if (!confirm('이 이슈를 삭제하시겠습니까?')) return;
  btn.disabled = true;
  try {
    const res = await api(`/issues/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('삭제됐습니다.', 'success');
    loadIssues(curPage);
  } catch (e) { showToast(e.message || '삭제 실패', 'error'); btn.disabled = false; }
}

function addInlineRow() {
  if (!isLoggedIn) { showToast('로그인이 필요합니다.', 'error'); return; }
  if (document.getElementById('inlineRow')) { document.getElementById('inlineTitle').focus(); return; }
  if (!document.querySelector('.issue-table')) renderTable([], 1, 0);
  const tbody = document.getElementById('issueBody');
  const tr = document.createElement('tr');
  tr.id = 'inlineRow'; tr.className = 'inline-row';
  const catOpts = CATEGORIES.map(c => `<option value="${c}"${c === getCatCookie() ? ' selected' : ''}>${c}</option>`).join('');
  tr.innerHTML = `
    <td></td>
    <td colspan="8">
      <div style="display:flex;gap:.4rem;align-items:center;padding:.1rem 0">
        <select id="inlineCat" class="cat-select" style="height:30px;flex-shrink:0">${catOpts}</select>
        <input type="text" id="inlineTitle" class="inline-input" style="flex:1;min-width:0" placeholder="이슈 제목 입력 후 Enter" maxlength="200" />
        <button class="btn-sm primary" onclick="saveInlineIssue()" style="flex-shrink:0">저장</button>
        <button class="btn-sm" onclick="cancelInlineRow()" style="flex-shrink:0">취소</button>
      </div>
    </td>`;
  tbody.insertBefore(tr, tbody.firstChild);
  const inp = document.getElementById('inlineTitle');
  inp.focus();
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveInlineIssue();
    if (e.key === 'Escape') cancelInlineRow();
  });
}

function cancelInlineRow() { document.getElementById('inlineRow')?.remove(); }

async function saveInlineIssue() {
  const title = document.getElementById('inlineTitle')?.value.trim();
  if (!title) { showToast('제목을 입력하세요.', 'error'); return; }
  try {
    const category = document.getElementById('inlineCat')?.value || document.getElementById('catSelect')?.value || getCatCookie();
    const res = await api('/issues', { method: 'POST', body: JSON.stringify({ title, category }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    cancelInlineRow();
    showToast('이슈가 추가됐습니다.', 'success');
    loadIssues(1);
  } catch (e) { showToast(e.message || '저장 실패', 'error'); }
}

let newIssueId = null; // 방금 생성된 이슈 ID

function addAIIssue() {
  if (!isLoggedIn) { showToast('로그인이 필요합니다.', 'error'); return; }
  if (document.getElementById('aiInlineRow')) { document.getElementById('aiInlineTitle').focus(); return; }
  document.getElementById('inlineRow')?.remove();
  // 입력창 보이는 동안 AI 버튼 비활성
  const aiBtn = document.getElementById('btnAI');
  if (aiBtn) aiBtn.disabled = true;
  if (!document.querySelector('.issue-table')) renderTable([], 1, 0);
  const tbody = document.getElementById('issueBody');
  const tr = document.createElement('tr');
  tr.id = 'aiInlineRow'; tr.className = 'inline-row';
  const aiCatOpts = CATEGORIES.map(c => `<option value="${c}"${c === getCatCookie() ? ' selected' : ''}>${c}</option>`).join('');
  tr.innerHTML = `
    <td></td>
    <td colspan="8">
      <div style="display:flex;gap:.4rem;align-items:center;padding:.1rem 0">
        <select id="aiInlineCat" class="cat-select" style="height:30px;flex-shrink:0">${aiCatOpts}</select>
        <input type="text" id="aiInlineTitle" class="inline-input" style="flex:1;min-width:0"
          placeholder="제목 또는 URL 붙여넣기 → AI가 기사 제목·참고링크·섹션 자동 생성" maxlength="500" />
        <button class="btn-sm primary" id="btnAISave" onclick="saveAIIssue()" style="flex-shrink:0">AI 저장</button>
        <button class="btn-sm" onclick="cancelAIInlineRow()" style="flex-shrink:0">취소</button>
      </div>
    </td>`;
  tbody.insertBefore(tr, tbody.firstChild);
  const inp = document.getElementById('aiInlineTitle');
  inp.focus();
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveAIIssue();
    if (e.key === 'Escape') cancelAIInlineRow();
  });
}

function cancelAIInlineRow() {
  document.getElementById('aiInlineRow')?.remove();
  const aiBtn = document.getElementById('btnAI');
  if (aiBtn) aiBtn.disabled = false; // 버튼 재활성
}

async function saveAIIssue() {
  const title = document.getElementById('aiInlineTitle')?.value.trim();
  if (!title) { showToast('제목을 입력하세요.', 'error'); return; }
  const btn = document.getElementById('btnAISave');
  const isUrl = /^https?:\/\//i.test(title);
  if (btn) { btn.disabled = true; btn.textContent = isUrl ? '⏳ 링크 분석 중...' : '⏳ AI 처리 중...'; }
  try {
    const category = document.getElementById('aiInlineCat')?.value || document.getElementById('catSelect')?.value || getCatCookie();
    const res = await api('/topics/ai', { method: 'POST', body: JSON.stringify({ userTitle: title, category }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    newIssueId = data.issue.id; // 방금 생성 표시용
    cancelAIInlineRow();
    showToast(`AI 이슈가 추가됐습니다.\n작성 완료 전까지 나만 볼 수 있습니다.`, 'success');
    loadIssues(1);
  } catch (e) {
    showToast(e.message || 'AI 이슈 추가 실패', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'AI 저장'; }
  }
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
  const dur = msg.includes('\n') ? 4000 : 2800;
  toastTimer = setTimeout(() => el.className = `toast ${type}`, dur);
}
