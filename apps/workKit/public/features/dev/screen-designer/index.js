/* 화면 설계서 — 목록 페이지 */
const SD_API = 'https://nynhvk2xl3.execute-api.ap-southeast-2.amazonaws.com';
function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || 'null'); }
function escHtml(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
async function sdApi(path, options = {}) {
  const token = getToken();
  return fetch(SD_API + path, { ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}), ...(options.headers||{}) } });
}

const isLoggedIn = !!getToken();
const me = getUser();
let fState = { mine: false };
let curPage = 1;
const LIMIT = 30;

document.addEventListener('DOMContentLoaded', () => {
  const tbBtns = document.getElementById('toolbarBtns');
  if (isLoggedIn) {
    tbBtns.innerHTML = '<button class="btn primary" onclick="addInlineRow()">+ 새 설계서</button>';
    document.getElementById('filterToggles').innerHTML =
      `<button class="f-toggle" id="tMine" onclick="toggleFilter('mine')">내가 작성한 글</button>`;
  } else {
    tbBtns.innerHTML = '<span class="login-notice">🔒 로그인하면 설계서를 만들 수 있습니다</span>';
  }
  document.getElementById('fQ').addEventListener('keydown', e => { if (e.key==='Enter') doSearch(); });
  loadList(1);
});

function toggleFilter(key) { fState[key]=!fState[key]; document.getElementById('tMine')?.classList.toggle('on',fState.mine); doSearch(); }
function doSearch() { loadList(1); }
function resetFilters() { document.getElementById('fQ').value=''; fState={mine:false}; document.getElementById('tMine')?.classList.remove('on'); loadList(1); }

async function loadList(page=1) {
  curPage=page;
  document.getElementById('tableWrap').innerHTML='<div class="loading">불러오는 중...</div>';
  document.getElementById('pagination').innerHTML='';
  try {
    const res = await sdApi('/screen-designer/projects');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { projects=[], isOwner } = await res.json();
    const q = document.getElementById('fQ').value.trim().toLowerCase();
    let filtered = projects;
    if (q) filtered = filtered.filter(p => (p.title||'').toLowerCase().includes(q));
    if (fState.mine && isLoggedIn) filtered = filtered.filter(p => p.author_name === me?.name);
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total/LIMIT));
    const paged = filtered.slice((page-1)*LIMIT, page*LIMIT);
    renderTable(paged, page, total, isOwner);
    renderPagination(page, pages, total);
  } catch (e) {
    document.getElementById('tableWrap').innerHTML =
      `<div class="empty-state"><span class="ei">⚠️</span><p>불러오기 실패: ${escHtml(e.message)}</p></div>`;
  }
}

function renderTable(projects, page, total, isOwner) {
  const offset = (page-1)*LIMIT;
  if (!projects.length) {
    document.getElementById('tableWrap').innerHTML =
      `<div class="empty-state"><span class="ei">🖥️</span><p>${isLoggedIn?'아직 설계서가 없습니다.':'게시된 설계서가 없습니다.'}</p></div>`;
    return;
  }
  document.getElementById('tableWrap').innerHTML = `
    <div class="table-scroll-wrap">
      <table class="sd-list-table">
        <colgroup><col style="width:42px"><col><col style="width:80px"><col style="width:78px"><col style="width:90px"><col style="width:100px"></colgroup>
        <thead><tr><th class="col-no">번호</th><th>제목</th><th>작성자</th><th>상태</th><th>수정일</th><th style="text-align:right">작업</th></tr></thead>
        <tbody>${projects.map((p,i) => renderRow(p, total-offset-i)).join('')}</tbody>
      </table>
    </div>`;
}

function renderRow(p, num) {
  const date = p.updated_at ? new Date(p.updated_at).toLocaleDateString('ko-KR',{year:'2-digit',month:'2-digit',day:'2-digit'}) : '-';
  const isMyPost = isLoggedIn && me && p.author_name === me.name;
  const badge = p.is_published ? '<span class="badge badge-done">게시됨</span>' : '<span class="badge badge-draft">작성중</span>';
  const href = isMyPost ? `write.html?id=${p.id}` : `view.html?id=${p.id}`;
  const titleLink = (p.is_published || isMyPost)
    ? `<a href="${href}" class="title-link">${escHtml(p.title)}</a>`
    : `<span style="color:var(--text-muted)">${escHtml(p.title)}</span>`;
  const actions = isMyPost ? `
    <button class="sd-act-btn" onclick="location.href='write.html?id=${p.id}'">편집</button>
    <button class="sd-act-btn del" onclick="deleteProject(${p.id},'${escHtml((p.title||'').replace(/'/g,"\\'"))}')">삭제</button>` : '';
  return `<tr>
    <td class="col-no">${num}</td>
    <td><div class="title-cell">${titleLink}${isMyPost?`<button class="title-edit-btn" onclick="event.stopPropagation();startTitleEdit(${p.id},this.previousElementSibling)">✏</button>`:''}</div></td>
    <td style="font-size:.75rem;color:var(--text-muted)">${escHtml(p.author_name||'-')}</td>
    <td>${badge}</td>
    <td class="col-date">${date}</td>
    <td class="col-action">${actions}</td>
  </tr>`;
}

function renderPagination(page, pages, total) {
  const el = document.getElementById('pagination');
  if (pages<=1) { el.innerHTML=''; return; }
  const s=Math.max(1,page-2), e=Math.min(pages,page+2);
  let h=`<span class="pg-info">전체 ${total}건</span>`;
  h+=`<button class="pg-btn" onclick="loadList(${page-1})" ${page<=1?'disabled':''}>‹ 이전</button>`;
  for (let p=s;p<=e;p++) h+=`<button class="pg-btn${p===page?' active':''}" onclick="loadList(${p})">${p}</button>`;
  h+=`<button class="pg-btn" onclick="loadList(${page+1})" ${page>=pages?'disabled':''}>다음 ›</button>`;
  el.innerHTML=h;
}

let _saving = false;
function addInlineRow() {
  if (document.getElementById('sdInlineRow')) { document.getElementById('sdInlineTitle').focus(); return; }
  // 테이블이 없으면(빈 목록 상태) 테이블 구조 먼저 생성
  if (!document.querySelector('.sd-list-table tbody')) {
    document.getElementById('tableWrap').innerHTML = `
      <div class="table-scroll-wrap">
        <table class="sd-list-table">
          <colgroup><col style="width:42px"><col><col style="width:80px"><col style="width:78px"><col style="width:90px"><col style="width:100px"></colgroup>
          <thead><tr><th class="col-no">번호</th><th>제목</th><th>작성자</th><th>상태</th><th>수정일</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>`;
  }
  const tbody = document.querySelector('.sd-list-table tbody');
  const tr = document.createElement('tr');
  tr.id='sdInlineRow'; tr.className='vm-inline-row';
  tr.innerHTML=`<td></td><td colspan="5"><div style="display:flex;gap:.4rem;align-items:center">
    <input type="text" id="sdInlineTitle" class="vm-inline-input" placeholder="설계서 제목 입력 후 Enter" maxlength="200" />
    <button class="btn primary" style="font-size:.8rem;padding:.28rem .7rem" onclick="saveInlineProject()">저장</button>
    <button class="btn" style="font-size:.8rem;padding:.28rem .7rem" onclick="document.getElementById('sdInlineRow')?.remove()">취소</button>
  </div></td>`;
  tbody.insertBefore(tr, tbody.firstChild);
  const inp=document.getElementById('sdInlineTitle');
  inp.focus();
  inp.addEventListener('keydown', e => { if(e.key==='Enter') saveInlineProject(); if(e.key==='Escape') tr.remove(); });
}

async function saveInlineProject() {
  if (_saving) return;
  const title = document.getElementById('sdInlineTitle')?.value.trim();
  if (!title) { document.getElementById('sdInlineTitle')?.focus(); return; }
  _saving = true;
  try {
    const res = await sdApi('/screen-designer/projects', { method:'POST', body:JSON.stringify({title}) });
    if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error||`HTTP ${res.status}`);
    const data = await res.json();
    location.href = `write.html?id=${data.project.id}`;
  } catch(e) { showToast('생성 실패: '+e.message); _saving=false; }
}

function startTitleEdit(id, el) {
  const cur = el.textContent;
  const inp = document.createElement('input');
  inp.type='text'; inp.value=cur; inp.className='vm-inline-input'; inp.style.cssText='width:100%;max-width:280px';
  el.replaceWith(inp); inp.focus(); inp.select();
  let done=false;
  const finish = async (save) => {
    if (done) return; done=true;
    const newTitle = inp.value.trim();
    if (!save || !newTitle || newTitle===cur) { loadList(curPage); return; }
    try {
      const res = await sdApi(`/screen-designer/projects/${id}`, { method:'PUT', body:JSON.stringify({title:newTitle}) });
      if (!res.ok) throw new Error();
      showToast('저장됨'); loadList(curPage);
    } catch { showToast('저장 실패'); loadList(curPage); }
  };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();finish(true);} if(e.key==='Escape')finish(false); });
  inp.addEventListener('blur', ()=>finish(true));
}

async function deleteProject(id, title) {
  if (!confirm(`"${title}"을 삭제하시겠습니까?`)) return;
  try {
    const res = await sdApi(`/screen-designer/projects/${id}`, { method:'DELETE' });
    if (!res.ok) throw new Error();
    showToast('삭제됨'); loadList(curPage);
  } catch { showToast('삭제에 실패했습니다.'); }
}

let _toastTimer;
function showToast(msg) {
  let t=document.getElementById('toast');
  if (!t){t=document.createElement('div');t.id='toast';t.className='toast';document.body.appendChild(t);}
  t.textContent=msg; t.classList.add('show');
  clearTimeout(_toastTimer); _toastTimer=setTimeout(()=>t.classList.remove('show'),2500);
}
