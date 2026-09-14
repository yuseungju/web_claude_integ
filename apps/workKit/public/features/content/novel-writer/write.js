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

const params     = new URLSearchParams(location.search);
const novelId    = params.get('id');
const isEditMode = params.get('mode') === 'edit';
const isLoggedIn = !!getToken();
const me         = getUser();

let isAuthor   = false;
let nodes      = [];
let expanded   = new Set();
let selId      = null;
let refInfo    = {};
let refSummary = '';
let refFiles   = [];
let polishedText  = null;
let nodeRefOpen   = false;
let _novelIsPublished = false;

let viewNodes    = [];
let viewExpanded = new Set();
let viewSelId    = null;

// ── 드래그 상태 ──
let _dragId     = null;
let _dragBefore = true;
let _dragOverEl = null;

if (!novelId) {
  if (!isLoggedIn) { location.href = 'index.html'; }
  else { isAuthor = true; showEditWorkspace({ title: '', id: null }); }
} else {
  loadNovel();
}

/* ═══════════════════════════════════════════
   사이드바 너비 조절
═══════════════════════════════════════════ */
function setupSidebarResize(handleId, sidebarId) {
  const handle  = document.getElementById(handleId);
  const sidebar = document.getElementById(sidebarId);
  if (!handle || !sidebar) return;
  let resizing = false, startX, startW;
  handle.addEventListener('mousedown', e => {
    resizing = true;
    startX   = e.clientX;
    startW   = sidebar.offsetWidth || 286;
    handle.classList.add('resizing');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const w = Math.max(140, Math.min(480, startW + e.clientX - startX));
    sidebar.style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    handle.classList.remove('resizing');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
}
setupSidebarResize('editSidebarResize', 'editSidebar');
setupSidebarResize('viewSidebarResize', 'viewSidebar');

/* ═══════════════════════════════════════════
   소설 불러오기
═══════════════════════════════════════════ */
async function loadNovel() {
  try {
    const hdrs = isLoggedIn ? { Authorization: `Bearer ${getToken()}` } : {};
    const res = await fetch(API_BASE + '/novel/novels/' + novelId, { headers: hdrs });
    if (res.status === 403) { location.href = 'index.html'; return; }
    if (!res.ok) throw new Error();
    const { novel } = await res.json();
    isAuthor = isLoggedIn && me && novel.user_id === me.id;
    if (isEditMode && isAuthor) showEditWorkspace(novel);
    else showViewMode(novel);
  } catch { showToast('소설을 불러오지 못했습니다.', 'error'); }
}

/* ═══════════════════════════════════════════
   편집 워크스페이스
═══════════════════════════════════════════ */
function updateNovelPublishUI() {
  const completeBtn   = document.getElementById('btnWsComplete');
  const unpublishBtn  = document.getElementById('btnWsUnpublish');
  const badge         = document.getElementById('wsStatusBadge');
  if (!completeBtn) return;
  if (_novelIsPublished) {
    completeBtn.style.display  = 'none';
    if (unpublishBtn) unpublishBtn.style.display = '';
    if (badge) { badge.textContent = '게시됨'; badge.className = 'status-badge badge-done'; badge.style.display = ''; }
    completeBtn.classList.remove('publish-need-attention');
  } else {
    completeBtn.style.display  = '';
    if (unpublishBtn) unpublishBtn.style.display = 'none';
    if (badge) { badge.textContent = '임시저장'; badge.className = 'status-badge badge-draft'; badge.style.display = novelId ? '' : 'none'; }
    if (novelId) completeBtn.classList.add('publish-need-attention');
    else completeBtn.classList.remove('publish-need-attention');
  }
}

async function showEditWorkspace(novel) {
  _novelIsPublished = novel.is_published || false;
  document.getElementById('editWorkspace').style.display = 'flex';
  document.getElementById('viewWorkspace').style.display = 'none';
  document.getElementById('viewFooter').style.display    = 'none';
  document.getElementById('appFooter').style.display     = 'none';
  document.body.classList.add('edit-mode');
  document.getElementById('wsTitleInput').value = novel.title || '';
  updateNovelPublishUI();
  if (novelId) { await loadNodes(); await loadRefInfo(); }
}

async function loadNodes() {
  try {
    const res = await api(`/novel/novels/${novelId}/nodes`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    nodes = d.nodes;
    renderTree();
  } catch (e) { showToast(e.message || '메뉴를 불러오지 못했습니다.', 'error'); }
}

/* ── 편집 트리 렌더링 ── */
function renderTree() {
  document.getElementById('menuTree').innerHTML = buildEditTreeHtml(null, 0) ||
    '<div style="text-align:center;padding:1.5rem;font-size:.75rem;color:var(--text-muted)">아래 버튼으로 메뉴를 추가하세요</div>';
}

function buildEditTreeHtml(parentId, depth) {
  const children = nodes
    .filter(n => (n.parent_id ?? null) === parentId)
    .sort((a, b) => a.position - b.position);
  if (!children.length) return '';

  return children.map(n => {
    const hasKids  = nodes.some(c => (c.parent_id ?? null) === n.id);
    const isExp    = expanded.has(n.id);
    const isSel    = selId === n.id;
    const pl       = 0.35 + depth * 0.85;
    const titleEsc = escHtml(n.title || '(제목 없음)');
    return `
      <div class="tree-node" data-id="${n.id}">
        <div class="tree-row${isSel ? ' selected' : ''}"
             style="padding-left:${pl}rem"
             draggable="true"
             title="${titleEsc} (더블클릭: 제목 편집)"
             onclick="selectNode(${n.id})"
             ondragstart="onDragStart(event,${n.id})"
             ondragover="onDragOver(event,${n.id})"
             ondragleave="onDragLeave(event)"
             ondrop="onDrop(event,${n.id})"
             ondragend="onDragEnd(event)">
          <span class="tree-expand" onclick="event.stopPropagation();toggleExpand(${n.id})">
            ${hasKids ? (isExp ? '▼' : '▶') : '·'}
          </span>
          <span class="tree-title" ondblclick="event.stopPropagation();inlineEditTitle(${n.id},event)">${titleEsc}</span>
          <div class="tree-btns">
            <button class="tree-btn" onclick="event.stopPropagation();addChildNode(${n.id})" title="하위 추가">+</button>
            <button class="tree-btn" onclick="event.stopPropagation();confirmDeleteNode(${n.id})" title="삭제">×</button>
          </div>
        </div>
        <div id="tc-${n.id}" style="display:${isExp ? 'block' : 'none'}">
          <div class="tree-children">${buildEditTreeHtml(n.id, depth + 1)}</div>
        </div>
      </div>`;
  }).join('');
}

/* ── 드래그 & 드롭 ── */
function onDragStart(e, id) {
  _dragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(id));
  setTimeout(() => {
    const el = document.querySelector(`.tree-node[data-id="${id}"] > .tree-row`);
    if (el) el.classList.add('dragging');
  }, 0);
}

function onDragOver(e, id) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (id === _dragId) return;
  const rect = e.currentTarget.getBoundingClientRect();
  _dragBefore = e.clientY < rect.top + rect.height / 2;
  if (_dragOverEl && _dragOverEl !== e.currentTarget) {
    _dragOverEl.classList.remove('drag-over-top', 'drag-over-bottom');
  }
  _dragOverEl = e.currentTarget;
  e.currentTarget.classList.toggle('drag-over-top',    _dragBefore);
  e.currentTarget.classList.toggle('drag-over-bottom', !_dragBefore);
}

function onDragLeave(e) {
  if (_dragOverEl === e.currentTarget) {
    e.currentTarget.classList.remove('drag-over-top', 'drag-over-bottom');
    _dragOverEl = null;
  }
}

function onDragEnd(e) {
  document.querySelectorAll('.dragging,.drag-over-top,.drag-over-bottom').forEach(el =>
    el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
  _dragId     = null;
  _dragOverEl = null;
}

async function onDrop(e, targetId) {
  e.preventDefault();
  const srcId  = _dragId;
  const before = _dragBefore;
  onDragEnd(e);
  if (!srcId || srcId === targetId) return;
  await moveNode(srcId, targetId, before);
}

async function moveNode(srcId, targetId, insertBefore) {
  const dragNode   = nodes.find(n => n.id === srcId);
  const targetNode = nodes.find(n => n.id === targetId);
  if (!dragNode || !targetNode) return;

  if (hasDescendant(srcId, targetId)) {
    showToast('자신의 하위 메뉴로는 이동할 수 없습니다.', 'error'); return;
  }

  const oldParentId = dragNode.parent_id ?? null;
  const newParentId = targetNode.parent_id ?? null;

  let destSiblings = nodes
    .filter(n => (n.parent_id ?? null) === newParentId && n.id !== srcId)
    .sort((a, b) => a.position - b.position);

  const targetIdx = destSiblings.findIndex(n => n.id === targetId);
  const insertIdx = insertBefore ? targetIdx : targetIdx + 1;
  destSiblings.splice(insertIdx, 0, dragNode);

  const di = nodes.findIndex(n => n.id === srcId);
  nodes[di].parent_id = newParentId;
  destSiblings.forEach((n, i) => {
    const idx = nodes.findIndex(x => x.id === n.id);
    if (idx !== -1) nodes[idx].position = i;
  });

  let oldSiblings = [];
  if (oldParentId !== newParentId) {
    oldSiblings = nodes
      .filter(n => (n.parent_id ?? null) === oldParentId)
      .sort((a, b) => a.position - b.position);
    oldSiblings.forEach((n, i) => {
      const idx = nodes.findIndex(x => x.id === n.id);
      if (idx !== -1) nodes[idx].position = i;
    });
  }

  renderTree();

  try {
    const srcBody = { position: nodes.find(n => n.id === srcId).position };
    if (oldParentId !== newParentId) srcBody.parent_id = newParentId;
    await api(`/novel/nodes/${srcId}`, { method: 'PUT', body: JSON.stringify(srcBody) });
    const others = [...destSiblings, ...oldSiblings].filter(n => n.id !== srcId);
    await Promise.all(others.map(n =>
      api(`/novel/nodes/${n.id}`, { method: 'PUT', body: JSON.stringify({ position: n.position }) })
    ));
    showToast('순서가 변경됐습니다.', 'success');
  } catch { showToast('순서 저장 실패', 'error'); }
}

function hasDescendant(ancestorId, targetId) {
  const children = nodes.filter(n => (n.parent_id ?? null) === ancestorId);
  for (const c of children) {
    if (c.id === targetId || hasDescendant(c.id, targetId)) return true;
  }
  return false;
}

/* ── 인라인 제목 편집 ── */
function inlineEditTitle(nodeId, e) {
  e.stopPropagation();
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return;
  // 선택 처리 (우측 패널 표시)
  selId = nodeId;
  document.getElementById('btnRefInfo').classList.remove('active');
  showNodePanel(node);
  renderTree();
  // DOM 업데이트 후 인라인 입력창 설치
  requestAnimationFrame(() => {
    const titleEl = document.querySelector(`.tree-node[data-id="${nodeId}"] > .tree-row .tree-title`);
    if (titleEl) startInlineEdit(nodeId, titleEl, node.title || '');
  });
}

function startInlineEdit(nodeId, titleEl, currentTitle) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;
  input.className = 'tree-title-edit';
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const newTitle = input.value.trim();
    if (!save || !newTitle || newTitle === currentTitle) { renderTree(); return; }
    try {
      const res = await api(`/novel/nodes/${nodeId}`, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      const idx = nodes.findIndex(n => n.id === nodeId);
      if (idx !== -1) nodes[idx].title = newTitle;
      // 우측 패널 제목 입력칸도 갱신
      const nodeTitleInput = document.getElementById('nodeTitle');
      if (nodeTitleInput) nodeTitleInput.value = newTitle;
      renderTree();
      showToast('메뉴명 저장됐습니다.', 'success');
    } catch (err) { showToast(err.message || '저장 실패', 'error'); renderTree(); }
  };

  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function toggleExpand(id) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  renderTree();
}

/* ── 노출 토글 ── */
async function toggleVisibility(nodeId) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return;
  const newVal = !node.is_visible;
  try {
    const res = await api(`/novel/nodes/${nodeId}`, { method: 'PUT', body: JSON.stringify({ is_visible: newVal }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    const idx = nodes.findIndex(n => n.id === nodeId);
    if (idx !== -1) nodes[idx].is_visible = newVal;
    renderTree();
    showToast(newVal ? '조회 모드에 노출됩니다.' : '조회 모드에서 숨겨집니다.', 'success');
  } catch (e) { showToast(e.message || '처리 실패', 'error'); }
}

/* ── 노드 선택 ── */
async function selectNode(id) {
  if (selId && selId !== id) await saveNode(selId, true); // 이전 노드 자동저장
  selId = id;
  document.getElementById('btnRefInfo').classList.remove('active');
  // 하위 메뉴가 있으면 클릭만으로 펼침/접음
  const hasKids = nodes.some(n => (n.parent_id ?? null) === id);
  if (hasKids) {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  }
  renderTree();
  const node = nodes.find(n => n.id === id);
  if (node) showNodePanel(node);
}

function showNodePanel(node) {
  const hasKids = nodes.some(n => (n.parent_id ?? null) === node.id);
  document.getElementById('mainEmpty').style.display = 'none';
  document.getElementById('refPanel').style.display  = 'none';
  const panel = document.getElementById('nodePanel');
  panel.style.display = 'block';

  const savedAi = node.ai_content?.trim();

  panel.innerHTML = `
    <div class="node-panel">
      <div class="panel-heading">📝 메뉴 편집</div>
      <input id="nodeTitle" class="node-title-input"
             value="${escHtml(node.title || '')}"
             placeholder="메뉴 제목을 입력하세요" maxlength="200" />
      <textarea id="nodeContent" class="node-content-ta" rows="12"
                placeholder="내용을 입력하세요...">${escHtml(node.content || '')}</textarea>
      ${hasKids ? `
      <div class="import-bar">
        <button class="btn sm" onclick="importChildren(${node.id})">📥 하위메뉴 글 가져오기</button>
        <span class="import-hint">[제목] 형식으로 구분하여 순서대로 붙여옵니다</span>
      </div>` : ''}
      <div class="ai-section">
        <div class="ai-sec-head">✨ AI 다듬기</div>
        <div class="ai-bar">
          <input id="aiGuide" class="ai-guide-input" placeholder="AI 가이드 (예: 긴장감 있게, 서정적으로...)">
          <button class="btn primary sm" id="btnPolish" onclick="polishContent(${node.id})">AI 다듬기</button>
        </div>
        <div class="polish-result" id="polishResult" style="display:${savedAi ? 'block' : 'none'}">
          <div class="polish-label">✨ ${savedAi ? '저장된 AI 결과' : 'AI 다듬기 결과'}</div>
          <div class="polish-text" id="polishText">${escHtml(savedAi || '')}</div>
          <div class="polish-acts">
            <button class="btn primary sm" onclick="applyPolish()">✅ 적용</button>
            <button class="btn sm" onclick="document.getElementById('polishResult').style.display='none'">닫기</button>
          </div>
        </div>
      </div>
      <div class="node-ref-section">
        <div class="node-ref-toggle" onclick="toggleNodeRef()">
          <span>📋 기준정보</span>
          ${(node.node_ref?.entries?.length) ? `<span class="node-ref-badge">${node.node_ref.entries.length}개</span>` : ''}
          <span style="flex:1"></span>
          <button class="btn sm" style="font-size:.7rem;padding:.22rem .6rem"
                  onclick="event.stopPropagation();openRefPopup()">📚 전체 조회</button>
        </div>
        <div id="nodeRefBody" style="display:${nodeRefOpen ? 'block' : 'none'}">
          <div class="node-ref-body">
            ${renderRefEntriesHtml(node.node_ref?.entries || [])}
            <div style="display:flex;justify-content:space-between;align-items:center">
              <button class="btn sm" onclick="addRefEntry()">+ 항목 추가</button>
              <button class="btn primary sm" onclick="saveNodeRef(${node.id})">💾 기준정보 저장</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  polishedText = savedAi || null;
}

function importChildren(parentId) {
  const allKids = nodes
    .filter(n => (n.parent_id ?? null) === parentId)
    .sort((a, b) => a.position - b.position);
  const withContent = allKids.filter(k => k.content?.trim());
  if (!withContent.length) { showToast('하위 메뉴에 내용이 없습니다.', 'error'); return; }

  document.getElementById('nodeContent').value = withContent
    .map(k => `[${k.title || '(제목 없음)'}]\n${k.content.trim()}`)
    .join('\n\n');

  // 기준정보 병합: 메뉴 순서대로 entries 누적 (type+name 같으면 나중 것으로 덮어씀)
  const mergedMap = new Map();
  for (const kid of allKids) {
    for (const e of (kid.node_ref?.entries || [])) {
      if (e.name) mergedMap.set(`${e.type}|${e.name}`, e);
    }
  }
  if (mergedMap.size > 0) {
    const list = document.getElementById('refEntryList');
    if (list) {
      list.innerHTML = Array.from(mergedMap.values()).map(e => refEntryRowHtml(e)).join('');
      const body = document.getElementById('nodeRefBody');
      if (body) { body.style.display = 'block'; nodeRefOpen = true; }
      showToast(`내용 가져오기 완료. 기준정보 ${mergedMap.size}개 병합됨.`, 'success');
      return;
    }
  }
  showToast(`하위 메뉴 ${withContent.length}개 내용을 가져왔습니다.`, 'success');
}

/* ── 기준정보 섹션 ── */
function toggleNodeRef() {
  const body = document.getElementById('nodeRefBody');
  if (!body) return;
  nodeRefOpen = body.style.display === 'none';
  body.style.display = nodeRefOpen ? 'block' : 'none';
}

const REF_TYPES = ['인물', '장소', '상황', '아이템', '기타'];
const REF_TYPE_NEXT = t => REF_TYPES[(REF_TYPES.indexOf(t) + 1) % REF_TYPES.length];

function renderRefEntriesHtml(entries) {
  const rows = entries.length
    ? entries.map(e => refEntryRowHtml(e)).join('')
    : `<div class="ref-empty">항목을 추가하세요</div>`;
  return `<div class="ref-entry-list" id="refEntryList">${rows}</div>`;
}

function refEntryRowHtml(e) {
  const t = REF_TYPES.includes(e.type) ? e.type : '기타';
  return `<div class="ref-entry-row">
    <button class="ref-type-btn ref-type-${t}" onclick="cycleRefType(this)">${escHtml(t)}</button>
    <input  class="ref-entry-name" placeholder="이름/제목" value="${escHtml(e.name||'')}">
    <textarea class="ref-entry-note" rows="1" placeholder="내용 메모...">${escHtml(e.note||'')}</textarea>
    <button class="ref-del-btn" onclick="delRefEntry(this)">×</button>
  </div>`;
}

function cycleRefType(btn) {
  const next = REF_TYPE_NEXT(btn.textContent.trim());
  btn.textContent = next;
  btn.className = `ref-type-btn ref-type-${next}`;
}

function addRefEntry() {
  let list = document.getElementById('refEntryList');
  if (!list) return;
  const empty = list.querySelector('.ref-empty');
  if (empty) { list.innerHTML = ''; }
  list.insertAdjacentHTML('beforeend', refEntryRowHtml({ type: '인물', name: '', note: '' }));
  list.querySelector('.ref-entry-row:last-child .ref-entry-name')?.focus();
}

function delRefEntry(btn) {
  const row = btn.closest('.ref-entry-row');
  row.remove();
  const list = document.getElementById('refEntryList');
  if (list && !list.querySelector('.ref-entry-row'))
    list.innerHTML = `<div class="ref-empty">항목을 추가하세요</div>`;
}

function collectEntries() {
  const rows = document.querySelectorAll('#refEntryList .ref-entry-row');
  return Array.from(rows).map(row => ({
    type: row.querySelector('.ref-type-btn')?.textContent.trim() || '기타',
    name: row.querySelector('.ref-entry-name')?.value.trim() || '',
    note: row.querySelector('.ref-entry-note')?.value.trim() || '',
  })).filter(e => e.name || e.note);
}

async function saveNodeRef(nodeId) {
  const node_ref = { entries: collectEntries() };
  try {
    const res = await api(`/novel/nodes/${nodeId}`, { method: 'PUT', body: JSON.stringify({ node_ref }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    const idx = nodes.findIndex(n => n.id === nodeId);
    if (idx !== -1) nodes[idx].node_ref = node_ref;
    renderTree();
    showToast('기준정보 저장됐습니다.', 'success');
  } catch (e) { showToast(e.message || '저장 실패', 'error'); }
}

/* ── 전체 기준정보 팝업 ── */
const REF_TYPE_COLORS = { 인물:'#db2777', 장소:'#059669', 상황:'#d97706', 아이템:'#7c3aed', 기타:'#6b7280' };

function openRefPopup() {
  const ordered = getNodesInOrder(null);
  let html = '';
  for (const n of ordered) {
    const entries = n.node_ref?.entries || [];
    if (!entries.length) continue;
    const depth = getNodeDepth(n.id);
    const indent = '　'.repeat(depth);
    html += `
      <div>
        <div class="ref-popup-node-title">${indent}📄 ${escHtml(n.title || '(제목 없음)')}</div>
        <div style="display:flex;flex-direction:column;gap:0.3rem;padding:0.3rem 0 0.5rem">
          ${entries.map(e => {
            const color = REF_TYPE_COLORS[e.type] || '#6b7280';
            return `<div style="display:flex;gap:0.4rem;align-items:baseline;font-size:0.75rem">
              <span style="flex-shrink:0;padding:.1rem .5rem;border-radius:100px;border:1.5px solid ${color};color:${color};font-weight:700;font-size:.68rem">${escHtml(e.type||'기타')}</span>
              <span style="font-weight:600;color:var(--text-primary)">${escHtml(e.name)}</span>
              ${e.note ? `<span style="color:var(--text-secondary)">${escHtml(e.note)}</span>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }
  document.getElementById('refPopupBody').innerHTML = html ||
    '<div class="ref-popup-empty">기준정보가 없습니다.<br>각 메뉴에서 항목을 추가해주세요.</div>';
  document.getElementById('refPopupOverlay').style.display = 'flex';
}

function closeRefPopup(e) {
  if (e && e.target !== document.getElementById('refPopupOverlay')) return;
  document.getElementById('refPopupOverlay').style.display = 'none';
}

function getNodesInOrder(parentId, result = []) {
  nodes.filter(n => (n.parent_id ?? null) === parentId)
    .sort((a, b) => a.position - b.position)
    .forEach(n => { result.push(n); getNodesInOrder(n.id, result); });
  return result;
}

function getNodeDepth(id) {
  let depth = 0, cur = nodes.find(n => n.id === id);
  while (cur?.parent_id != null) { cur = nodes.find(n => n.id === cur.parent_id); depth++; }
  return depth;
}

async function polishContent(nodeId) {
  const content = document.getElementById('nodeContent')?.value;
  if (!content?.trim()) { showToast('내용을 먼저 입력하세요.', 'error'); return; }
  const guide = document.getElementById('aiGuide')?.value.trim();
  const btn = document.getElementById('btnPolish');
  btn.disabled = true; btn.textContent = '처리 중...';
  try {
    const res = await api(`/novel/nodes/${nodeId}/polish`, {
      method: 'POST', body: JSON.stringify({ guide, content })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    polishedText = d.content;
    const lbl = document.getElementById('polishResult')?.querySelector('.polish-label');
    if (lbl) lbl.textContent = '✨ AI 다듬기 결과';
    document.getElementById('polishText').textContent = d.content;
    const r = document.getElementById('polishResult');
    r.style.display = 'block';
    r.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { showToast(e.message || 'AI 다듬기 실패', 'error'); }
  finally { btn.disabled = false; btn.textContent = 'AI 다듬기'; }
}

function applyPolish() {
  if (!polishedText) return;
  document.getElementById('nodeContent').value = polishedText;
  document.getElementById('polishResult').style.display = 'none';
  polishedText = null;
  showToast('적용됐습니다.', 'success');
}

async function saveNode(nodeId, silent = false) {
  const title   = document.getElementById('nodeTitle')?.value.trim();
  const content = document.getElementById('nodeContent')?.value;
  if (!title) { if (!silent) showToast('메뉴 제목을 입력하세요.', 'error'); return; }

  const body = { title, content };
  if (polishedText !== null) body.ai_content = polishedText;

  try {
    const res = await api(`/novel/nodes/${nodeId}`, { method: 'PUT', body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    const idx = nodes.findIndex(n => n.id === nodeId);
    if (idx !== -1) {
      nodes[idx] = { ...nodes[idx], title, content };
      if (polishedText !== null) nodes[idx].ai_content = polishedText;
    }
    renderTree();
    if (!silent) showToast(polishedText !== null ? '저장됐습니다. (AI 결과도 별도 저장)' : '저장됐습니다.', 'success');
  } catch (e) { if (!silent) showToast(e.message || '저장 실패', 'error'); }
}

/* ── 메뉴 추가 / 삭제 ── */
async function addRootNode() { await addNodeWithParent(null); }
async function addChildNode(parentId) { expanded.add(parentId); await addNodeWithParent(parentId); }

async function addNodeWithParent(parentId) {
  if (!novelId) {
    const title = document.getElementById('wsTitleInput')?.value.trim();
    if (!title) { showToast('소설 제목을 먼저 입력하고 저장하세요.', 'error'); return; }
    await saveNovelTitle(); return;
  }
  try {
    const res = await api(`/novel/novels/${novelId}/nodes`, {
      method: 'POST', body: JSON.stringify({ parent_id: parentId, title: '새 메뉴' })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    nodes.push(d.node);
    renderTree();
    selectNode(d.node.id);
    showToast('메뉴가 추가됐습니다.', 'success');
  } catch (e) { showToast(e.message || '메뉴 추가 실패', 'error'); }
}

function confirmDeleteNode(id) {
  const node = nodes.find(n => n.id === id);
  const hasKids = nodes.some(n => (n.parent_id ?? null) === id);
  const msg = hasKids
    ? `"${node?.title || '메뉴'}"와 모든 하위 메뉴를 삭제하시겠습니까?`
    : `"${node?.title || '메뉴'}"를 삭제하시겠습니까?`;
  if (!confirm(msg)) return;
  deleteNode(id);
}

async function deleteNode(id) {
  try {
    const res = await api(`/novel/nodes/${id}`, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    removeDescendants(id);
    if (selId === id) {
      selId = null;
      document.getElementById('nodePanel').style.display = 'none';
      document.getElementById('mainEmpty').style.display = 'flex';
    }
    renderTree();
    showToast('삭제됐습니다.', 'success');
  } catch (e) { showToast(e.message || '삭제 실패', 'error'); }
}

function removeDescendants(id) {
  nodes.filter(n => (n.parent_id ?? null) === id).forEach(c => removeDescendants(c.id));
  nodes = nodes.filter(n => n.id !== id);
}

/* ── 기준정보 ── */
async function loadRefInfo() {
  try {
    const res = await api(`/novel/novels/${novelId}/refinfo`);
    const d = await res.json();
    if (!res.ok) return;
    refInfo    = d.ref_info || {};
    refSummary = d.ref_summary || '';
    refFiles   = refInfo.files || [];
  } catch {}
}

function showRefPanel() {
  selId = null; renderTree();
  document.getElementById('mainEmpty').style.display = 'none';
  document.getElementById('nodePanel').style.display = 'none';
  document.getElementById('btnRefInfo').classList.add('active');
  document.getElementById('refPanel').style.display = 'block';
  renderRefPanel();
}

function renderRefPanel() {
  const filesHtml = refFiles.map((f, i) =>
    `<span style="font-size:.72rem;background:#f1f5f9;padding:.1rem .4rem;border-radius:3px">
      ${escHtml(f.name)}
      <button onclick="removeRefFile(${i})" style="border:none;background:none;cursor:pointer;color:#dc2626;font-size:.6rem">×</button>
    </span>`
  ).join('');

  document.getElementById('refPanel').innerHTML = `
    <div class="ref-panel">
      <div class="ref-panel-title">⚙️ 기준정보 설정</div>
      <div class="ref-group"><label class="ref-label">인물 정보</label>
        <textarea id="refChars" class="ref-textarea" rows="4" placeholder="등장인물, 성격, 관계...">${escHtml(refInfo.characters || '')}</textarea></div>
      <div class="ref-group"><label class="ref-label">기술 / 세계관</label>
        <textarea id="refTech" class="ref-textarea" rows="3" placeholder="마법, 기술 체계, 세계관...">${escHtml(refInfo.tech || '')}</textarea></div>
      <div class="ref-group"><label class="ref-label">주요 내용 / 줄거리</label>
        <textarea id="refPlot" class="ref-textarea" rows="3" placeholder="핵심 줄거리, 중요 사건...">${escHtml(refInfo.plot || '')}</textarea></div>
      <div class="ref-group"><label class="ref-label">목표 / 방향</label>
        <textarea id="refGoals" class="ref-textarea" rows="2" placeholder="소설의 목표, 결말 방향...">${escHtml(refInfo.goals || '')}</textarea></div>
      <div class="ref-group"><label class="ref-label">참고 글씨체 파일 <span style="font-size:.68rem;color:var(--text-muted)">(.txt, .md)</span></label>
        <div class="file-row">
          <input type="file" id="refFileInput" accept=".txt,.md" multiple onchange="handleRefFile(event)" style="display:none">
          <button class="btn sm" onclick="document.getElementById('refFileInput').click()">📁 파일 선택</button>
          <div style="display:flex;gap:.3rem;flex-wrap:wrap;align-items:center">${filesHtml || '<span style="font-size:.72rem;color:var(--text-muted)">선택된 파일 없음</span>'}</div>
        </div></div>
      <div class="ref-group"><label class="ref-label">작성 스타일</label>
        <textarea id="refStyle" class="ref-textarea" rows="3" placeholder="문체, 시점, 분위기, 톤...">${escHtml(refInfo.style || '')}</textarea></div>
      <div style="display:flex;justify-content:flex-end">
        <button class="btn primary" id="btnSaveRef" onclick="saveRefInfoData()">💾 저장 &amp; AI 요약</button>
      </div>
      ${refSummary ? `
      <div class="ref-summary-box">
        <div class="ref-summary-lbl">📋 AI 요약</div>
        <div class="ref-summary-txt">${escHtml(refSummary)}</div>
      </div>` : ''}
    </div>`;
}

function handleRefFile(e) {
  Array.from(e.target.files).forEach(f => {
    const reader = new FileReader();
    reader.onload = ev => {
      refFiles = refFiles.filter(x => x.name !== f.name);
      refFiles.push({ name: f.name, content: ev.target.result });
      renderRefPanel();
    };
    reader.readAsText(f);
  });
  e.target.value = '';
}

function removeRefFile(idx) { refFiles.splice(idx, 1); renderRefPanel(); }

async function saveRefInfoData() {
  const btn = document.getElementById('btnSaveRef');
  btn.disabled = true; btn.textContent = '요약 중...';
  const data = {
    characters: document.getElementById('refChars')?.value  || '',
    tech:       document.getElementById('refTech')?.value   || '',
    plot:       document.getElementById('refPlot')?.value   || '',
    goals:      document.getElementById('refGoals')?.value  || '',
    style:      document.getElementById('refStyle')?.value  || '',
    files: refFiles,
  };
  try {
    const res = await api(`/novel/novels/${novelId}/refinfo`, { method: 'PUT', body: JSON.stringify(data) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    refInfo = data; refSummary = d.summary;
    renderRefPanel();
    showToast('기준정보가 저장됐습니다.', 'success');
  } catch (e) { showToast(e.message || '저장 실패', 'error'); }
  finally { const b = document.getElementById('btnSaveRef'); if (b) { b.disabled = false; b.textContent = '💾 저장 & AI 요약'; } }
}

/* ── 제목 자동저장 (blur) — is_published 변경 없음 ── */
async function saveNovelTitle() {
  const title = document.getElementById('wsTitleInput')?.value.trim();
  if (!title) { showToast('제목을 입력하세요.', 'error'); return; }
  try {
    if (!novelId) {
      const r = await api('/novel/novels', { method: 'POST', body: JSON.stringify({ title }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      location.href = `write.html?id=${d.novel.id}&mode=edit`;
      return;
    }
    const r = await api(`/novel/novels/${novelId}`, { method: 'PUT', body: JSON.stringify({ title }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
  } catch (e) { showToast(e.message || '저장 실패', 'error'); }
}

/* ── 저장하기 버튼 — 항상 게시 취소 ── */
async function saveNovelDraft() {
  if (!novelId) { await saveNovelTitle(); return; }
  if (selId) await saveNode(selId, true);
  const title = document.getElementById('wsTitleInput')?.value.trim();
  if (!title) { showToast('제목을 입력하세요.', 'error'); return; }
  const btn = document.getElementById('btnWsSave');
  if (btn) { btn.disabled = true; btn.textContent = '저장 중...'; }
  try {
    const r = await api(`/novel/novels/${novelId}`, { method: 'PUT', body: JSON.stringify({ title, is_published: false }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    const wasPublished = _novelIsPublished;
    _novelIsPublished = false;
    updateNovelPublishUI();
    showToast(wasPublished ? '저장됐습니다. 게시가 취소됐습니다.' : '저장됐습니다.', 'success');
  } catch (e) { showToast(e.message || '저장 실패', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '💾 저장하기'; } }
}

/* ── 게시하기 ── */
async function publishNovel() {
  if (!novelId) { showToast('먼저 제목을 저장하세요.', 'error'); return; }
  if (!confirm('게시하면 모든 사용자가 볼 수 있습니다. 계속하시겠습니까?')) return;
  const btn = document.getElementById('btnWsComplete');
  btn.disabled = true; btn.textContent = '처리 중...';
  try {
    const title = document.getElementById('wsTitleInput')?.value.trim();
    await api(`/novel/novels/${novelId}`, { method: 'PUT', body: JSON.stringify({ title, is_published: true }) });
    _novelIsPublished = true;
    updateNovelPublishUI();
    showToast('게시됐습니다. 모든 사용자에게 공개됩니다.', 'success');
  } catch (e) { showToast(e.message || '처리 실패', 'error'); }
  finally { btn.disabled = false; btn.textContent = '📢 게시하기'; }
}

/* ── 게시취소 ── */
async function unpublishNovel() {
  if (!novelId) return;
  if (!confirm('게시를 취소하면 나만 볼 수 있습니다. 계속하시겠습니까?')) return;
  const btn = document.getElementById('btnWsUnpublish');
  if (btn) { btn.disabled = true; btn.textContent = '처리 중...'; }
  try {
    const title = document.getElementById('wsTitleInput')?.value.trim();
    await api(`/novel/novels/${novelId}`, { method: 'PUT', body: JSON.stringify({ title, is_published: false }) });
    _novelIsPublished = false;
    updateNovelPublishUI();
    showToast('게시가 취소됐습니다.', 'success');
  } catch (e) { showToast(e.message || '처리 실패', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🔒 게시취소'; } }
}

function assembleContent(parentId) {
  return nodes
    .filter(n => (n.parent_id ?? null) === parentId)
    .sort((a, b) => a.position - b.position)
    .map(n => n.content?.trim() ? n.content.trim() : assembleContent(n.id))
    .filter(Boolean).join('\n\n');
}

/* ═══════════════════════════════════════════
   조회 모드
═══════════════════════════════════════════ */
async function showViewMode(novel) {
  document.getElementById('editWorkspace').style.display = 'none';
  document.getElementById('viewWorkspace').style.display = 'flex';
  document.getElementById('viewFooter').style.display    = 'block';

  document.getElementById('viewNovelTitle').textContent = novel.title || '소설';
  const date = new Date(novel.created_at).toLocaleString('ko-KR', {
    year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12: false
  });
  document.getElementById('viewNovelSub').textContent = `${novel.author} · ${date} · 조회 ${novel.view_count ?? 0}`;

  if (isAuthor) {
    document.getElementById('viewTopActions').innerHTML = `
      <a href="write.html?id=${novelId}&mode=edit" class="btn sm primary" style="text-decoration:none">✏️ 편집</a>
      <button class="btn sm" style="border-color:#fca5a5;color:#dc2626" onclick="confirmDelete()">🗑 삭제</button>`;
  }

  renderNovelReactBar(novel);

  try {
    const hdrs = isLoggedIn ? { Authorization: `Bearer ${getToken()}` } : {};
    const res = await fetch(API_BASE + `/novel/novels/${novelId}/nodes`, { headers: hdrs });
    if (res.ok) {
      const d = await res.json();
      viewNodes = d.nodes || [];
      renderViewTree();
    }
  } catch {}

  loadComments();
}

function renderViewTree() {
  document.getElementById('viewMenuTree').innerHTML = buildViewTreeHtml(null, 0) ||
    '<div style="text-align:center;padding:1.5rem;font-size:.75rem;color:var(--text-muted)">노출된 메뉴가 없습니다</div>';
}

function buildViewTreeHtml(parentId, depth) {
  const children = viewNodes
    .filter(n => (n.parent_id ?? null) === parentId)
    .sort((a, b) => a.position - b.position);
  if (!children.length) return '';

  return children.map(n => {
    const hasKids = viewNodes.some(c => (c.parent_id ?? null) === n.id);
    const isExp   = viewExpanded.has(n.id);
    const isSel   = viewSelId === n.id;
    const pl      = 0.35 + depth * 0.85;
    return `
      <div class="tree-node">
        <div class="tree-row${isSel ? ' selected' : ''}"
             style="padding-left:${pl}rem"
             title="${escHtml(n.title || '(제목 없음)')}"
             onclick="selectViewNode(${n.id})">
          <span class="tree-expand" onclick="event.stopPropagation();toggleViewExpand(${n.id})">
            ${hasKids ? (isExp ? '▼' : '▶') : '·'}
          </span>
          <span class="tree-title">${escHtml(n.title || '(제목 없음)')}</span>
        </div>
        <div style="display:${isExp ? 'block' : 'none'}">
          <div class="tree-children">${buildViewTreeHtml(n.id, depth + 1)}</div>
        </div>
      </div>`;
  }).join('');
}

function toggleViewExpand(id) {
  if (viewExpanded.has(id)) viewExpanded.delete(id); else viewExpanded.add(id);
  renderViewTree();
}

function selectViewNode(id) {
  viewSelId = id;
  renderViewTree();
  const node = viewNodes.find(n => n.id === id);
  if (!node) return;
  document.getElementById('viewEmpty').style.display = 'none';
  const panel = document.getElementById('viewNodePanel');
  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="view-node-panel">
      <div class="view-node-title">${escHtml(node.title || '(제목 없음)')}</div>
      ${node.content?.trim()
        ? `<div class="view-node-body">${escHtml(node.content)}</div>`
        : `<div class="view-node-empty">내용이 없습니다.</div>`}
    </div>`;
}

/* ── 반응 ── */
function renderNovelReactBar(novel) {
  const bar = document.getElementById('novelReactSection');
  if (!bar) return;
  const lc = novel.my_reaction === 'like'    ? ' active-like'    : '';
  const dc = novel.my_reaction === 'dislike' ? ' active-dislike' : '';
  bar.innerHTML = `
    <button class="react-btn${lc}" id="novLikeBtn"    onclick="reactNovel('like')">👍 <span id="novLikes">${novel.likes||0}</span></button>
    <button class="react-btn${dc}" id="novDislikeBtn" onclick="reactNovel('dislike')">👎 <span id="novDislikes">${novel.dislikes||0}</span></button>`;
}

async function reactNovel(reaction) {
  if (!isLoggedIn) { openModal('login'); return; }
  try {
    const res = await api(`/novel/novels/${novelId}/react`, { method: 'POST', body: JSON.stringify({ reaction }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    document.getElementById('novLikes').textContent    = d.likes;
    document.getElementById('novDislikes').textContent = d.dislikes;
    document.getElementById('novLikeBtn').className    = `react-btn${d.my_reaction==='like'?' active-like':''}`;
    document.getElementById('novDislikeBtn').className = `react-btn${d.my_reaction==='dislike'?' active-dislike':''}`;
  } catch (e) { showToast(e.message || '처리 실패', 'error'); }
}

async function confirmDelete() {
  if (!confirm('이 소설을 삭제하시겠습니까?')) return;
  try {
    const res = await api(`/novel/novels/${novelId}`, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    location.href = 'index.html';
  } catch (e) { showToast(e.message || '삭제 실패', 'error'); }
}

/* ═══════════════════════════════════════════
   댓글
═══════════════════════════════════════════ */
async function loadComments() {
  const sec = document.getElementById('commentsSection');
  if (!sec || !novelId) return;
  sec.style.display = '';
  try {
    const hdrs = isLoggedIn ? { Authorization: `Bearer ${getToken()}` } : {};
    const res = await fetch(API_BASE + `/novel/novels/${novelId}/comments`, { headers: hdrs });
    if (!res.ok) throw new Error();
    const { comments } = await res.json();
    renderCommentList(comments);
    renderCommentForm();
  } catch {
    document.getElementById('commentList').innerHTML = '<div class="empty-comments">댓글을 불러오지 못했습니다.</div>';
  }
}

function renderCommentList(cs) {
  document.getElementById('commentCountBadge').textContent = cs.length;
  document.getElementById('commentList').innerHTML = cs.length
    ? cs.map(renderCommentItem).join('')
    : '<div class="empty-comments">첫 댓글을 작성해보세요.</div>';
}

function renderCommentItem(c) {
  const date = new Date(c.created_at).toLocaleDateString('ko-KR', { year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const mine = isLoggedIn && me && c.user_id === me.id;
  const lc = c.my_reaction === 'like'    ? ' active-like'    : '';
  const dc = c.my_reaction === 'dislike' ? ' active-dislike' : '';
  return `
    <div class="comment-item" id="comment-${c.id}">
      <div class="comment-meta">
        <span class="comment-author">${escHtml(c.author)}</span>
        <span class="comment-date">${date}</span>
        ${mine ? `<button class="comment-del-btn" onclick="removeComment(${c.id})">삭제</button>` : ''}
      </div>
      <div class="comment-body">${escHtml(c.content)}</div>
      <div class="comment-actions">
        <button class="react-btn${lc}" onclick="reactComment(${c.id},'like')">👍 <span id="clike-${c.id}">${c.likes}</span></button>
        <button class="react-btn${dc}" onclick="reactComment(${c.id},'dislike')">👎 <span id="cdislike-${c.id}">${c.dislikes}</span></button>
      </div>
    </div>`;
}

function renderCommentForm() {
  const wrap = document.getElementById('commentFormWrap');
  if (!wrap) return;
  if (!isLoggedIn) {
    wrap.innerHTML = `<div class="comment-login-notice" onclick="openModal('login')">🔒 로그인하면 댓글을 작성할 수 있습니다</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="comment-form">
      <textarea id="commentInput" class="comment-textarea" placeholder="댓글을 입력하세요..." rows="3"></textarea>
      <div class="comment-submit-row">
        <button class="btn-comment-submit" id="btnCommentSubmit" onclick="submitComment()">댓글 등록</button>
      </div>
    </div>`;
}

async function submitComment() {
  const input = document.getElementById('commentInput');
  const content = input?.value.trim();
  if (!content) { showToast('댓글 내용을 입력하세요.', 'error'); return; }
  const btn = document.getElementById('btnCommentSubmit');
  btn.disabled = true; btn.textContent = '등록 중...';
  try {
    const res = await api(`/novel/novels/${novelId}/comments`, { method: 'POST', body: JSON.stringify({ content }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    input.value = '';
    const list = document.getElementById('commentList');
    list.querySelector('.empty-comments')?.remove();
    list.insertAdjacentHTML('beforeend', renderCommentItem(d.comment));
    const badge = document.getElementById('commentCountBadge');
    badge.textContent = parseInt(badge.textContent || '0') + 1;
    showToast('댓글이 등록됐습니다.', 'success');
  } catch (e) { showToast(e.message || '등록 실패', 'error'); }
  finally { btn.disabled = false; btn.textContent = '댓글 등록'; }
}

async function reactComment(id, reaction) {
  if (!isLoggedIn) { openModal('login'); return; }
  try {
    const res = await api(`/novel/comments/${id}/react`, { method: 'POST', body: JSON.stringify({ reaction }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    document.getElementById(`clike-${id}`).textContent    = d.likes;
    document.getElementById(`cdislike-${id}`).textContent = d.dislikes;
    const item = document.getElementById(`comment-${id}`);
    const [lb, db] = item.querySelectorAll('.react-btn');
    lb.className = `react-btn${d.my_reaction === 'like'    ? ' active-like'    : ''}`;
    db.className = `react-btn${d.my_reaction === 'dislike' ? ' active-dislike' : ''}`;
  } catch (e) { showToast(e.message || '처리 실패', 'error'); }
}

async function removeComment(id) {
  if (!confirm('댓글을 삭제하시겠습니까?')) return;
  try {
    const res = await api(`/novel/comments/${id}`, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    document.getElementById(`comment-${id}`)?.remove();
    const badge = document.getElementById('commentCountBadge');
    badge.textContent = Math.max(0, parseInt(badge.textContent || '1') - 1);
    if (!document.querySelector('.comment-item'))
      document.getElementById('commentList').innerHTML = '<div class="empty-comments">첫 댓글을 작성해보세요.</div>';
    showToast('댓글이 삭제됐습니다.', 'success');
  } catch (e) { showToast(e.message || '삭제 실패', 'error'); }
}

/* ── 유틸 ── */
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

/* ── 메뉴 선택 후 키 입력 → 인라인 제목 편집 ── */
document.addEventListener('keydown', e => {
  if (!selId) return;
  if (e.target.matches('input,textarea,select,[contenteditable]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length !== 1 && e.key !== 'F2') return;
  const titleEl = document.querySelector(`.tree-node[data-id="${selId}"] > .tree-row .tree-title`);
  if (!titleEl) return;
  e.preventDefault();
  const node = nodes.find(n => n.id === selId);
  startInlineEdit(selId, titleEl, node?.title || '');
  if (e.key !== 'F2') {
    requestAnimationFrame(() => {
      const inp = document.querySelector('.tree-title-edit');
      if (inp) { inp.value = e.key; inp.setSelectionRange(1, 1); }
    });
  }
});
