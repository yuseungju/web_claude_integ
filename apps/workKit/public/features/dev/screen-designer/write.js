/* 화면 설계서 — 드래그 캔버스 에디터 */

const SD_API = 'https://nynhvk2xl3.execute-api.ap-southeast-2.amazonaws.com';
const projectId = parseInt(new URLSearchParams(window.location.search).get('id')) || 0;

let allNodes = [];
let currentNodeId = null;
let components = [];   // 현재 화면 컴포넌트 배열
let selectedId = null;
let paletteType = null;
let _isPublished = false;
let _lastSavedTitle = '';
let _addingNode = false;
let _inlineEditing = false;
let _clipboard = null;     // 복사된 컴포넌트
let _dirtyNodeIds = new Set(); // 변경된 노드 ID 추적 (저장 버튼 클릭 시 일괄 저장)
let _undoHistory = [];     // 실행취소 히스토리
let _undoIdx = -1;
let _propChangeTimer = null;

// ── 드래그 상태 ──────────────────────────────────────────
let _op = null;

function getToken() { return localStorage.getItem('token'); }
function escHtml(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function genId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2,5); }

async function sdApi(path, options = {}) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 15000);
  const token = getToken();
  try {
    return await fetch(SD_API + path, {
      ...options, signal: ctrl.signal,
      headers: { 'Content-Type':'application/json', ...(token?{Authorization:`Bearer ${token}`}:{}), ...(options.headers||{}) }
    });
  } finally { clearTimeout(tid); }
}

// ── 컴포넌트 기본값 ──────────────────────────────────────
const COMP_DEFAULTS = {
  radio:    { w:180, h:90,  props:{ label:'옵션 그룹', options:'옵션1\n옵션2\n옵션3' } },
  checkbox: { w:180, h:90,  props:{ label:'선택 항목', options:'항목1\n항목2\n항목3' } },
  input:    { w:200, h:62,  props:{ label:'항목명', placeholder:'입력하세요' } },
  button:   { w:100, h:36,  props:{ label:'버튼', variant:'default', linkType:'url', url:'', linkedNodeId:null } },
  dropdown: { w:180, h:62,  props:{ label:'항목명', options:[{key:'1',text:'옵션1'},{key:'2',text:'옵션2'}] } },
  popupBtn: { w:120, h:36,  props:{ label:'팝업버튼', linkType:'url', url:'', linkedNodeId:null } },
  text:    { w:200, h:28,   props:{ content:'텍스트', fontSize:'md', bold:false, color:'#1D2D3E' } },
  section: { w:440, h:180,  props:{ title:'조회조건', bgColor:'#fdf3ec', borderColor:'#c9a87c', showTitle:true } },
  formRow: { w:380, h:32,   props:{ label:'항목명', placeholder:'', labelWidth:90, hasRange:false, rangeLabel:'종료' } },
  table:   { w:620, h:160,  props:{ columns:'컬럼1,컬럼2,컬럼3,컬럼4', rows:4 } },
  toolbar: { w:480, h:42,   props:{ buttons:'상세조회\n처리\n취소\n새로고침' } },
};

// ── 초기화 ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!projectId) { showToast('프로젝트 ID가 없습니다'); return; }
  loadProject();
  initSidebarResize();
  initCanvasEvents();
});

async function loadProject() {
  try {
    const [projRes, nodesRes] = await Promise.all([
      sdApi(`/screen-designer/projects/${projectId}`),
      sdApi(`/screen-designer/projects/${projectId}/nodes`),
    ]);
    if (!projRes.ok) throw new Error('프로젝트를 찾을 수 없습니다');
    const { project } = await projRes.json();
    document.getElementById('projTitle').value = project.title || '';
    _lastSavedTitle = project.title || '';
    document.title = `${project.title||'화면 설계서'} – WorkKit`;
    if (project.is_owner) {
      _isPublished = !!project.is_published;
      updatePublishUI();
      document.getElementById('publishBtn').style.display = '';
    }
    allNodes = (await nodesRes.json()).nodes || [];
    renderTree();
  } catch (e) {
    const msg = e.name==='AbortError' ? '로딩 시간 초과 (15초)' : '불러오기 실패: '+e.message;
    document.getElementById('nodeTree').innerHTML =
      `<div class="node-tree-empty" style="padding:.7rem;line-height:1.8;color:#ef4444;font-size:.78rem">
        ${escHtml(msg)}<br>
        <button onclick="loadProject()" style="font-size:.75rem;margin-top:.25rem;padding:.2rem .6rem;border:1px solid var(--border);border-radius:4px;cursor:pointer;background:#fff;color:var(--text-primary)">재시도</button>
        <a href="index.html" style="font-size:.75rem;margin-left:.5rem;color:var(--primary)">목록으로</a>
      </div>`;
    showToast(msg);
  }
}

// ── 게시 ─────────────────────────────────────────────────
function updatePublishUI() {
  const badge=document.getElementById('publishBadge'), btn=document.getElementById('publishBtn');
  if (_isPublished) { badge.style.display=''; btn.textContent='🔒 게시 취소'; btn.classList.add('published'); }
  else { badge.style.display='none'; btn.textContent='📢 게시'; btn.classList.remove('published'); }
}
async function togglePublish() {
  const btn=document.getElementById('publishBtn'); btn.disabled=true;
  try {
    const action = _isPublished ? 'unpublish' : 'publish';
    const res = await sdApi(`/screen-designer/projects/${projectId}/${action}`, {method:'PUT'});
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error||`HTTP ${res.status}`);
    _isPublished = !_isPublished;
    updatePublishUI();
    showToast(_isPublished ? '게시됐습니다.' : '나만 볼 수 있습니다.');
  } catch(e) { showToast('실패: '+e.message); }
  finally { btn.disabled=false; }
}

// ── 변경 추적 (자동저장 없음 — 저장 버튼으로만 저장) ────
function markDirty() {
  if (currentNodeId) _dirtyNodeIds.add(currentNodeId);
}

// 현재 노드 편집 내용을 allNodes 메모리에만 반영 (API 호출 없음)
function syncCurrentNodeToMemory() {
  if (!currentNodeId) return;
  const title = document.getElementById('nodeTitle').value.trim() || '새 화면';
  const snap = JSON.parse(JSON.stringify(components));
  snap.forEach(c => { delete c._open; });
  const idx = allNodes.findIndex(n => n.id === currentNodeId);
  if (idx >= 0) { allNodes[idx].title = title; allNodes[idx].components = snap; }
}

// ── 현재 화면 저장 (저장 버튼) ──────────────────────────
async function saveAll() {
  const btn = document.getElementById('saveDraftBtn');
  if (btn) btn.disabled = true;
  try {
    syncCurrentNodeToMemory();

    // 프로젝트 제목 저장
    const projTitle = document.getElementById('projTitle').value.trim();
    if (projTitle && projTitle !== _lastSavedTitle) {
      try {
        const res = await sdApi(`/screen-designer/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({ title: projTitle }) });
        if (res.ok) { _lastSavedTitle = projTitle; document.title = `${projTitle} – WorkKit`; }
      } catch (_) {}
    }

    // 현재 노드만 저장
    if (!currentNodeId) { showToast('화면을 선택하세요'); return; }
    if (!_dirtyNodeIds.has(currentNodeId) && projTitle === _lastSavedTitle) { showToast('변경사항이 없습니다'); return; }

    if (_dirtyNodeIds.has(currentNodeId)) {
      const node = allNodes.find(n => n.id === currentNodeId);
      if (node) {
        const snap = JSON.parse(JSON.stringify(node.components || []));
        snap.forEach(c => { delete c._open; });
        try {
          const res = await sdApi(`/screen-designer/projects/${projectId}/nodes/${currentNodeId}`, {
            method: 'PUT', body: JSON.stringify({ title: node.title, components: snap }),
          });
          if (res.ok) { _dirtyNodeIds.delete(currentNodeId); showToast('저장됐습니다'); }
          else showToast('저장 실패');
        } catch (_) { showToast('저장 실패'); }
      }
    } else {
      showToast('저장됐습니다');
    }
    renderTree();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function confirmGoBack() {
  const titleChanged = document.getElementById('projTitle').value.trim() !== _lastSavedTitle;
  if (_dirtyNodeIds.size > 0 || titleChanged) {
    return confirm('저장하지 않은 변경사항이 있습니다. 저장하지 않고 목록으로 이동하시겠습니까?');
  }
  return true;
}

// ── 실행취소(Ctrl+Z) ─────────────────────────────────────
function saveUndoState() {
  const snap = JSON.parse(JSON.stringify(components));
  snap.forEach(c => { delete c._open; });
  _undoHistory = _undoHistory.slice(0, _undoIdx + 1);
  _undoHistory.push(snap);
  if (_undoHistory.length > 50) _undoHistory.shift();
  _undoIdx = _undoHistory.length - 1;
}
function schedulePropHistoryPush() {
  clearTimeout(_propChangeTimer);
  _propChangeTimer = setTimeout(saveUndoState, 800);
}
function undo() {
  clearTimeout(_propChangeTimer); _propChangeTimer = null; // pending 변경 버림, 저장 안 함
  if (_undoIdx <= 0) { showToast('더 이상 되돌릴 수 없습니다'); return; }
  _undoIdx--;
  components = JSON.parse(JSON.stringify(_undoHistory[_undoIdx]));
  selectedId = null;
  renderCanvas(); renderProps();
  markDirty();
  showToast('되돌림 (' + _undoIdx + '/' + (_undoHistory.length-1) + ')');
}

// ── 노드 트리 ─────────────────────────────────────────────
function buildTree(pid=null) {
  return allNodes.filter(n=>pid===null?n.parent_id===null:n.parent_id===pid)
    .sort((a,b)=>a.position-b.position).map(n=>({...n,children:buildTree(n.id)}));
}
function renderTree() {
  if (_inlineEditing) return;
  const tree=buildTree();
  const el=document.getElementById('nodeTree');
  el.innerHTML=tree.length?renderTreeHtml(tree,0):'<div class="node-tree-empty">화면이 없습니다</div>';
}
function renderTreeHtml(nodes, depth) {
  return nodes.map(n=>`
    <div class="node-item${n.id===currentNodeId?' active':''}" data-nid="${n.id}" style="padding-left:${8+depth*14}px" onclick="selectNode(${n.id})">
      <span class="node-item-icon">${n.children.length?'▾':'·'}</span>
      <span class="node-item-title" ondblclick="event.stopPropagation();inlineEditTitle(${n.id},event)">${escHtml(n.title)}</span>
      <div class="node-item-actions">
        <button title="하위 추가" onclick="event.stopPropagation();addNode(${n.id})">+</button>
        <button title="삭제" onclick="event.stopPropagation();confirmDeleteNode(${n.id},'${escHtml(n.title).replace(/'/g,"\\'")}')">×</button>
      </div>
    </div>
    ${n.children.length?renderTreeHtml(n.children,depth+1):''}`).join('');
}

// 미저장 변경 확인 3-버튼 모달: 'save' | 'discard' | 'cancel'
function showConfirmModal(msg) {
  return new Promise(resolve => {
    const overlay = document.getElementById('sdConfirmModal');
    document.getElementById('sdConfirmMsg').textContent = msg;
    overlay.style.display = 'flex';
    overlay.dataset.resolved = '';
    const done = (val) => {
      if (overlay.dataset.resolved) return;
      overlay.dataset.resolved = '1';
      overlay.style.display = 'none';
      resolve(val);
    };
    overlay._resolveSave    = () => done('save');
    overlay._resolveDiscard = () => done('discard');
    overlay._resolveCancel  = () => done('cancel');
  });
}

async function selectNode(id) {
  if (currentNodeId && currentNodeId !== id) {
    syncCurrentNodeToMemory();
    if (_dirtyNodeIds.has(currentNodeId)) {
      const action = await showConfirmModal('저장하지 않은 변경사항이 있습니다.');
      if (action === 'cancel') return;
      if (action === 'save') await saveAll();
    }
  }
  currentNodeId=id;
  const node=allNodes.find(n=>n.id===id); if(!node) return;
  components=JSON.parse(JSON.stringify(node.components||[]));
  selectedId=null;
  // 히스토리 초기화
  _undoHistory=[]; _undoIdx=-1;
  saveUndoState();
  document.getElementById('nodeTitle').value=node.title||'';
  document.getElementById('nodeEmpty').style.display='none';
  document.getElementById('nodePanel').style.display='flex';
  renderTree();
  renderCanvas();
  renderProps();
}

// ── 노드 추가/삭제 ────────────────────────────────────────
async function addNode(parentId) {
  if (_addingNode) return; _addingNode=true;
  try {
    const res=await sdApi(`/screen-designer/projects/${projectId}/nodes`,{method:'POST',body:JSON.stringify({parent_id:parentId})});
    if (!res.ok) throw new Error();
    const {node}=await res.json();
    allNodes.push(node); renderTree(); await selectNode(node.id);
    const el=document.querySelector(`.node-item[data-nid="${node.id}"] .node-item-title`);
    if (el) startInlineEdit(node.id,el,node.title||'');
  } catch(e) { showToast('추가 실패: '+e.message); }
  finally { _addingNode=false; }
}
function countDescendants(id) {
  return allNodes.filter(n => n.parent_id === id)
    .reduce((sum, c) => sum + 1 + countDescendants(c.id), 0);
}
function confirmDeleteNode(id, title) {
  const childCount = countDescendants(id);
  const msg = childCount > 0
    ? `"${title}" 화면을 삭제하시겠습니까?\n\n하위 화면 ${childCount}개도 함께 삭제됩니다.`
    : `"${title}" 화면을 삭제하시겠습니까?`;
  if (!confirm(msg)) return;
  deleteNode(id);
}
function deleteCurrentNode() {
  if (!currentNodeId) return;
  const n=allNodes.find(n=>n.id===currentNodeId);
  confirmDeleteNode(currentNodeId,n?.title||'화면');
}
async function deleteNode(id) {
  try {
    await sdApi(`/screen-designer/projects/${projectId}/nodes/${id}`,{method:'DELETE'});
    allNodes=(await(await sdApi(`/screen-designer/projects/${projectId}/nodes`)).json()).nodes||[];
    _dirtyNodeIds.delete(id);
    if (currentNodeId===id) {
      currentNodeId=null; components=[]; selectedId=null;
      document.getElementById('nodePanel').style.display='none';
      document.getElementById('nodeEmpty').style.display='';
    }
    renderTree();
  } catch { showToast('삭제 실패'); }
}

// ── 인라인 제목 편집 (더블클릭만) ────────────────────────
async function inlineEditTitle(nodeId,e) {
  e.stopPropagation();
  const node=allNodes.find(n=>n.id===nodeId); if(!node) return;
  if (currentNodeId !== nodeId) await selectNode(nodeId);
  const el=document.querySelector(`.node-item[data-nid="${nodeId}"] .node-item-title`);
  if (el) startInlineEdit(nodeId,el,allNodes.find(n=>n.id===nodeId)?.title||node.title);
}
function startInlineEdit(nodeId,titleEl,cur) {
  _inlineEditing = true;
  const inp=document.createElement('input');
  inp.type='text'; inp.value=cur; inp.className='node-title-inline-edit';
  titleEl.replaceWith(inp); inp.focus(); inp.select();
  let done=false;
  const finish=async(save)=>{
    if (done) return; done=true;
    _inlineEditing = false;
    const newTitle=inp.value.trim();
    if (!save||!newTitle||newTitle===cur) { renderTree(); return; }
    try {
      const res=await sdApi(`/screen-designer/projects/${projectId}/nodes/${nodeId}`,{method:'PUT',body:JSON.stringify({title:newTitle})});
      if (!res.ok) throw new Error();
      const idx=allNodes.findIndex(n=>n.id===nodeId);
      if (idx>=0) allNodes[idx].title=newTitle;
      if (currentNodeId===nodeId) document.getElementById('nodeTitle').value=newTitle;
      renderTree(); showToast('저장됨');
    } catch { showToast('저장 실패'); renderTree(); }
  };
  inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();finish(true);} if(e.key==='Escape')finish(false); });
  inp.addEventListener('blur',()=>finish(true));
}

// ── 노드 저장 ─────────────────────────────────────────────
async function saveCurrentNode(silent = false) {
  if (!currentNodeId) return;
  const nodeId = currentNodeId;
  const title=document.getElementById('nodeTitle').value.trim()||'새 화면';
  const snap = JSON.parse(JSON.stringify(components));
  snap.forEach(c => { delete c._open; });
  try {
    const res=await sdApi(`/screen-designer/projects/${projectId}/nodes/${nodeId}`,{method:'PUT',body:JSON.stringify({title,components:snap})});
    if (!res.ok) throw new Error();
    const idx=allNodes.findIndex(n=>n.id===nodeId);
    if (idx>=0) { allNodes[idx].title=title; allNodes[idx].components=snap; }
    renderTree();
    if (!silent) showToast('화면 저장됨');
  } catch { if (!silent) showToast('저장 실패'); }
}

// ─────────────────────────────────────────────────────────
// ── 캔버스 에디터 ─────────────────────────────────────────
// ─────────────────────────────────────────────────────────

function setPaletteType(type) {
  paletteType=type;
  document.querySelectorAll('.palette-btn').forEach(b=>b.classList.remove('active'));
  if (type) {
    document.querySelector(`.palette-btn[data-type="${type}"]`)?.classList.add('active');
    document.getElementById('sdCanvas').style.cursor='crosshair';
  } else {
    document.getElementById('palettePointer').classList.add('active');
    document.getElementById('sdCanvas').style.cursor='default';
  }
}

function canvasCoords(e) {
  const canvas=document.getElementById('sdCanvas');
  const rect=canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// 포커스가 프로퍼티 패널이나 캔버스에 있는지 (사이드바/헤더 입력창 제외)
function isInCanvasContext(target) {
  if (!target.matches('input,textarea,select,[contenteditable]')) return true;
  return !!target.closest('#sdProps');
}

function initCanvasEvents() {
  const canvas=document.getElementById('sdCanvas');

  canvas.addEventListener('mousedown', e => {
    if (e.target.closest('.sd-resize-handle') || e.target.closest('.sd-comp')) return;
    const {x,y}=canvasCoords(e);
    if (paletteType) {
      _op={type:'draw', startX:x, startY:y, curX:x, curY:y};
      updateRubberBand(x,y,x,y);
      return;
    }
    selectedId=null; renderCanvas(); renderProps();
  });

  document.addEventListener('mousemove', e => {
    if (!_op) return;
    const {x,y}=canvasCoords(e);
    if (_op.type==='draw') {
      updateRubberBand(_op.startX, _op.startY, x, y);
    } else if (_op.type==='move') {
      const comp=components.find(c=>c.id===selectedId);
      if (comp) {
        comp.x=Math.max(0,_op.origX+(x-_op.startX));
        comp.y=Math.max(0,_op.origY+(y-_op.startY));
        const el=document.querySelector(`.sd-comp[data-id="${comp.id}"]`);
        if (el) { el.style.left=comp.x+'px'; el.style.top=comp.y+'px'; }
      }
    } else if (_op.type==='resize') {
      const comp=components.find(c=>c.id===selectedId);
      if (comp) {
        const dx=x-_op.startX, dy=y-_op.startY;
        const h=_op.handle;
        if (h.includes('r')) comp.w=Math.max(40,_op.origW+dx);
        if (h.includes('b')) comp.h=Math.max(24,_op.origH+dy);
        if (h.includes('l')) { comp.w=Math.max(40,_op.origW-dx); comp.x=_op.origX+(_op.origW-comp.w); }
        if (h.includes('t')) { comp.h=Math.max(24,_op.origH-dy); comp.y=_op.origY+(_op.origH-comp.h); }
        const el=document.querySelector(`.sd-comp[data-id="${comp.id}"]`);
        if (el) { el.style.left=comp.x+'px'; el.style.top=comp.y+'px'; el.style.width=comp.w+'px'; el.style.height=comp.h+'px'; }
        positionHandles(comp);
      }
    }
  });

  document.addEventListener('mouseup', e => {
    if (!_op) return;
    if (_op.type==='draw') {
      const {x,y}=canvasCoords(e);
      finishDraw(_op.startX, _op.startY, x, y);
    } else if (_op.type==='move' || _op.type==='resize') {
      renderCanvas();
      saveUndoState();
      markDirty();
    }
    _op=null;
  });

  document.addEventListener('keydown', e => {
    // ── Ctrl+S: 저장 ─────────────────────────────────────
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault(); saveAll(); return;
    }

    // ── Ctrl+Z: 실행취소 (props 패널 포함) ──────────────
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (isInCanvasContext(e.target)) {
        e.preventDefault(); undo(); return;
      }
    }

    // ── Ctrl+C: 컴포넌트 복사 (props 패널 포함) ─────────
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selectedId) {
      if (isInCanvasContext(e.target)) {
        e.preventDefault();
        _clipboard = JSON.parse(JSON.stringify(components.find(c => c.id === selectedId)));
        showToast('복사됨'); return;
      }
    }

    // ── Ctrl+V: 컴포넌트 붙여넣기 (props 패널 포함) ─────
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && _clipboard) {
      if (isInCanvasContext(e.target)) {
        e.preventDefault();
        const newComp = JSON.parse(JSON.stringify(_clipboard));
        delete newComp._open;
        newComp.id = genId();
        newComp.x = Math.min((newComp.x||0) + 20, 900);
        newComp.y = Math.min((newComp.y||0) + 20, 540);
        components.push(newComp);
        selectedId = newComp.id;
        renderCanvas(); renderProps();
        focusFirstPropInput();
        saveUndoState();
        markDirty(); return;
      }
    }

    // 이하: 텍스트 입력창에 포커스 있으면 무시
    if (e.target.matches('input,textarea,select,[contenteditable]')) return;

    // ── Delete: 선택 컴포넌트 삭제 ──────────────────────
    if (e.key === 'Delete' && selectedId) {
      deleteSelectedComp(); return;
    }

  });
}

function updateRubberBand(sx,sy,ex,ey) {
  const rb=document.getElementById('sdRubberBand');
  const x=Math.min(sx,ex), y=Math.min(sy,ey);
  const w=Math.abs(ex-sx), h=Math.abs(ey-sy);
  rb.style.cssText=`display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
}

function finishDraw(sx,sy,ex,ey) {
  document.getElementById('sdRubberBand').style.display='none';
  const rawW=Math.abs(ex-sx), rawH=Math.abs(ey-sy);
  if (rawW < 8 && rawH < 8) return; // 단순 클릭 취소 (드래그만 생성)
  const x=Math.min(sx,ex), y=Math.min(sy,ey);
  let w=rawW, h=rawH;
  const defs=COMP_DEFAULTS[paletteType];
  if (w<20) w=defs.w;
  if (h<20) h=defs.h;
  const comp={id:genId(), type:paletteType, x:Math.max(0,x), y:Math.max(0,y), w, h, props:JSON.parse(JSON.stringify(defs.props))};
  components.push(comp);
  selectedId=comp.id;
  setPaletteType(null);
  renderCanvas();
  renderProps();
  focusFirstPropInput();
  saveUndoState();
  markDirty();
}

// ── 캔버스 렌더링 ─────────────────────────────────────────
function renderCanvas() {
  const canvas=document.getElementById('sdCanvas');
  const rb=document.getElementById('sdRubberBand');
  canvas.innerHTML='';
  canvas.appendChild(rb);

  // section은 뒤에 깔리도록 먼저 렌더
  const sorted=[...components].sort((a,b)=>(a.type==='section'?0:1)-(b.type==='section'?0:1));
  sorted.forEach(comp=>{
    const el=document.createElement('div');
    el.className='sd-comp'+(comp.id===selectedId?' selected':'');
    el.dataset.id=comp.id;
    el.style.cssText=`left:${comp.x}px;top:${comp.y}px;width:${comp.w}px;height:${comp.h}px`;
    el.innerHTML=getCompHtml(comp);

    el.addEventListener('mousedown', e => {
      if (e.target.closest('.sd-resize-handle')) return;
      if (paletteType) return;
      e.stopPropagation();
      const prevId = selectedId;
      selectedId = comp.id;
      // select 클릭 시: 선택만 업데이트, native 드롭다운 동작 유지
      if (e.target.matches('select') || e.target.closest('select')) {
        if (prevId !== comp.id) {
          document.querySelectorAll('.sd-comp').forEach(c =>
            c.classList.toggle('selected', c.dataset.id === String(comp.id)));
          renderProps();
        }
        return;
      }
      const {x,y} = canvasCoords(e);
      _op = {type:'move', startX:x, startY:y, origX:comp.x, origY:comp.y};
      renderCanvas();
      renderProps();
      focusFirstPropInput();
    });

    // 드롭다운 더블클릭 → 펼치기/접기
    el.addEventListener('dblclick', e => {
      if (comp.type === 'dropdown') {
        e.stopPropagation();
        comp._open = !comp._open;
        el.innerHTML = getCompHtml(comp);
      }
    });

    canvas.appendChild(el);

    if (comp.id===selectedId) renderHandles(canvas, comp);
  });
}

function renderHandles(canvas, comp) {
  const handles=['tl','t','tr','r','br','b','bl','l'];
  handles.forEach(h=>{
    const d=document.createElement('div');
    d.className='sd-resize-handle'; d.dataset.handle=h;
    setHandlePos(d, comp, h);
    d.addEventListener('mousedown', e=>{
      e.stopPropagation(); e.preventDefault();
      _op={type:'resize', handle:h, startX:canvasCoords(e).x, startY:canvasCoords(e).y,
           origX:comp.x, origY:comp.y, origW:comp.w, origH:comp.h};
    });
    canvas.appendChild(d);
  });
}
function setHandlePos(el, comp, h) {
  const S=8, HS=S/2;
  const hm={ tl:{l:-HS,t:-HS}, t:{l:comp.w/2-HS,t:-HS}, tr:{l:comp.w-HS,t:-HS},
              r:{l:comp.w-HS,t:comp.h/2-HS}, br:{l:comp.w-HS,t:comp.h-HS},
              b:{l:comp.w/2-HS,t:comp.h-HS}, bl:{l:-HS,t:comp.h-HS}, l:{l:-HS,t:comp.h/2-HS} };
  const pos=hm[h];
  el.style.cssText=`left:${comp.x+pos.l}px;top:${comp.y+pos.t}px;width:${S}px;height:${S}px;cursor:${h}-resize`;
}
function positionHandles(comp) {
  ['tl','t','tr','r','br','b','bl','l'].forEach(h=>{
    const el=document.querySelector(`.sd-resize-handle[data-handle="${h}"]`);
    if (el) setHandlePos(el,comp,h);
  });
}

// ── 컴포넌트 HTML ─────────────────────────────────────────
function getCompHtml(c) {
  const p=c.props||{};
  switch(c.type) {
    case 'radio': {
      const opts=(p.options||'').split('\n').map(s=>s.trim()).filter(Boolean);
      return `<div class="sd-field"><label class="sd-field-label">${escHtml(p.label||'')}</label>
        <div class="sd-radio-group">${opts.map((o,i)=>`<label class="sd-radio-opt"><input type="radio" tabindex="-1" ${i===0?' checked':''}/> ${escHtml(o)}</label>`).join('')}</div></div>`;
    }
    case 'checkbox': {
      const opts=(p.options||'').split('\n').map(s=>s.trim()).filter(Boolean);
      return `<div class="sd-field"><label class="sd-field-label">${escHtml(p.label||'')}</label>
        <div class="sd-radio-group">${opts.map(o=>`<label class="sd-radio-opt"><input type="checkbox" tabindex="-1" /> ${escHtml(o)}</label>`).join('')}</div></div>`;
    }
    case 'input':
      return `<div class="sd-field"><label class="sd-field-label">${escHtml(p.label||'')}</label><input class="sd-input" placeholder="${escHtml(p.placeholder||'')}" tabindex="-1" /></div>`;
    case 'button': {
      const icon = p.linkType==='node' && p.linkedNodeId ? ' <span style="font-size:.72em;opacity:.7">📑</span>' : (p.url ? ' <span style="font-size:.72em;opacity:.7">🔗</span>' : '');
      return `<button class="sd-btn sd-btn-${p.variant||'default'}" tabindex="-1">${escHtml(p.label||'버튼')}${icon}</button>`;
    }
    case 'dropdown': {
      const opts=Array.isArray(p.options)?p.options:[];
      if (c._open) {
        const optHtml=opts.map(o=>`<div class="sd-dropdown-opt">${escHtml(o.text||o.key||'')}</div>`).join('');
        return `<div class="sd-field"><label class="sd-field-label">${escHtml(p.label||'')}</label><div class="sd-dropdown-expanded">${optHtml}</div></div>`;
      }
      return `<div class="sd-field"><label class="sd-field-label">${escHtml(p.label||'')}</label><select class="sd-select" tabindex="-1">${opts.map(o=>`<option value="${escHtml(o.key||'')}">${escHtml(o.text||o.key||'')}</option>`).join('')}</select></div>`;
    }
    case 'popupBtn': {
      const icon = p.linkType==='node' && p.linkedNodeId ? ' <span style="font-size:.72em;opacity:.7">📑</span>' : (p.url ? ' <span style="font-size:.72em;opacity:.7">↗</span>' : '');
      return `<button class="sd-btn sd-btn-popup" tabindex="-1">${escHtml(p.label||'팝업버튼')}${icon}</button>`;
    }
    case 'text': {
      const fsMap={xs:'0.72rem',sm:'0.82rem',md:'0.95rem',lg:'1.1rem',xl:'1.35rem',xxl:'1.6rem'};
      const fs=fsMap[p.fontSize||'md']||'0.95rem';
      return `<span class="sd-label-text" style="font-size:${fs};font-weight:${p.bold?'700':'400'};color:${escHtml(p.color||'#1D2D3E')}">${escHtml(p.content||'텍스트')}</span>`;
    }
    case 'section': {
      const bg=escHtml(p.bgColor||'#fdf3ec'), bc=escHtml(p.borderColor||'#c9a87c');
      return `<div class="sd-section-comp" style="background:${bg};border-color:${bc}">
        ${p.showTitle!==false?`<div class="sd-section-title" style="border-bottom-color:${bc}">${escHtml(p.title||'섹션')}</div>`:''}
        <div class="sd-section-body"></div>
      </div>`;
    }
    case 'formRow': {
      const lw=`${p.labelWidth||90}px`;
      const rangeHtml=p.hasRange
        ?`<span class="sd-formrow-range-label">${escHtml(p.rangeLabel||'종료')}</span><input class="sd-formrow-input" tabindex="-1" />`:'';
      return `<div class="sd-formrow">
        <span class="sd-formrow-label" style="width:${lw}">${escHtml(p.label||'항목명')}</span>
        <input class="sd-formrow-input" placeholder="${escHtml(p.placeholder||'')}" tabindex="-1" />
        ${rangeHtml}
      </div>`;
    }
    case 'table': {
      const cols=(p.columns||'컬럼1,컬럼2,컬럼3').split(',').map(s=>s.trim()).filter(Boolean);
      const rows=Math.max(1,Math.min(20,parseInt(p.rows)||4));
      return `<div style="width:100%;height:100%;overflow:auto">
        <table class="sd-table-comp">
          <thead><tr>${cols.map(c=>`<th>${escHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>${Array.from({length:rows}).map(()=>`<tr>${cols.map(()=>`<td>&nbsp;</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;
    }
    case 'toolbar': {
      const btns=(p.buttons||'').split('\n').map(s=>s.trim()).filter(Boolean);
      return `<div class="sd-toolbar-comp">${btns.map(b=>`<button class="sd-btn sd-btn-default" tabindex="-1">${escHtml(b)}</button>`).join('')}</div>`;
    }
    default: return `<div class="sd-unknown">${c.type}</div>`;
  }
}

// ── 속성 패널 포커스 헬퍼 ────────────────────────────────
function focusFirstPropInput() {
  requestAnimationFrame(() => {
    const inp = document.querySelector('#sdProps input.prop-input:not([type="color"]):not([type="number"]), #sdProps textarea.prop-textarea');
    if (inp) inp.focus();
  });
}

// ── 속성 패널 ─────────────────────────────────────────────
function renderProps() {
  const el=document.getElementById('sdProps');
  if (!selectedId) { el.innerHTML='<div class="props-empty">컴포넌트를 선택하세요</div>'; return; }
  const comp=components.find(c=>c.id===selectedId);
  if (!comp) { el.innerHTML='<div class="props-empty">선택 없음</div>'; return; }

  const p=comp.props||{};

  let fields='';
  switch(comp.type) {
    case 'radio':
      fields=`<label class="prop-label">레이블</label>
        <input class="prop-input" value="${escHtml(p.label||'')}" oninput="setProp('label',this.value)" />
        <label class="prop-label">옵션 (줄바꿈으로 구분)</label>
        <textarea class="prop-textarea" rows="4" oninput="setProp('options',this.value)">${escHtml(p.options||'')}</textarea>`;
      break;
    case 'checkbox':
      fields=`<label class="prop-label">레이블</label>
        <input class="prop-input" value="${escHtml(p.label||'')}" oninput="setProp('label',this.value)" />
        <label class="prop-label">항목 (줄바꿈으로 구분)</label>
        <textarea class="prop-textarea" rows="4" oninput="setProp('options',this.value)">${escHtml(p.options||'')}</textarea>`;
      break;
    case 'input':
      fields=`<label class="prop-label">레이블</label>
        <input class="prop-input" value="${escHtml(p.label||'')}" oninput="setProp('label',this.value)" />
        <label class="prop-label">Placeholder</label>
        <input class="prop-input" value="${escHtml(p.placeholder||'')}" oninput="setProp('placeholder',this.value)" />`;
      break;
    case 'button': {
      const lt = p.linkType || 'url';
      const nodeOpts = allNodes.map(n=>`<option value="${n.id}"${p.linkedNodeId===n.id?' selected':''}>${escHtml(n.title)}</option>`).join('');
      fields=`<label class="prop-label">레이블</label>
        <input class="prop-input" value="${escHtml(p.label||'')}" oninput="setProp('label',this.value)" />
        <label class="prop-label">스타일</label>
        <select class="prop-input" onchange="setProp('variant',this.value)">
          <option value="default"${!p.variant||p.variant==='default'?' selected':''}>기본</option>
          <option value="primary"${p.variant==='primary'?' selected':''}>강조(파란색)</option>
          <option value="danger"${p.variant==='danger'?' selected':''}>위험(빨간색)</option>
        </select>
        <label class="prop-label">클릭 연결</label>
        <div class="prop-row" style="gap:.5rem;margin-bottom:.4rem">
          <label style="display:flex;align-items:center;gap:.25rem;cursor:pointer"><input type="radio" name="btnLT" value="url" ${lt==='url'?'checked':''} onchange="setLinkType('url')" /> 외부 URL</label>
          <label style="display:flex;align-items:center;gap:.25rem;cursor:pointer"><input type="radio" name="btnLT" value="node" ${lt==='node'?'checked':''} onchange="setLinkType('node')" /> 화면 연결</label>
        </div>
        ${lt==='url'
          ? `<input class="prop-input" placeholder="https://..." value="${escHtml(p.url||'')}" oninput="setProp('url',this.value)" />`
          : `<select class="prop-input" onchange="setProp('linkedNodeId',+this.value||null)"><option value="">선택하세요</option>${nodeOpts}</select>`}`;
      break;
    }
    case 'dropdown':
      fields=`<label class="prop-label">레이블</label>
        <input class="prop-input" value="${escHtml(p.label||'')}" oninput="setProp('label',this.value)" />
        <label class="prop-label">옵션 목록 · 더블클릭 펼치기</label>
        <div class="prop-table-wrap">
          <table class="prop-kv-table">
            <thead><tr><th>키(key)</th><th>텍스트</th><th></th></tr></thead>
            <tbody>${buildDropdownRows(p.options)}</tbody>
          </table>
          <button class="prop-add-row-btn" onclick="addDropdownRow()">+ 옵션 추가</button>
        </div>`;
      break;
    case 'popupBtn': {
      const lt = p.linkType || 'url';
      const nodeOpts = allNodes.map(n=>`<option value="${n.id}"${p.linkedNodeId===n.id?' selected':''}>${escHtml(n.title)}</option>`).join('');
      fields=`<label class="prop-label">레이블</label>
        <input class="prop-input" value="${escHtml(p.label||'')}" oninput="setProp('label',this.value)" />
        <label class="prop-label">팝업 연결</label>
        <div class="prop-row" style="gap:.5rem;margin-bottom:.4rem">
          <label style="display:flex;align-items:center;gap:.25rem;cursor:pointer"><input type="radio" name="popupLT" value="url" ${lt==='url'?'checked':''} onchange="setLinkType('url')" /> 외부 URL</label>
          <label style="display:flex;align-items:center;gap:.25rem;cursor:pointer"><input type="radio" name="popupLT" value="node" ${lt==='node'?'checked':''} onchange="setLinkType('node')" /> 화면 팝업</label>
        </div>
        ${lt==='url'
          ? `<input class="prop-input" placeholder="https://..." value="${escHtml(p.url||'')}" oninput="setProp('url',this.value)" />`
          : `<select class="prop-input" onchange="setProp('linkedNodeId',+this.value||null)"><option value="">선택하세요</option>${nodeOpts}</select>`}`;
      break;
    }
    case 'text':
      fields=`<label class="prop-label">내용</label>
        <input class="prop-input" value="${escHtml(p.content||'')}" oninput="setProp('content',this.value)" />
        <label class="prop-label">크기</label>
        <select class="prop-input" onchange="setProp('fontSize',this.value)">
          <option value="xs"${p.fontSize==='xs'?' selected':''}>xs — 매우 작게</option>
          <option value="sm"${p.fontSize==='sm'?' selected':''}>sm — 작게</option>
          <option value="md"${(!p.fontSize||p.fontSize==='md')?' selected':''}>md — 보통 (기본)</option>
          <option value="lg"${p.fontSize==='lg'?' selected':''}>lg — 크게</option>
          <option value="xl"${p.fontSize==='xl'?' selected':''}>xl — 매우 크게</option>
          <option value="xxl"${p.fontSize==='xxl'?' selected':''}>xxl — 제목</option>
        </select>
        <div class="prop-row" style="align-items:center;gap:.5rem;margin-top:.1rem">
          <label style="display:flex;align-items:center;gap:.3rem;font-size:.78rem;cursor:pointer">
            <input type="checkbox" ${p.bold?'checked':''} onchange="setProp('bold',this.checked)" /> 굵게 (Bold)
          </label>
        </div>
        <label class="prop-label">색상</label>
        <input type="color" class="prop-input" value="${p.color||'#1D2D3E'}" oninput="setProp('color',this.value)" />`;
      break;
    case 'section':
      fields=`<label class="prop-label">섹션 제목</label>
        <input class="prop-input" value="${escHtml(p.title||'')}" oninput="setProp('title',this.value)" />
        <div class="prop-row" style="align-items:center;gap:.5rem;margin-top:.1rem">
          <label style="display:flex;align-items:center;gap:.3rem;font-size:.78rem;cursor:pointer">
            <input type="checkbox" ${p.showTitle!==false?'checked':''} onchange="setProp('showTitle',this.checked)" /> 제목 표시
          </label>
        </div>
        <label class="prop-label">배경색</label>
        <input type="color" class="prop-input" value="${p.bgColor||'#fdf3ec'}" oninput="setProp('bgColor',this.value)" />
        <label class="prop-label">테두리색</label>
        <input type="color" class="prop-input" value="${p.borderColor||'#c9a87c'}" oninput="setProp('borderColor',this.value)" />`;
      break;
    case 'formRow':
      fields=`<label class="prop-label">레이블</label>
        <input class="prop-input" value="${escHtml(p.label||'')}" oninput="setProp('label',this.value)" />
        <label class="prop-label">Placeholder</label>
        <input class="prop-input" value="${escHtml(p.placeholder||'')}" oninput="setProp('placeholder',this.value)" />
        <label class="prop-label">레이블 너비 (px)</label>
        <input class="prop-input" type="number" value="${p.labelWidth||90}" oninput="setProp('labelWidth',+this.value||90)" />
        <div class="prop-row" style="align-items:center;gap:.5rem;margin-top:.1rem">
          <label style="display:flex;align-items:center;gap:.3rem;font-size:.78rem;cursor:pointer">
            <input type="checkbox" ${p.hasRange?'checked':''} onchange="setProp('hasRange',this.checked)" /> 범위 입력 (시작~종료)
          </label>
        </div>
        ${p.hasRange?`<label class="prop-label">종료 레이블</label>
        <input class="prop-input" value="${escHtml(p.rangeLabel||'종료')}" oninput="setProp('rangeLabel',this.value)" />`:''}`;
      break;
    case 'table':
      fields=`<label class="prop-label">컬럼 (쉼표 구분)</label>
        <input class="prop-input" value="${escHtml(p.columns||'')}" oninput="setProp('columns',this.value)" />
        <label class="prop-label">데이터 행 수</label>
        <input class="prop-input" type="number" min="1" max="20" value="${p.rows||4}" oninput="setProp('rows',+this.value||4)" />`;
      break;
    case 'toolbar':
      fields=`<label class="prop-label">버튼 목록 (줄바꿈 구분)</label>
        <textarea class="prop-textarea" rows="5" oninput="setProp('buttons',this.value)">${escHtml(p.buttons||'')}</textarea>`;
      break;
  }

  const typeNames={radio:'라디오버튼',checkbox:'체크박스',input:'입력창',button:'버튼',dropdown:'드롭다운',popupBtn:'팝업버튼',text:'텍스트',section:'섹션박스',formRow:'폼 행',table:'테이블',toolbar:'툴바'};
  el.innerHTML=`
    <div class="props-header" style="display:flex;align-items:center;justify-content:space-between">
      <span>${typeNames[comp.type]||comp.type} 속성</span>
      <button onclick="deleteSelectedComp()" style="padding:.2rem .55rem;border:1.5px solid var(--danger,#ef4444);border-radius:5px;background:transparent;color:var(--danger,#ef4444);font-size:.76rem;font-weight:700;cursor:pointer" title="삭제 (Del)">🗑 삭제</button>
    </div>
    <div class="props-body">
      <div class="prop-section-label">위치 / 크기</div>
      <div class="prop-row">
        <span class="prop-label">X</span><input class="prop-input" type="number" value="${comp.x}" oninput="setGeom('x',+this.value)" />
        <span class="prop-label">Y</span><input class="prop-input" type="number" value="${comp.y}" oninput="setGeom('y',+this.value)" />
      </div>
      <div class="prop-row">
        <span class="prop-label">W</span><input class="prop-input" type="number" value="${comp.w}" oninput="setGeom('w',+this.value)" />
        <span class="prop-label">H</span><input class="prop-input" type="number" value="${comp.h}" oninput="setGeom('h',+this.value)" />
      </div>
      <hr class="props-divider" />
      ${fields}
      <hr class="props-divider" />
      <div class="prop-section-label">참고 설명</div>
      <textarea class="prop-textarea" rows="3" placeholder="이 컴포넌트의 용도, 동작 방식, 참고 사항..." oninput="setCompNote(this.value)">${escHtml(p._note||'')}</textarea>
    </div>`;
}

function setLinkType(type) {
  const comp = components.find(c => c.id === selectedId);
  if (!comp) return;
  comp.props = comp.props || {};
  comp.props.linkType = type;
  if (type === 'url') comp.props.linkedNodeId = null;
  else comp.props.url = '';
  markDirty(); renderCanvas(); renderProps(); schedulePropHistoryPush();
}

// ── 드롭다운 옵션 헬퍼 ───────────────────────────────────
function buildDropdownRows(options) {
  const opts = Array.isArray(options) ? options : [];
  return opts.map((o, i) =>
    `<tr>
      <td><input class="prop-input" value="${escHtml(o.key||'')}" oninput="updateDropdownRow(${i},'key',this.value)" /></td>
      <td><input class="prop-input" value="${escHtml(o.text||'')}" oninput="updateDropdownRow(${i},'text',this.value)" /></td>
      <td><button class="prop-del-row-btn" onclick="removeDropdownRow(${i})">×</button></td>
    </tr>`
  ).join('');
}
function addDropdownRow() {
  const comp=components.find(c=>c.id===selectedId); if(!comp) return;
  comp.props=comp.props||{};
  const opts=Array.isArray(comp.props.options)?comp.props.options:[];
  opts.push({key: String(opts.length+1), text: '옵션'+(opts.length+1)});
  comp.props.options=opts;
  const el=document.querySelector(`.sd-comp[data-id="${comp.id}"]`);
  if (el) el.innerHTML=getCompHtml(comp);
  renderProps();
  schedulePropHistoryPush(); markDirty();
}
function removeDropdownRow(idx) {
  const comp=components.find(c=>c.id===selectedId); if(!comp) return;
  const opts=Array.isArray(comp.props.options)?comp.props.options:[];
  opts.splice(idx,1); comp.props.options=opts;
  const el=document.querySelector(`.sd-comp[data-id="${comp.id}"]`);
  if (el) el.innerHTML=getCompHtml(comp);
  renderProps();
  schedulePropHistoryPush(); markDirty();
}
function updateDropdownRow(idx, field, val) {
  const comp=components.find(c=>c.id===selectedId); if(!comp) return;
  const opts=Array.isArray(comp.props.options)?comp.props.options:[];
  if (opts[idx]) { opts[idx]={...opts[idx],[field]:val}; comp.props.options=opts; }
  const el=document.querySelector(`.sd-comp[data-id="${comp.id}"]`);
  if (el) el.innerHTML=getCompHtml(comp);
  schedulePropHistoryPush(); markDirty();
}

function setProp(key, val) {
  const comp=components.find(c=>c.id===selectedId); if(!comp) return;
  comp.props=comp.props||{}; comp.props[key]=val;
  const el=document.querySelector(`.sd-comp[data-id="${comp.id}"]`);
  if (el) el.innerHTML=getCompHtml(comp);
  schedulePropHistoryPush();
  markDirty();
}
function setGeom(key, val) {
  const comp=components.find(c=>c.id===selectedId); if(!comp) return;
  comp[key]=Math.max(key==='w'?40:key==='h'?24:0, val);
  const el=document.querySelector(`.sd-comp[data-id="${comp.id}"]`);
  if (el) {
    el.style.left=comp.x+'px'; el.style.top=comp.y+'px';
    el.style.width=comp.w+'px'; el.style.height=comp.h+'px';
  }
  positionHandles(comp);
  schedulePropHistoryPush();
  markDirty();
}
function setCompNote(val) {
  const comp=components.find(c=>c.id===selectedId); if(!comp) return;
  comp.props=comp.props||{}; comp.props._note=val;
  schedulePropHistoryPush();
  markDirty();
}

function deleteSelectedComp() {
  if (!selectedId) { showToast('삭제할 컴포넌트를 선택하세요'); return; }
  components=components.filter(c=>c.id!==selectedId);
  selectedId=null;
  renderCanvas(); renderProps();
  saveUndoState();
  markDirty();
}

// ── 사이드바 리사이즈 ─────────────────────────────────────
function initSidebarResize() {
  const handle=document.getElementById('sdSidebarResize'), sidebar=document.getElementById('sdSidebar');
  if (!handle||!sidebar) return;
  let drag=false, sx=0, sw=0;
  handle.addEventListener('mousedown', e=>{drag=true;sx=e.clientX;sw=sidebar.offsetWidth;handle.classList.add('resizing');e.preventDefault();});
  document.addEventListener('mousemove', e=>{ if(!drag) return; sidebar.style.width=Math.max(120,Math.min(320,sw+(e.clientX-sx)))+'px'; });
  document.addEventListener('mouseup', ()=>{drag=false;handle.classList.remove('resizing');});
}

// ── 토스트 ────────────────────────────────────────────────
let _toastTimer;
function showToast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(_toastTimer); _toastTimer=setTimeout(()=>t.classList.remove('show'),2500);
}
