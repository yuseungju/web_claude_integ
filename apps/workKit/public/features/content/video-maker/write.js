/* 동영상 제작 — 계층 노드 작업공간 */

const VM_API = 'https://nynhvk2xl3.execute-api.ap-southeast-2.amazonaws.com';
const projectId = parseInt(new URLSearchParams(window.location.search).get('id')) || 0;

let allNodes = [];
let currentNodeId = null;
let displayedObjects = [];
let _mediaMap = {};    // { objId: blobUrl(string) | presignedUrl(string) }
let _pendingFiles = {}; // { objId: {blob, filename, contentType} } — 저장 버튼 전까지 S3 미업로드
let _saving = false;   // 동시 저장 방지 잠금
let _merging = false;  // 합치기 진행 중 (메뉴이동/저장/추가 차단)
let _mergeSourceObjs = []; // 합치기에 사용된 소스 객체 (우측 패널 표시)
let _lastSavedTitle = '';
let _projTitleModified = false; // 사용자가 제목 수정 시 loadProject 덮어쓰기 방지
let _addingNode = false;
let _isPublished = false;
let _inlineEditing = false;

function getToken() { return localStorage.getItem('token'); }
function onProjTitleModified() { _projTitleModified = true; }
function genObjId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return 'obj' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
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

// ── IndexedDB (합쳐진 영상 로컬 저장) ────────────────────
let _vmDB = null;
function openVmDB() {
  if (_vmDB) return Promise.resolve(_vmDB);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vm_videos', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = e => { _vmDB = e.target.result; resolve(_vmDB); };
    req.onerror = e => { console.error('IDB open error:', e.target.error); reject(e.target.error); };
  });
}
async function idbPut(id, blob) {
  try {
    const db = await openVmDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(blob, id);
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
      tx.onabort = e => reject(e.target.error);
    });
    console.log('IDB saved:', id, Math.round(blob.size / 1024) + 'KB');
  } catch (e) { console.error('IDB put failed:', id, e); }
}
async function idbGet(id) {
  try {
    const db = await openVmDB();
    return await new Promise(resolve => {
      const req = db.transaction('blobs', 'readonly').objectStore('blobs').get(id);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror = e => { console.error('IDB get error:', id, e.target.error); resolve(null); };
    });
  } catch (e) { console.error('IDB get failed:', id, e); return null; }
}
async function idbDelete(id) {
  try {
    const db = await openVmDB();
    await new Promise(resolve => {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete(id);
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
  } catch (_) {}
}

// IDB에서 Blob 로드 → File 변환
async function loadMergedFromIDB(obj) {
  const blob = await idbGet(obj.id);
  if (!blob) return null;
  return blob instanceof File ? blob : new File([blob], obj.name, { type: blob.type || 'video/webm' });
}

// data URL → File 변환
async function dataUrlToFile(dataUrl, name, type) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], name, { type: blob.type || type || 'video/webm' });
  } catch { return null; }
}

// ── 초기화 ────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (_saving || _merging) { e.preventDefault(); e.returnValue = ''; }
});

document.addEventListener('DOMContentLoaded', () => {
  if (!projectId) { showToast('프로젝트 ID가 없습니다'); return; }
  loadProject();
  initSidebarResize();

  document.addEventListener('keydown', e => {
    if (!currentNodeId) return;
    if (e.target.matches('input,textarea,select,[contenteditable]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1 && e.key !== 'F2') return;
    const titleEl = document.querySelector(`.node-item[data-nid="${currentNodeId}"] .node-item-title`);
    if (!titleEl) return;
    e.preventDefault();
    const node = allNodes.find(n => n.id === currentNodeId);
    startInlineEdit(currentNodeId, titleEl, node?.title || '');
    if (e.key !== 'F2') {
      requestAnimationFrame(() => {
        const inp = document.querySelector('.node-title-inline-edit');
        if (inp) { inp.value = e.key; inp.setSelectionRange(1, 1); }
      });
    }
  });
});

async function loadProject() {
  try {
    const [projRes, nodesRes] = await Promise.all([
      vmApi(`/video-maker/projects/${projectId}`),
      vmApi(`/video-maker/projects/${projectId}/nodes`),
    ]);
    if (!projRes.ok) throw new Error('프로젝트를 찾을 수 없습니다');
    const { project } = await projRes.json();
    const titleEl = document.getElementById('projTitle');
    if (!_projTitleModified && document.activeElement !== titleEl) titleEl.value = project.title || '';
    _lastSavedTitle = project.title || '';
    document.title = `${project.title || '동영상 제작'} – WorkKit`;
    allNodes = (await nodesRes.json()).nodes || [];

    if (project.is_owner) {
      _isPublished = !!project.is_published;
      document.getElementById('saveDraftBtn').style.display = '';
      document.getElementById('publishBtn').style.display = '';
      document.getElementById('publishBadge').style.display = '';
      updatePublishUI();
    }

    renderTree();
  } catch (e) { showToast('불러오기 실패: ' + e.message); }
}

function updatePublishUI() {
  const badge = document.getElementById('publishBadge');
  const btn = document.getElementById('publishBtn');
  if (_isPublished) {
    badge.textContent = '게시됨';
    badge.className = 'publish-badge badge-done';
    btn.textContent = '🔒 게시 취소';
    btn.className = 'btn';
  } else {
    badge.textContent = '임시저장';
    badge.className = 'publish-badge badge-draft';
    btn.textContent = '📢 게시하기';
    btn.className = 'btn success publish-need-attention';
  }
}

// 저장/합치기/게시 중 공통 버튼 비활성화
function _setBusy(disabled) {
  ['saveDraftBtn', 'publishBtn', 'fetchBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  const addBtn = document.querySelector('#nodePanel .vm-toolbar .btn:not(.fetch-btn)');
  if (addBtn) addBtn.disabled = disabled;
  const mergeBtn = document.getElementById('mergeBtn');
  if (mergeBtn && !_merging) mergeBtn.disabled = disabled; // 합치기 중엔 doMerge가 직접 관리
}

async function togglePublish() {
  if (_merging || _saving) { showToast('처리 중입니다. 잠시 기다려 주세요.'); return; }
  _setBusy(true);
  try {
    const action = _isPublished ? 'unpublish' : 'publish';
    const res = await vmApi(`/video-maker/projects/${projectId}/${action}`, { method: 'PUT' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    _isPublished = !!data.project?.is_published;
    updatePublishUI();
    showToast(_isPublished ? '게시됐습니다. 누구나 조회할 수 있습니다.' : '게시가 취소됐습니다.');
  } catch (e) { showToast('실패: ' + e.message); }
  finally { _setBusy(false); }
}

// ── 프로젝트 저장 ─────────────────────────────────────────
async function saveProject() {
  if (_merging) { showToast('합치기 중입니다. 완료 후 저장하세요.'); return; }
  _setBusy(true);
  try {
    const title = document.getElementById('projTitle').value.trim() || '새 프로젝트';
    const res = await vmApi(`/video-maker/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({ title }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    _lastSavedTitle = title;
    await saveCurrentNode(false); // 업로드 실패 시 에러 토스트 표시
    // 미저장 pending 파일이 남아있으면 완전 성공 아님
    const stillPending = displayedObjects.some(o => _pendingFiles[o.id] && !o.s3_key);
    if (!stillPending) showToast('저장됐습니다.');
  } catch (e) { showToast('저장 실패: ' + e.message); }
  finally { _setBusy(false); }
}

// "← 목록" 클릭 시 현재 노드 저장 후 이동
async function goBack() {
  if (_saving)  { showToast('저장 중입니다. 잠시 기다려 주세요.'); return; }
  if (_merging) { showToast('합치기 중입니다. 완료 후 이동하세요.'); return; }
  await saveCurrentNode(true);
  location.href = 'index.html';
}

async function autosaveProjectTitle() {
  const title = document.getElementById('projTitle').value.trim();
  if (!title || title === _lastSavedTitle) return;
  try {
    const res = await vmApi(`/video-maker/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({ title }) });
    if (res.ok) { _lastSavedTitle = title; showToast('제목 저장됨'); }
  } catch (_) {}
}

// ── 노드 트리 ─────────────────────────────────────────────
function buildTree(parentId = null) {
  return allNodes
    .filter(n => (parentId === null ? n.parent_id === null : n.parent_id === parentId))
    .sort((a, b) => a.position - b.position)
    .map(n => ({ ...n, children: buildTree(n.id) }));
}
function renderTree() {
  if (_inlineEditing) return;
  const tree = buildTree();
  const container = document.getElementById('nodeTree');
  container.innerHTML = tree.length ? renderTreeHtml(tree, 0) : '<div class="node-tree-empty">항목이 없습니다</div>';
}
function renderTreeHtml(nodes, depth) {
  return nodes.map(n => {
    const active = n.id === currentNodeId ? ' active' : '';
    const icon = n.children.length ? '▾' : '·';
    return `
      <div class="node-item${active}" data-nid="${n.id}" style="padding-left:${8 + depth * 14}px" onclick="selectNode(${n.id})">
        <span class="node-item-icon">${icon}</span>
        <span class="node-item-title" ondblclick="event.stopPropagation();inlineEditTitle(${n.id},event)">${escHtml(n.title)}</span>
        <div class="node-item-actions">
          <button title="하위 추가" onclick="event.stopPropagation();addNode(${n.id})">+</button>
          <button title="삭제" onclick="event.stopPropagation();confirmDeleteNode(${n.id},'${escHtml(n.title).replace(/'/g,"\\'")}')">×</button>
        </div>
      </div>
      ${n.children.length ? renderTreeHtml(n.children, depth + 1) : ''}`;
  }).join('');
}

// ── 노드 선택 — IDB 복원 포함 ─────────────────────────────
async function selectNode(id) {
  if (_saving)  { showToast('저장 중입니다. 잠시 기다려 주세요.'); return; }
  if (_merging) { showToast('합치기 중입니다. 완료 후 이동하세요.'); return; }
  if (currentNodeId && currentNodeId !== id) await saveCurrentNode(true);
  currentNodeId = id;
  const node = allNodes.find(n => n.id === id);
  if (!node) return;

  const rawObjs = JSON.parse(JSON.stringify(node.objects || []));
  displayedObjects = rawObjs.filter(o => !o.isSourcePreview).map(o => ({ description: '', ...o }));
  _mergeSourceObjs = rawObjs.filter(o => o.isSourcePreview).map(o => ({ description: '', ...o }));
  _mediaMap = {};
  _pendingFiles = {};
  document.getElementById('nodeTitle').value = node.title || '';
  document.getElementById('fetchedBadge').style.display = 'none';
  document.getElementById('fetchBtn').style.display = allNodes.some(n => n.parent_id === id) ? '' : 'none';
  // 노드 ID 표시
  const nodeIdEl = document.getElementById('nodeIdDisplay');
  if (nodeIdEl) nodeIdEl.textContent = `node #${id}`;
  document.getElementById('nodeEmpty').style.display = 'none';
  document.getElementById('nodePanel').style.display = '';
  renderTree();
  renderObjects();
  renderSourcePanel();

  await loadMediaFromS3(id, displayedObjects);
  renderSourcePanel(); // S3 미디어 로드 후 썸네일 갱신
}

// 저장된 비디오 복원: data URL / S3 presigned URL / IDB
async function loadMediaFromS3(nodeId, objects) {
  const s3Objs = objects.filter(o => o.s3_key && !_mediaMap[o.id]);
  const legacyObjs = objects.filter(o => !o.s3_key && (o.data || o.isMerged) && !_mediaMap[o.id]);
  if (!s3Objs.length && !legacyObjs.length) return;
  let anyLoaded = false;
  for (const obj of s3Objs) {
    if (currentNodeId !== nodeId) return;
    try {
      const res = await vmApi('/video-maker/s3/get-url', { method: 'POST', body: JSON.stringify({ s3_key: obj.s3_key }) });
      const d = await res.json().catch(() => ({}));
      if (d.url) {
        _mediaMap[obj.id] = d.url; anyLoaded = true;
      } else {
        console.warn('S3 get-url 실패:', obj.s3_key, d.error || d);
      }
    } catch (e) { console.warn('S3 불러오기 오류:', obj.s3_key, e.message); }
  }
  for (const obj of legacyObjs) {
    if (currentNodeId !== nodeId) return;
    if (obj.data) { _mediaMap[obj.id] = obj.data; anyLoaded = true; }
    else if (obj.isMerged) {
      const f = await loadMergedFromIDB(obj);
      if (f) { _mediaMap[obj.id] = URL.createObjectURL(f); anyLoaded = true; }
    }
  }
  if (anyLoaded) renderObjects();
}

// ── 트리 인라인 편집 ──────────────────────────────────────
async function inlineEditTitle(nodeId, e) {
  e.stopPropagation();
  const node = allNodes.find(n => n.id === nodeId);
  if (!node) return;
  if (currentNodeId !== nodeId) await selectNode(nodeId);
  const titleEl = document.querySelector(`.node-item[data-nid="${nodeId}"] .node-item-title`);
  if (titleEl) startInlineEdit(nodeId, titleEl, allNodes.find(n => n.id === nodeId)?.title || node.title);
}
function startInlineEdit(nodeId, titleEl, currentTitle) {
  _inlineEditing = true;
  const input = document.createElement('input');
  input.type = 'text'; input.value = currentTitle;
  input.className = 'node-title-inline-edit';
  titleEl.replaceWith(input);
  input.focus(); input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    _inlineEditing = false;
    const newTitle = input.value.trim();
    if (!save || !newTitle || newTitle === currentTitle) { renderTree(); return; }
    try {
      const res = await vmApi(`/video-maker/projects/${projectId}/nodes/${nodeId}`, {
        method: 'PUT', body: JSON.stringify({ title: newTitle }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const idx = allNodes.findIndex(n => n.id === nodeId);
      if (idx >= 0) allNodes[idx].title = newTitle;
      if (currentNodeId === nodeId) document.getElementById('nodeTitle').value = newTitle;
      renderTree(); showToast('저장됨');
    } catch (e) { showToast('저장 실패: ' + e.message); renderTree(); }
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ── 노드 추가 (중복 방지) ─────────────────────────────────
async function addNode(parentId) {
  if (_addingNode) return;
  _addingNode = true;
  try {
    const res = await vmApi(`/video-maker/projects/${projectId}/nodes`, { method: 'POST', body: JSON.stringify({ parent_id: parentId }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const { node } = await res.json();
    allNodes.push(node);
    renderTree();
    await selectNode(node.id);
    requestAnimationFrame(() => {
      const titleEl = document.querySelector(`.node-item[data-nid="${node.id}"] .node-item-title`);
      if (titleEl) startInlineEdit(node.id, titleEl, node.title || '');
    });
  } catch (e) { showToast('추가 실패: ' + e.message); }
  finally { _addingNode = false; }
}

// ── 노드 저장 ─────────────────────────────────────────────
async function saveCurrentNode(silent = false) {
  if (!currentNodeId) return;
  if (_saving) { if (!silent) showToast('저장 중입니다...'); return; }
  _saving = true;
  const nodeId = currentNodeId;
  const title = document.getElementById('nodeTitle').value.trim() || '새 항목';
  try {

  // pending 파일 S3 업로드 — 이미 s3_key 있는 건 건너뜀 (uuid 기반 경로 = 멱등)
  const pendingIds = displayedObjects
    .filter(o => _pendingFiles[o.id] && !o.s3_key)
    .map(o => o.id);
  let anyUploadFailed = false;
  if (pendingIds.length) {
    showSavingToast();
    for (const id of pendingIds) {
      const { blob, filename, contentType } = _pendingFiles[id];
      const s3Key = await _uploadToS3(id, filename, contentType, blob);
      if (s3Key) {
        delete _pendingFiles[id]; // 업로드 성공 시에만 pending 제거
      } else {
        anyUploadFailed = true; // 실패 시 pending 유지 → 재시도 가능
      }
    }
    renderObjects();
  }

  const snap = [...displayedObjects];
  const objectsToSave = [
    ...snap.map(o => ({
      id: o.id, type: o.type, name: o.name, size: o.size || 0,
      description: o.description || '',
      ...(o.s3_key ? { s3_key: o.s3_key } : {}),
      ...(o.isMerged ? { isMerged: true } : {}),
      ...(o.type === 'image' && o.imgDuration ? { imgDuration: o.imgDuration } : {}),
    })),
    ..._mergeSourceObjs.map(o => ({
      id: o.id, type: o.type, name: o.name, size: o.size || 0,
      description: o.description || '',
      s3_key: o.s3_key || '',
      isSourcePreview: true,
    })),
  ];

  // S3 업로드 완료 후 allNodes 캐시를 먼저 업데이트 — 메뉴 이동 시 파일 즉시 표시
  const idx = allNodes.findIndex(n => n.id === nodeId);
  if (idx >= 0) { allNodes[idx].title = title; allNodes[idx].objects = objectsToSave; }

  try {
    const res = await vmApi(`/video-maker/projects/${projectId}/nodes/${nodeId}`, {
      method: 'PUT', body: JSON.stringify({ title, objects: objectsToSave }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    renderTree();
    if (!silent) showToast(anyUploadFailed ? '파일 일부 업로드 실패 — 나머지는 저장됨' : '저장됨');
  } catch (e) { if (!silent) showToast('저장 실패: ' + e.message); }
  } finally { _saving = false; }
}

// ── 노드 삭제 ─────────────────────────────────────────────
function confirmDeleteNode(id, title) {
  if (!confirm(`"${title}" 항목을 삭제하시겠습니까?\n하위 항목도 모두 삭제됩니다.`)) return;
  deleteNode(id);
}
function deleteCurrentNode() {
  if (!currentNodeId) return;
  const node = allNodes.find(n => n.id === currentNodeId);
  confirmDeleteNode(currentNodeId, node?.title || '항목');
}
async function deleteNode(id) {
  try {
    await vmApi(`/video-maker/projects/${projectId}/nodes/${id}`, { method: 'DELETE' });
    allNodes = (await (await vmApi(`/video-maker/projects/${projectId}/nodes`)).json()).nodes || [];
    if (currentNodeId === id || isDescendant(id, currentNodeId)) {
      currentNodeId = null;
      document.getElementById('nodePanel').style.display = 'none';
      document.getElementById('nodeEmpty').style.display = '';
    }
    renderTree();
  } catch (e) { showToast('삭제 실패'); }
}
function isDescendant(ancestorId, nodeId) {
  if (!nodeId) return false;
  const node = allNodes.find(n => n.id === nodeId);
  if (!node) return false;
  if (node.parent_id === ancestorId) return true;
  return isDescendant(ancestorId, node.parent_id);
}

// ── 자식에서 가져오기 — S3 객체 별도 복사 ────────────────
async function fetchFromChildren() {
  if (!currentNodeId) return;
  if (_merging || _saving) { showToast('처리 중입니다. 잠시 기다려 주세요.'); return; }
  const btn = document.getElementById('fetchBtn');
  btn.disabled = true;
  try {
    const res = await vmApi(`/video-maker/projects/${projectId}/nodes/${currentNodeId}/children-objects`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const data = await res.json();
    if (!data.objects.length) { showToast('자식 항목에 객체가 없습니다'); return; }

    // 새 ID 생성 (자식 노드 ID와 충돌 방지)
    const newObjs = data.objects.map(o => ({
      ...o,
      id: genObjId(),
      _srcId: o.id,
      description: o.description || '',
    }));

    // S3 객체는 현재 노드 경로로 서버측 복사
    const s3Items = newObjs.filter(o => o.s3_key);
    if (s3Items.length) {
      showToast('S3 파일 복사 중...');
      const copyRes = await vmApi('/video-maker/s3/copy', {
        method: 'POST',
        body: JSON.stringify({
          objects: s3Items.map(o => ({ sourceKey: o.s3_key, filename: o.name, newObjId: o.id })),
          node_id: currentNodeId,
        }),
      });
      const copyData = await copyRes.json().catch(() => ({}));
      for (const r of (copyData.results || [])) {
        const obj = newObjs.find(o => o.id === r.newObjId);
        if (obj) { obj.s3_key = r.s3Key; if (r.url) _mediaMap[obj.id] = r.url; }
      }
    }

    // 내부 임시 속성 제거 (isMerged는 이 노드 기준으로 재평가)
    newObjs.forEach(o => { delete o._srcId; delete o._nodeTitle; delete o._nodeId; delete o.isMerged; });
    displayedObjects = [...displayedObjects, ...newObjs];
    renderObjects();
    showToast(`${newObjs.length}개 객체 복사됨`);

    // 레거시(data URL/IDB) 미디어 로드
    const nodeId = currentNodeId;
    await loadMediaFromS3(nodeId, newObjs);
  } catch (e) { showToast('가져오기 실패: ' + e.message); }
  finally { btn.disabled = false; }
}

// ── 객체 추가 (저장 버튼 누를 때 S3 업로드, 로컬 미리보기 즉시) ────
async function addObjects(input) {
  if (_merging) { showToast('합치기 중입니다. 완료 후 추가하세요.'); input.value = ''; return; }
  const files = Array.from(input.files).filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
  if (!files.length) { input.value = ''; return; }

  const results = await Promise.all(files.map(async file => {
    const id = genObjId();
    if (file.type.startsWith('image/')) {
      try {
        const blob = await resizeImageToBlob(file, 1200);
        const fname = file.name.replace(/\.[^.]+$/, '.jpg');
        _mediaMap[id] = URL.createObjectURL(blob);
        _pendingFiles[id] = { blob, filename: fname, contentType: 'image/jpeg' };
        return { id, type: 'image', name: fname, size: blob.size, description: '', imgDuration: 1 };
      } catch { return null; }
    } else {
      _mediaMap[id] = URL.createObjectURL(file);
      _pendingFiles[id] = { blob: file, filename: file.name, contentType: file.type || 'video/mp4' };
      return { id, type: 'video', name: file.name, size: file.size, description: '' };
    }
  }));

  for (const obj of results) { if (obj) displayedObjects.push(obj); }
  renderObjects();
  input.value = '';
}

function resizeImageToBlob(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        c.toBlob(blob => blob ? resolve(blob) : reject(new Error('blob 변환 실패')), 'image/jpeg', 0.85);
      };
      img.onerror = reject; img.src = e.target.result;
    };
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}

async function _uploadToS3(objId, filename, contentType, blob, nodeId) {
  const nid = nodeId || currentNodeId;
  if (!nid) return;
  try {
    const presignRes = await vmApi('/video-maker/s3/presign', {
      method: 'POST',
      body: JSON.stringify({ filename, content_type: contentType, node_id: nid, obj_id: objId }),
    });
    const presignData = await presignRes.json().catch(() => ({}));
    if (!presignData.presignedUrl) throw new Error(presignData.error || 'presign 실패');
    const uploadResp = await fetch(presignData.presignedUrl, {
      method: 'PUT', body: blob, headers: { 'Content-Type': contentType },
    });
    if (!uploadResp.ok) throw new Error(`S3 업로드 실패 (${uploadResp.status})`);
    const obj = displayedObjects.find(o => o.id === objId);
    if (obj) obj.s3_key = presignData.s3Key;
    return presignData.s3Key;
  } catch (e) {
    showToast(`'${filename}' S3 저장 실패: ${e.message}`);
    return null;
  }
}

// ── 객체 목록 렌더링 ──────────────────────────────────────
function renderObjects() {
  const list = document.getElementById('objectsList');
  const mergeBar = document.getElementById('mergeBar');
  if (!displayedObjects.length) {
    list.innerHTML = '<div class="vm-empty">이미지/영상을 추가하거나 자식에서 가져오세요</div>';
    mergeBar.style.display = 'none';
    return;
  }
  mergeBar.style.display = '';
  list.innerHTML = displayedObjects.map((o, i) => {
    const isVideo = o.type === 'video';
    const isPending = !!_pendingFiles[o.id];
    const isS3 = !!o.s3_key;
    const mediaUrl = _mediaMap[o.id];

    const imgSrc = !isVideo ? (mediaUrl || o.data || '') : '';
    const thumbContent = isVideo
      ? `<span style="font-size:1.8rem;color:#fff">${o.isMerged ? '🎞' : '🎬'}</span>`
      : (imgSrc ? `<img src="${imgSrc}" alt="${escHtml(o.name)}" style="width:100%;height:100%;object-fit:cover">` : `<span style="font-size:1.8rem;color:#fff">🖼</span>`);

    const statusTag = isPending
      ? `<span class="obj-status pending-badge">저장 전</span>`
      : (isS3 ? `<span class="obj-status ok">버킷 저장</span>` : `<span class="obj-status warn">파일 없음</span>`);

    const durationRow = !isVideo
      ? `<div class="obj-duration-row"><label>재생</label><input type="number" class="vm-num-input" value="${o.imgDuration || 1}" min="0.5" max="60" step="0.5" style="width:46px" oninput="updateObjDuration(${i},this.value)"> 초</div>`
      : '';

    return `
      <div class="obj-card${isPending ? ' pending' : ''}${o.isMerged ? ' is-merged' : ''}" data-id="${o.id}">
        <div class="obj-thumb-wrap" onclick="openPreview(${i})">${thumbContent}</div>
        <div class="obj-card-name" title="${escHtml(o.name)}">${escHtml(o.name)}</div>
        <div class="obj-card-meta">${statusTag}</div>
        ${durationRow}
        <textarea class="obj-desc" placeholder="설명 (선택)" oninput="updateObjDesc(${i}, this.value)">${escHtml(o.description || '')}</textarea>
        <div class="obj-card-actions">
          <button onclick="moveObj(${i},-1)" ${i === 0 ? 'disabled' : ''}>◀</button>
          <button onclick="moveObj(${i}, 1)" ${i === displayedObjects.length - 1 ? 'disabled' : ''}>▶</button>
          <button class="obj-del" onclick="removeObj(${i})">×</button>
        </div>
      </div>`;
  }).join('');
}

function updateObjDesc(i, val) { if (displayedObjects[i]) displayedObjects[i].description = val; }
function updateObjDuration(i, val) { if (displayedObjects[i]) displayedObjects[i].imgDuration = parseFloat(val) || 3; }
function moveObj(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= displayedObjects.length) return;
  [displayedObjects[i], displayedObjects[j]] = [displayedObjects[j], displayedObjects[i]];
  renderObjects();
}
function removeObj(i) {
  const obj = displayedObjects[i];
  if (obj) {
    // S3에 저장된 파일이면 즉시 버킷에서 삭제 (fire-and-forget)
    if (obj.s3_key) {
      vmApi('/video-maker/s3/delete', { method: 'POST', body: JSON.stringify({ s3_key: obj.s3_key }) })
        .catch(() => {});
    }
    delete _pendingFiles[obj.id];
    if (_mediaMap[obj.id]?.startsWith('blob:')) URL.revokeObjectURL(_mediaMap[obj.id]);
    delete _mediaMap[obj.id];
  }
  displayedObjects.splice(i, 1);
  renderObjects();
  saveCurrentNode(true);
}
function triggerVideoUpload(objId) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'video/*'; inp.style.display = 'none';
  inp.onchange = () => {
    const file = inp.files[0];
    if (file) {
      if (_mediaMap[objId]?.startsWith('blob:')) URL.revokeObjectURL(_mediaMap[objId]);
      _mediaMap[objId] = URL.createObjectURL(file);
      _pendingFiles[objId] = { blob: file, filename: file.name, contentType: file.type || 'video/mp4' };
      const obj = displayedObjects.find(o => o.id === objId);
      if (obj) { obj.s3_key = ''; }
      renderObjects();
    }
    inp.remove();
  };
  document.getElementById('videoInputs').appendChild(inp);
  inp.click();
}

// ── 합치기 — 저장된 파일 전부를 순서대로 합쳐 신규 영상 생성 ─
async function doMerge() {
  if (_merging || _saving) { showToast('처리 중입니다. 잠시 기다려 주세요.'); return; }
  const targetNodeId = currentNodeId;
  if (!targetNodeId) return;

  // 미저장(pending) 파일이 있으면 먼저 저장 요청
  const pendingCount = displayedObjects.filter(o => _pendingFiles[o.id]).length;
  if (pendingCount > 0) {
    showToast(`미저장 파일 ${pendingCount}개가 있습니다. 먼저 💾 저장 후 합치기를 시도하세요.`);
    return;
  }
  // 저장된 파일(s3_key 있는 것) 전부를 순서대로 합치기
  const mergeObjs = displayedObjects.filter(o => o.s3_key);
  if (!mergeObjs.length) {
    showToast('저장된 파일이 없습니다. 먼저 💾 저장을 눌러주세요.');
    return;
  }

  // UUID 미리 채번
  const mergedId = genObjId();

  _merging = true;
  _setBusy(true);
  const mergeBtn = document.getElementById('mergeBtn');
  mergeBtn.disabled = true; mergeBtn.textContent = `⏳ 합치는 중... (${mergeObjs.length}개)`;

  try {
    // presigned URL이 없는 객체는 새로 요청
    for (const obj of mergeObjs) {
      if (!_mediaMap[obj.id]) {
        try {
          const res = await vmApi('/video-maker/s3/get-url', { method: 'POST', body: JSON.stringify({ s3_key: obj.s3_key }) });
          const d = await res.json().catch(() => ({}));
          if (d.url) _mediaMap[obj.id] = d.url;
        } catch (_) {}
      }
    }
    const noMedia = mergeObjs.filter(o => !_mediaMap[o.id]);
    if (noMedia.length) { showToast(`파일 ${noMedia.length}개를 불러올 수 없습니다`); return; }

    // 캔버스 녹화
    const canvas = document.createElement('canvas');
    canvas.width = 854; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioDest = audioCtx.createMediaStreamDestination();

    const mimeTypes = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
    ];
    const mimeType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';

    const stream = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...audioDest.stream.getAudioTracks(),
    ]);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(100);

    const fill = () => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); };
    const drawCentered = src => {
      const sw = src.videoWidth || src.naturalWidth || src.width;
      const sh = src.videoHeight || src.naturalHeight || src.height;
      if (!sw || !sh) return;
      const scale = Math.min(canvas.width / sw, canvas.height / sh);
      fill();
      ctx.drawImage(src, (canvas.width - sw * scale) / 2, (canvas.height - sh * scale) / 2, sw * scale, sh * scale);
    };

    for (const obj of mergeObjs) {
      if (obj.type === 'image') {
        const imgSrc = _mediaMap[obj.id];
        await new Promise(resolve => {
          const img = new Image();
          img.onload = () => { drawCentered(img); resolve(); };
          img.onerror = resolve; img.src = imgSrc;
        });
        await sleep((obj.imgDuration || 1) * 1000); // 기본 1초
      } else {
        const url = _mediaMap[obj.id];
        const video = document.createElement('video');
        video.src = url; video.crossOrigin = 'anonymous';
        try { audioCtx.createMediaElementSource(video).connect(audioDest); } catch (_) {}
        await new Promise(resolve => {
          video.oncanplaythrough = () => {
            video.play().catch(() => {});
            let raf;
            const draw = () => {
              if (video.ended) { cancelAnimationFrame(raf); return resolve(); }
              drawCentered(video);
              raf = requestAnimationFrame(draw);
            };
            video.onended = () => { cancelAnimationFrame(raf); resolve(); };
            raf = requestAnimationFrame(draw);
          };
          video.onerror = resolve; video.load();
        });
      }
    }

    recorder.stop();
    await new Promise(r => { recorder.onstop = r; });

    const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
    const fname = `merged_${Date.now()}.${ext}`;
    const blobUrl = URL.createObjectURL(blob); // 미리보기용 (페이지 내 재생)

    const mergedObj = {
      id: mergedId, type: 'video', name: fname,
      size: blob.size, isMerged: true, s3_key: '', description: '',
    };

    // 합치기 완료 시점에 노드가 바뀌었으면 결과를 버림
    if (currentNodeId !== targetNodeId) {
      URL.revokeObjectURL(blobUrl);
      showToast('합치기 완료됐으나 다른 메뉴로 이동했으므로 결과가 취소됩니다.');
      return;
    }

    // 이전 합치기 결과(pending) blob 리소스 정리
    for (const old of displayedObjects.filter(o => o.isMerged)) {
      if (_mediaMap[old.id]?.startsWith('blob:')) URL.revokeObjectURL(_mediaMap[old.id]);
      delete _mediaMap[old.id];
      delete _pendingFiles[old.id];
    }

    // pending 등록 → 저장 버튼 클릭 시 S3(노드 경로)에 업로드 + DB 저장
    _pendingFiles[mergedId] = { blob, filename: fname, contentType: blob.type.split(';')[0] || 'video/webm' };
    _mediaMap[mergedId] = blobUrl;

    // 합치기 완료 후 결과 영상만 목록에 남기고, 소스는 우측 패널에 보존
    _mergeSourceObjs = mergeObjs.map(o => ({ ...o, isSourcePreview: true }));
    displayedObjects = [mergedObj];
    renderObjects();
    renderSourcePanel();
    showToast('합치기 완료! 저장하기를 눌러 저장하세요.');
  } catch (e) {
    console.error('doMerge:', e);
    showToast('합치기 실패: ' + e.message);
  } finally {
    _merging = false;
    _setBusy(false);
    mergeBtn.disabled = false; mergeBtn.textContent = '🎬 합치기';
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 미리보기 모달 ─────────────────────────────────────────
let previewIdx = null;
let _previewObjUrl = null;
function openPreview(i) {
  previewIdx = i;
  const obj = displayedObjects[i];
  if (!obj) return;
  document.getElementById('previewName').textContent = obj.name;
  const content = document.getElementById('previewContent');
  if (obj.type === 'image') {
    const imgSrc = _mediaMap[obj.id] || obj.data || '';
    content.innerHTML = imgSrc
      ? `<img src="${imgSrc}" alt="${escHtml(obj.name)}" />`
      : `<div class="preview-no-file">📂 이미지를 불러올 수 없습니다</div>`;
  } else {
    const mediaVal = _mediaMap[obj.id];
    if (mediaVal) {
      const src = typeof mediaVal === 'string' ? mediaVal : (_previewObjUrl = URL.createObjectURL(mediaVal), _previewObjUrl);
      content.innerHTML = `<video src="${src}" controls></video>`;
    } else if (obj.data) {
      content.innerHTML = `<video src="${obj.data}" controls></video>`;
    } else {
      content.innerHTML = `<div class="preview-no-file">📂 파일이 로드되지 않았습니다</div>`;
    }
  }
  document.getElementById('previewModal').style.display = '';
  document.addEventListener('keydown', _previewKeyClose);
}
function closePreview() {
  document.getElementById('previewModal').style.display = 'none';
  document.getElementById('previewContent').innerHTML = '';
  if (_previewObjUrl) { URL.revokeObjectURL(_previewObjUrl); _previewObjUrl = null; }
  document.removeEventListener('keydown', _previewKeyClose);
  previewIdx = null;
}
function _previewKeyClose(e) { if (e.key === 'Escape') closePreview(); }
function downloadPreview() {
  if (previewIdx === null) return;
  const obj = displayedObjects[previewIdx];
  if (!obj) return;
  const a = document.createElement('a');
  if (obj.type === 'image') {
    const imgSrc = _mediaMap[obj.id] || obj.data || '';
    if (!imgSrc) { showToast('이미지를 불러올 수 없습니다'); return; }
    if (imgSrc.startsWith('data:')) {
      a.href = imgSrc; a.download = obj.name; a.click();
    } else {
      window.open(imgSrc, '_blank');
    }
    return;
  } else {
    const mediaVal = _mediaMap[obj.id];
    if (!mediaVal && !obj.data) { showToast('파일이 로드되지 않았습니다'); return; }
    const src = mediaVal ? (typeof mediaVal === 'string' ? mediaVal : null) : obj.data;
    if (src) {
      window.open(src, '_blank'); return;
    }
    a.href = URL.createObjectURL(mediaVal); a.download = obj.name;
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  a.click();
}

// ── 사이드바 리사이즈 ─────────────────────────────────────
function initSidebarResize() {
  const handle = document.getElementById('vmSidebarResize');
  const sidebar = document.getElementById('vmSidebar');
  if (!handle || !sidebar) return;
  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    handle.classList.add('resizing'); e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    sidebar.style.width = Math.max(120, Math.min(320, startW + (e.clientX - startX))) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; handle.classList.remove('resizing'); });
}


// ── 소스 미리보기 패널 ────────────────────────────────────
function renderSourcePanel() {
  const panel = document.getElementById('sourcePanel');
  if (!panel) return;
  const list = document.getElementById('sourceList');
  if (!_mergeSourceObjs.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  list.innerHTML = _mergeSourceObjs.map(o => {
    const media = _mediaMap[o.id];
    const thumb = o.type === 'image' && media
      ? `<img src="${escHtml(media)}" class="sp-thumb" alt="${escHtml(o.name)}" />`
      : `<div class="sp-icon-wrap">${o.type === 'video' ? '🎬' : '🖼'}</div>`;
    return `<div class="sp-item">
      <div class="sp-media">${thumb}</div>
      <div class="sp-name" title="${escHtml(o.name)}">${escHtml(o.name)}</div>
      <button class="sp-del" onclick="deleteSourcePreview('${o.id}')" title="삭제">×</button>
    </div>`;
  }).join('');
}

function deleteSourcePreview(id) {
  _mergeSourceObjs = _mergeSourceObjs.filter(o => o.id !== id);
  renderSourcePanel();
}

// ── 토스트 ────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}
function showSavingToast() {
  clearTimeout(toastTimer);
  const t = document.getElementById('toast');
  t.textContent = '저장 중... 잠시 기다려 주세요.';
  t.classList.add('show');
}
