/* 동영상 제작 — 공개 조회 페이지 */

const VM_API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';
const projectId = parseInt(new URLSearchParams(window.location.search).get('id')) || 0;

function getToken() { return localStorage.getItem('token'); }
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function vmApi(path) {
  const token = getToken();
  return fetch(VM_API + path, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

// ── IndexedDB (합쳐진 영상 복원) ─────────────────────────
let _vmDB = null;
function openVmDB() {
  if (_vmDB) return Promise.resolve(_vmDB);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vm_videos', 1);
    req.onupgradeneeded = e => { if (!e.target.result.objectStoreNames.contains('blobs')) e.target.result.createObjectStore('blobs'); };
    req.onsuccess = e => { _vmDB = e.target.result; resolve(_vmDB); };
    req.onerror = e => reject(e.target.error);
  });
}
async function idbGet(id) {
  try {
    const db = await openVmDB();
    return await new Promise(resolve => {
      const req = db.transaction('blobs', 'readonly').objectStore('blobs').get(id);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

let allNodes = [];
let videoFileMap = {};
let selectedNodeId = null;
let displayedObjects = [];

// ── 프리뷰 모달 ──────────────────────────────────────────
let _previewIdx = null, _previewObjUrl = null;
function openPreview(i) {
  _previewIdx = i;
  const obj = displayedObjects[i];
  if (!obj) return;
  document.getElementById('previewName').textContent = obj.name;
  const content = document.getElementById('previewContent');
  if (obj.type === 'image') {
    content.innerHTML = `<img src="${obj.data}" alt="${escHtml(obj.name)}" />`;
  } else {
    const file = videoFileMap[obj.id];
    if (file) {
      _previewObjUrl = URL.createObjectURL(file);
      content.innerHTML = `<video src="${_previewObjUrl}" controls autoplay></video>`;
    } else if (obj.data) {
      content.innerHTML = `<video src="${obj.data}" controls autoplay></video>`;
    } else {
      content.innerHTML = `<div class="preview-no-file">⏳ 영상을 불러오는 중입니다. 잠시 후 다시 시도하세요.</div>`;
    }
  }
  document.getElementById('previewModal').style.display = '';
  document.addEventListener('keydown', _closeOnEsc);
}
function closePreview() {
  document.getElementById('previewModal').style.display = 'none';
  document.getElementById('previewContent').innerHTML = '';
  if (_previewObjUrl) { URL.revokeObjectURL(_previewObjUrl); _previewObjUrl = null; }
  document.removeEventListener('keydown', _closeOnEsc);
  _previewIdx = null;
}
function _closeOnEsc(e) { if (e.key === 'Escape') closePreview(); }
function downloadPreview() {
  if (_previewIdx === null) return;
  const obj = displayedObjects[_previewIdx];
  if (!obj) return;
  const a = document.createElement('a');
  if (obj.type === 'image') {
    a.href = obj.data; a.download = obj.name;
  } else {
    const file = videoFileMap[obj.id];
    if (!file) { showToast('파일이 제작자 기기에만 저장되어 있습니다'); return; }
    a.href = URL.createObjectURL(file); a.download = obj.name;
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  a.click();
}

// ── 로드 ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (!projectId) { document.getElementById('viewBody').innerHTML = '<div class="empty-state"><span class="ei">⚠️</span><p>잘못된 접근입니다.</p></div>'; return; }
  try {
    const [projRes, nodesRes] = await Promise.all([
      vmApi(`/video-maker/projects/${projectId}`),
      vmApi(`/video-maker/projects/${projectId}/nodes`),
    ]);
    if (!projRes.ok) {
      const err = await projRes.json().catch(() => ({}));
      throw new Error(err.error || '접근 권한이 없습니다.');
    }
    const { project } = await projRes.json();

    document.getElementById('viewTitle').textContent = project.title || '(제목 없음)';
    document.title = `${project.title || '동영상 보기'} – WorkKit`;
    document.getElementById('viewAuthor').textContent = project.author_name || '';
    document.getElementById('viewDate').textContent = project.updated_at
      ? new Date(project.updated_at).toLocaleDateString('ko-KR')
      : '';

    // 소유자라면 편집 버튼 표시
    if (project.is_owner) {
      document.getElementById('viewActions').innerHTML =
        `<a href="write.html?id=${projectId}" class="btn">✏ 편집하기</a>`;
    }

    allNodes = (await nodesRes.json()).nodes || [];
    renderViewBody();
  } catch (e) {
    document.getElementById('viewBody').innerHTML =
      `<div class="empty-state"><span class="ei">🔒</span><p>${escHtml(e.message)}</p></div>`;
  }
});

// ── 뷰 본문 렌더링 ────────────────────────────────────────
function buildTree(parentId = null) {
  return allNodes
    .filter(n => parentId === null ? n.parent_id === null : n.parent_id === parentId)
    .sort((a, b) => a.position - b.position)
    .map(n => ({ ...n, children: buildTree(n.id) }));
}

function renderViewBody() {
  const roots = buildTree();
  if (!roots.length) {
    document.getElementById('viewBody').innerHTML = '<div class="empty-state"><span class="ei">📂</span><p>아직 항목이 없습니다.</p></div>';
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'view-layout';

  // 사이드바: 노드 트리
  const sidebar = document.createElement('div');
  sidebar.className = 'view-sidebar';
  sidebar.innerHTML = '<div class="view-sidebar-title">항목 목록</div>' + renderViewTree(roots, 0);
  wrap.appendChild(sidebar);

  // 메인: 선택된 노드 객체
  const main = document.createElement('div');
  main.className = 'view-main';
  main.id = 'viewMain';
  main.innerHTML = '<div class="node-empty-state"><span class="node-empty-icon">🎬</span><p>왼쪽에서 항목을 선택하세요</p></div>';
  wrap.appendChild(main);

  document.getElementById('viewBody').innerHTML = '';
  document.getElementById('viewBody').appendChild(wrap);

  // 루트 노드 자동 선택
  if (roots.length) selectViewNode(roots[0].id);
}

function renderViewTree(nodes, depth) {
  return nodes.map(n => `
    <div class="node-item${n.id === selectedNodeId ? ' active' : ''}" data-nid="${n.id}"
         style="padding-left:${8 + depth * 14}px" onclick="selectViewNode(${n.id})">
      <span class="node-item-icon">${n.children.length ? '▾' : '·'}</span>
      <span class="node-item-title">${escHtml(n.title)}</span>
    </div>
    ${n.children.length ? renderViewTree(n.children, depth + 1) : ''}
  `).join('');
}

async function selectViewNode(id) {
  selectedNodeId = id;
  const node = allNodes.find(n => n.id === id);
  if (!node) return;

  document.querySelectorAll('.node-item').forEach(el => el.classList.toggle('active', +el.dataset.nid === id));

  displayedObjects = JSON.parse(JSON.stringify(node.objects || []));
  videoFileMap = {};
  renderViewObjects();

  // 영상 로드: DB data URL 우선, 없으면 IDB 폴백
  const mergedObjs = displayedObjects.filter(o => o.type === 'video' && o.isMerged);
  for (const obj of mergedObjs) {
    if (selectedNodeId !== id) return;
    if (obj.data) {
      try {
        const res = await fetch(obj.data);
        const blob = await res.blob();
        videoFileMap[obj.id] = new File([blob], obj.name, { type: blob.type || 'video/webm' });
      } catch (_) {}
    }
    if (!videoFileMap[obj.id]) {
      const blob = await idbGet(obj.id);
      if (selectedNodeId !== id) return;
      if (blob) videoFileMap[obj.id] = blob instanceof File ? blob : new File([blob], obj.name, { type: blob.type || 'video/webm' });
    }
  }
  if (mergedObjs.length) renderViewObjects();
}

function renderViewObjects() {
  const main = document.getElementById('viewMain');
  if (!displayedObjects.length) {
    main.innerHTML = '<div class="node-empty-state"><span class="node-empty-icon">📂</span><p>이 항목에 객체가 없습니다</p></div>';
    return;
  }

  // 이미지: 항상 표시 / 합쳐진 영상: 파일 로드된 경우만 표시 / 원본업로드 영상: 표시 안 함
  const viewableObjs = displayedObjects.filter(o =>
    o.type === 'image' || (o.type === 'video' && o.isMerged)
  );

  if (!viewableObjs.length) {
    main.innerHTML = '<div class="node-empty-state"><span class="node-empty-icon">🎬</span><p>표시할 객체가 없습니다</p></div>';
    return;
  }

  main.innerHTML = viewableObjs.map((o, i) => {
    const realIdx = displayedObjects.indexOf(o);
    const isVideo = o.type === 'video';
    const hasFile = isVideo && !!videoFileMap[o.id];
    const desc = (o.description || '').trim();

    const thumb = isVideo
      ? `<div class="obj-video-icon obj-clickable" onclick="openPreview(${realIdx})" title="영상 재생">🎞</div>`
      : `<img src="${o.data}" class="obj-img-thumb obj-clickable" onclick="openPreview(${realIdx})" title="미리보기" alt="${escHtml(o.name)}" />`;

    const notice = isVideo && !hasFile
      ? `<span class="obj-status warn">⏳ 영상 로딩 중...</span>`
      : '';

    return `
      <div class="obj-item${o.isMerged ? ' is-merged' : ''}">
        <div class="obj-thumb">${thumb}</div>
        <div class="obj-info">
          <span class="obj-name">${escHtml(o.name)}</span>
          ${notice}
          ${desc ? `<p class="view-obj-desc">${escHtml(desc)}</p>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── 토스트 ────────────────────────────────────────────────
let _toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}
