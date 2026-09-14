/* 화면 설계서 — 공개 뷰어 */

const SD_API = 'https://nynhvk2xl3.execute-api.ap-southeast-2.amazonaws.com';
const params = new URLSearchParams(window.location.search);
const projectId = parseInt(params.get('id')) || 0;
const initNodeId = parseInt(params.get('node')) || 0;

let allNodes = [];
let currentNodeId = null;

function getToken() { return localStorage.getItem('token'); }
function escHtml(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function sdApi(path) {
  const token = getToken();
  return fetch(SD_API + path, {
    headers: { 'Content-Type':'application/json', ...(token?{Authorization:`Bearer ${token}`}:{}) }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  if (!projectId) { showToast('프로젝트 ID가 없습니다'); return; }
  loadProject();
  initSidebarResize();
});

async function loadProject() {
  try {
    const [projRes, nodesRes] = await Promise.all([
      sdApi(`/screen-designer/projects/${projectId}`),
      sdApi(`/screen-designer/projects/${projectId}/nodes`),
    ]);
    if (!projRes.ok) throw new Error('프로젝트를 찾을 수 없거나 게시되지 않았습니다');
    const { project } = await projRes.json();
    document.getElementById('viewTitle').textContent = project.title || '화면 설계서';
    document.title = `${project.title||'화면 설계서'} – WorkKit`;
    if (project.author_name) document.getElementById('viewAuthor').textContent = `✍️ ${project.author_name}`;
    if (project.is_owner) document.getElementById('editBtn').style.display='';
    allNodes = (await nodesRes.json()).nodes || [];
    renderTree();
    if (initNodeId && allNodes.some(n=>n.id===initNodeId)) selectNode(initNodeId);
    else if (allNodes.length) selectNode(allNodes[0].id);
  } catch (e) {
    document.getElementById('viewTitle').textContent = '오류';
    showToast('불러오기 실패: '+e.message);
  }
}

function goEdit() { location.href=`write.html?id=${projectId}`; }

// ── 노드 트리 ─────────────────────────────────────────────
function buildTree(pid=null) {
  return allNodes.filter(n=>pid===null?n.parent_id===null:n.parent_id===pid)
    .sort((a,b)=>a.position-b.position).map(n=>({...n,children:buildTree(n.id)}));
}
function renderTree() {
  const tree = buildTree();
  const el = document.getElementById('nodeTree');
  el.innerHTML = tree.length ? renderTreeHtml(tree,0) : '<div class="node-tree-empty">화면이 없습니다</div>';
}
function renderTreeHtml(nodes, depth) {
  return nodes.map(n=>`
    <div class="node-item${n.id===currentNodeId?' active':''}" data-nid="${n.id}" style="padding-left:${8+depth*14}px" onclick="selectNode(${n.id})">
      <span class="node-item-icon">${n.children.length?'▾':'·'}</span>
      <span class="node-item-title">${escHtml(n.title)}</span>
    </div>
    ${n.children.length?renderTreeHtml(n.children,depth+1):''}`).join('');
}

function selectNode(id) {
  currentNodeId = id;
  const node = allNodes.find(n=>n.id===id);
  if (!node) return;

  // URL 업데이트
  const url = new URL(location.href);
  url.searchParams.set('node', id);
  history.replaceState(null,'',url.toString());

  document.getElementById('nodeTitle').textContent = node.title || '화면';
  const linkEl = document.getElementById('screenLink');
  linkEl.textContent = '🔗 화면 링크';
  linkEl.title = location.href;
  linkEl.onclick = () => { navigator.clipboard?.writeText(location.href); showToast('링크 복사됨'); };

  document.getElementById('nodeEmpty').style.display = 'none';
  const panel = document.getElementById('nodePanel');
  panel.style.display = 'flex';

  renderTree();
  renderCanvas(node.components||[]);
}

// ── 캔버스 렌더링 (읽기 전용) ────────────────────────────
function renderCanvas(components) {
  const canvas = document.getElementById('sdCanvas');
  canvas.innerHTML = '';
  const sorted=[...components].sort((a,b)=>(a.type==='section'?0:1)-(b.type==='section'?0:1));
  sorted.forEach(comp => {
    const el = document.createElement('div');
    el.className = 'sd-comp view-comp';
    el.dataset.id = comp.id;
    el.style.cssText = `left:${comp.x}px;top:${comp.y}px;width:${comp.w}px;height:${comp.h}px`;
    el.innerHTML = getCompHtml(comp);
    const p = comp.props || {};
    if (comp.type === 'button') {
      if (p.linkType === 'node' && p.linkedNodeId) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => selectNode(p.linkedNodeId));
      } else if (p.url) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => window.open(p.url, '_blank'));
      }
    }
    if (comp.type === 'popupBtn') {
      if (p.linkType === 'node' && p.linkedNodeId) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => openNodePopup(p.linkedNodeId, p.label || '팝업'));
      } else if (p.url) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => openPopup(p.url, p.label || '팝업'));
      }
    }
    canvas.appendChild(el);
  });
}

function getCompHtml(c) {
  const p = c.props || {};
  switch(c.type) {
    case 'radio': {
      const opts = (p.options||'').split('\n').map(s=>s.trim()).filter(Boolean);
      return `<div class="sd-field"><label class="sd-field-label">${escHtml(p.label||'')}</label>
        <div class="sd-radio-group">${opts.map((o,i)=>`<label class="sd-radio-opt"><input type="radio" ${i===0?'checked':''}/> ${escHtml(o)}</label>`).join('')}</div></div>`;
    }
    case 'checkbox': {
      const opts = (p.options||'').split('\n').map(s=>s.trim()).filter(Boolean);
      return `<div class="sd-field"><label class="sd-field-label">${escHtml(p.label||'')}</label>
        <div class="sd-radio-group">${opts.map(o=>`<label class="sd-radio-opt"><input type="checkbox" /> ${escHtml(o)}</label>`).join('')}</div></div>`;
    }
    case 'input':
      return `<div class="sd-field"><label class="sd-field-label">${escHtml(p.label||'')}</label><input class="sd-input" placeholder="${escHtml(p.placeholder||'')}" /></div>`;
    case 'button': {
      const linked = (p.linkType==='node' && p.linkedNodeId) || p.url;
      const icon = p.linkType==='node' && p.linkedNodeId ? ' <span style="font-size:.72em;opacity:.7">📑</span>' : (p.url ? ' <span style="font-size:.72em;opacity:.7">🔗</span>' : '');
      return `<button class="sd-btn sd-btn-${p.variant||'default'}" style="${linked?'cursor:pointer':''}">${escHtml(p.label||'버튼')}${icon}</button>`;
    }
    case 'dropdown': {
      const opts = Array.isArray(p.options) ? p.options : [];
      return `<div class="sd-field"><label class="sd-field-label">${escHtml(p.label||'')}</label><select class="sd-select">${opts.map(o=>`<option value="${escHtml(o.key||'')}">${escHtml(o.text||o.key||'')}</option>`).join('')}</select></div>`;
    }
    case 'popupBtn': {
      const linked = (p.linkType==='node' && p.linkedNodeId) || p.url;
      const icon = p.linkType==='node' && p.linkedNodeId ? ' <span style="font-size:.72em;opacity:.7">📑</span>' : (p.url ? ' <span style="font-size:.72em;opacity:.7">↗</span>' : '');
      return `<button class="sd-btn sd-btn-popup" style="${linked?'cursor:pointer':''}">${escHtml(p.label||'팝업버튼')}${icon}</button>`;
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
        ?`<span class="sd-formrow-range-label">${escHtml(p.rangeLabel||'종료')}</span><input class="sd-formrow-input" />`:'';
      return `<div class="sd-formrow">
        <span class="sd-formrow-label" style="width:${lw}">${escHtml(p.label||'항목명')}</span>
        <input class="sd-formrow-input" placeholder="${escHtml(p.placeholder||'')}" />
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
      return `<div class="sd-toolbar-comp">${btns.map(b=>`<button class="sd-btn sd-btn-default">${escHtml(b)}</button>`).join('')}</div>`;
    }
    default: return '';
  }
}

// ── 팝업 모달 ─────────────────────────────────────────────
function openPopup(url, title) {
  document.getElementById('sdPopupTitle').textContent = title || '';
  document.getElementById('sdPopupFrame').style.display = '';
  document.getElementById('sdPopupFrame').src = url;
  document.getElementById('sdPopupNodeCanvas').style.display = 'none';
  document.getElementById('sdPopupNodeCanvas').innerHTML = '';
  document.getElementById('sdPopup').style.display = 'flex';
}

function openNodePopup(nodeId, title) {
  const node = allNodes.find(n => n.id === nodeId);
  if (!node) { showToast('연결된 화면을 찾을 수 없습니다'); return; }
  document.getElementById('sdPopupTitle').textContent = node.title || title || '화면';
  document.getElementById('sdPopupFrame').style.display = 'none';
  document.getElementById('sdPopupFrame').src = 'about:blank';
  const nodeCanvas = document.getElementById('sdPopupNodeCanvas');
  nodeCanvas.style.display = '';
  // 해당 노드의 컴포넌트를 팝업 캔버스에 렌더링
  const comps = [...(node.components||[])].sort((a,b)=>(a.type==='section'?0:1)-(b.type==='section'?0:1));
  nodeCanvas.innerHTML = comps.map(comp => {
    return `<div class="sd-comp view-comp" style="left:${comp.x}px;top:${comp.y}px;width:${comp.w}px;height:${comp.h}px">${getCompHtml(comp)}</div>`;
  }).join('');
  document.getElementById('sdPopup').style.display = 'flex';
}

function closePopup() {
  document.getElementById('sdPopup').style.display = 'none';
  document.getElementById('sdPopupFrame').src = 'about:blank';
  document.getElementById('sdPopupNodeCanvas').style.display = 'none';
  document.getElementById('sdPopupNodeCanvas').innerHTML = '';
}

// ── 사이드바 리사이즈 ─────────────────────────────────────
function initSidebarResize() {
  const handle=document.getElementById('sdSidebarResize'), sidebar=document.getElementById('sdSidebar');
  if (!handle||!sidebar) return;
  let drag=false, sx=0, sw=0;
  handle.addEventListener('mousedown', e=>{drag=true;sx=e.clientX;sw=sidebar.offsetWidth;e.preventDefault();});
  document.addEventListener('mousemove', e=>{ if(!drag) return; sidebar.style.width=Math.max(120,Math.min(320,sw+(e.clientX-sx)))+'px'; });
  document.addEventListener('mouseup', ()=>{drag=false;});
}

// ── 토스트 ────────────────────────────────────────────────
let _toastTimer;
function showToast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(_toastTimer); _toastTimer=setTimeout(()=>t.classList.remove('show'),2500);
}
