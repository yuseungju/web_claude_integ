/* ── State ─────────────────────────────────────────────── */
// scheduleData는 activeTab에 따라 planData 또는 completedData와 동일한 배열을 참조함
let planData      = [];
let completedData = [];
let activeTab     = 'plan'; // 'plan' | 'completed'
let scheduleData  = planData;
let nextId        = 1;

/* ── 버전 공유 State ───────────────────────────────────── */
const SCHED_API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';
let currentVersionId   = null;   // null=신규모드, number=수정모드(user_saves.id)
let currentVersionMeta = null;   // { id, title, created_at, updated_at, user_id, creator_name }
let collabMode      = null;      // null | 'view' | 'collab'
let collabToken     = null;      // ?collab= 토큰
let collabSaveId    = null;      // 협업 대상 원본의 user_saves.id
let collabOwnerName = null;

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || 'null'); }

/* ── Filter State ───────────────────────────────────────── */
let filterManager = '';
let filterKeyword = '';

/* ── Sort State ─────────────────────────────────────────── */
let sortField = null;
let sortDir   = 'asc'; // 'asc' | 'desc'

const MAX_ROWS = 100;

/* ── Row-Selection State ────────────────────────────────── */
const selectedRowIds = new Set();
let   isDragging     = false;
let   dragAnchorId   = null;

const schedDrag = { active: false, srcIdx: null, ovIdx: null };

/* ── Excel-like Navigation ──────────────────────────────── */
const XL_FIELDS = ['lv1','lv2','content','link','manager','startDate','endDate'];
const XL_COLS   = XL_FIELDS.length;
let xlSel     = null;   // { ri, ci }
let xlEdit    = false;
let xlOrig    = '';
let xlAnchor  = null;   // drag-start cell
let xlRange   = null;   // { r1, c1, r2, c2 }
let xlDragging = false;
let xlUndo    = null;   // { ri, ci, value } — one-level undo
let _xlCopiedText = null; // 범위/셀 복사 내용 (비동기 클립보드 경쟁 우회용)
let _xlPasting    = false; // xlHandlePaste 진행 중 플래그 (renderTable blur 오버라이트 방지)

/* ── Gantt column widths (persist across re-renders) ────── */
let ganttColWidths   = [80, 110, 475, 70];
let ganttCompact     = true;
let ganttGroupByLv2  = false;

function updateCompactBtn() {
  const btn = document.getElementById('ganttCompactBtn');
  if (btn) btn.classList.toggle('active', ganttCompact);
}
function updateGroupBtn() {
  const btn = document.getElementById('ganttGroupBtn');
  if (btn) btn.classList.toggle('active', ganttGroupByLv2);
}
function markGanttDirty() {
  const btn = document.querySelector('.btn-update');
  if (btn) btn.classList.add('dirty');
}
function toggleGanttCompact() {
  ganttCompact = !ganttCompact;
  updateCompactBtn();
  renderGantt();
}
function toggleGanttGroup() {
  ganttGroupByLv2 = !ganttGroupByLv2;
  updateGroupBtn();
  renderGantt();
}

function groupByLv2(items) {
  const map = new Map();
  items.forEach(item => {
    const key = `${item.lv1}|||${item.lv2}`;
    if (!map.has(key)) {
      map.set(key, { lv1: item.lv1, lv2: item.lv2, content: item.content, manager: item.manager,
                     startDate: item.startDate, endDate: item.endDate });
    } else {
      const g = map.get(key);
      if (item.startDate && (!g.startDate || item.startDate < g.startDate)) g.startDate = item.startDate;
      if (item.endDate   && (!g.endDate   || item.endDate   > g.endDate))   g.endDate   = item.endDate;
      if (item.content && item.content !== g.content)
        g.content = g.content ? g.content + ' / ' + item.content : item.content;
      if (item.manager && !g.manager.includes(item.manager))
        g.manager = g.manager ? g.manager + ', ' + item.manager : item.manager;
    }
  });
  return [...map.values()];
}
function ganttComputeLeft() {
  const L = [0];
  for (let i = 1; i < 4; i++) L.push(L[i - 1] + ganttColWidths[i - 1]);
  return L;
}

/* ── Init ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const shareToken  = params.get('share');
  const collabParam = params.get('collab');

  if (shareToken) {
    await initSharedView(shareToken);
  } else if (collabParam) {
    await initCollabView(collabParam);
  } else if (getToken()) {
    // 캐시(localStorage)에 의존하지 않고 항상 DB의 최근 저장 버전을 불러온다
    const loaded = await loadMostRecentVersion();
    if (!loaded) {
      planData = []; completedData = []; scheduleData = planData;
      activeTab = 'plan'; nextId = 1;
      currentVersionId = null; currentVersionMeta = null;
      collabMode = null; collabToken = null; collabSaveId = null; collabOwnerName = null;
      saveToStorage();
      renderVersionMeta();
    }
  } else {
    loadFromStorage();
  }

  updateTabUI();
  renderTable();
  document.getElementById('tableBody').addEventListener('paste', handleTablePaste);
  document.getElementById('tableBody').addEventListener('mousemove', e => {
    if (!xlDragging || xlEdit) return;
    const td = e.target.closest('td.xl-cell');
    if (!td || !xlAnchor) return;
    const ri = parseInt(td.dataset.ri), ci = parseInt(td.dataset.ci);
    const r1 = Math.min(xlAnchor.ri, ri), r2 = Math.max(xlAnchor.ri, ri);
    const c1 = Math.min(xlAnchor.ci, ci), c2 = Math.max(xlAnchor.ci, ci);
    if (r2 > r1 || c2 > c1) {
      xlRange = { r1, c1, r2, c2 };
      if (xlSel) { xlTd(xlSel.ri, xlSel.ci)?.classList.remove('xl-selected', 'xl-editing'); xlSel = null; }
      updateRangeHighlight();
    }
  });
  requestAnimationFrame(() => initColResize(document.querySelector('.sched-table')));
  updateCompactBtn();
  updateGroupBtn();
  renderGantt();
});

window.addEventListener('beforeunload', e => {
  // 신규모드(미저장 버전)에서 데이터가 있으면, 다음 진입 시 최근 버전 자동 로드로 초기화되므로 경고
  if (collabMode === null && currentVersionId === null && (planData.length || completedData.length)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

document.addEventListener('mouseup', () => { isDragging = false; xlDragging = false; if (schedDrag.active) endSchedDrag(); });

document.addEventListener('mousedown', e => {
  if (!e.target.closest('#tableBody') && !e.target.closest('#btnDeleteSelected')) {
    if (selectedRowIds.size > 0) { selectedRowIds.clear(); updateRowHighlights(); }
    if (xlSel || xlRange) xlClearSel();
  }
});

document.getElementById('detailOverlay')?.addEventListener('mousedown', e => {
  if (e.target.id === 'detailOverlay') closeDetailPopup();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('detailOverlay')?.classList.contains('open')) {
    closeDetailPopup();
  }
});

document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key !== 'c') return;
  if (xlSel || xlRange) return; // XL 셀/범위 복사가 우선 처리
  const active = document.activeElement;
  if (active?.matches('input,textarea') && (active.selectionEnd - active.selectionStart) > 0) return;
  if (window.getSelection?.()?.toString().length > 0) return;
  if (!selectedRowIds.size) return;
  e.preventDefault();
  copySelectedRows();
});

/* ── Date Utils (로컬 시간 기준 – 타임존 오류 없음) ─────── */
function fmtDate(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
function dateNext(s) {
  const [y, m, d] = s.split('-').map(Number);
  return fmtDate(new Date(y, m - 1, d + 1));
}
function dateDow(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}
function dateDay(s) { return parseInt(s.slice(8), 10); }

/* ── Tabs ──────────────────────────────────────────────── */
function syncActiveData() {
  if (activeTab === 'plan') planData = scheduleData;
  else completedData = scheduleData;
}

function switchTab(tab) {
  if (tab !== 'plan' && tab !== 'completed') return;
  if (tab === activeTab) return;
  syncActiveData();
  activeTab    = tab;
  scheduleData = activeTab === 'plan' ? planData : completedData;
  selectedRowIds.clear();
  xlClearSel();
  filterManager = '';
  filterKeyword = '';
  sortField = null;
  sortDir   = 'asc';
  const fm = document.getElementById('filterManager');
  const fk = document.getElementById('filterKeyword');
  if (fm) fm.value = '';
  if (fk) fk.value = '';
  updateTabUI();
  saveToStorage();
  renderTable();
  updateSortIndicators();
  renderGantt();
}

function updateTabUI() {
  document.querySelectorAll('.sched-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === activeTab);
  });
  const listTitle = document.getElementById('tableSectionTitle');
  if (listTitle) listTitle.textContent = activeTab === 'plan' ? '📋 일정 목록' : '✅ 완료 목록';
  const cnt = document.getElementById('completedCount');
  if (cnt) cnt.textContent = completedData.length ? ` (${completedData.length})` : '';
}

function moveRow(id) {
  const idx = scheduleData.findIndex(r => r.id === id);
  if (idx === -1) return;
  if (!canEditRow(scheduleData[idx])) { showToast('작성자만 이동할 수 있습니다.', 'info'); return; }
  const toCompleted = activeTab === 'plan';
  const label = toCompleted ? '완료' : '일정 계획';
  if (!confirm(`이 일정을 '${label}'으로 이동하시겠습니까?`)) return;
  if (detailEditingId === id) closeDetailPopup();
  selectedRowIds.delete(id);
  if (xlSel) xlClearSel();
  const [row] = scheduleData.splice(idx, 1);
  (toCompleted ? completedData : planData).push(row);
  saveToStorage();
  renderTable();
  renderGantt();
  updateTabUI();
  showToast(`'${label}'으로 이동했습니다.`, 'success');
}

/* ── Filter ────────────────────────────────────────────── */
function matchesFilter(row) {
  if (filterManager.trim()) {
    if (!String(row.manager || '').toLowerCase().includes(filterManager.trim().toLowerCase())) return false;
  }
  if (filterKeyword.trim()) {
    const q = filterKeyword.trim().toLowerCase();
    const fields = [row.lv1, row.lv2, row.content, row.link, row.manager, row.startDate, row.endDate, row.detail];
    if (!fields.some(v => String(v ?? '').toLowerCase().includes(q))) return false;
  }
  return true;
}

function applyFilter() {
  filterManager = document.getElementById('filterManager')?.value || '';
  filterKeyword = document.getElementById('filterKeyword')?.value || '';
  renderTable();
  renderGantt();
}

function clearFilters() {
  filterManager = '';
  filterKeyword = '';
  const fm = document.getElementById('filterManager');
  const fk = document.getElementById('filterKeyword');
  if (fm) fm.value = '';
  if (fk) fk.value = '';
  renderTable();
  renderGantt();
}

/* ── Sort ──────────────────────────────────────────────── */
function sortByColumn(field, e) {
  if (e?.target.closest('.col-resizer')) return;
  if (sortField === field) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortField = field;
    sortDir = 'asc';
  }
  const dir = sortDir === 'asc' ? 1 : -1;
  scheduleData.sort((a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? ''), 'ko') * dir);
  if (xlSel || xlRange) xlClearSel();
  saveToStorage();
  renderTable();
  updateSortIndicators();
  markGanttDirty();
}

function updateSortIndicators() {
  document.querySelectorAll('.sched-table thead th.sortable').forEach(th => {
    const ind = th.querySelector('.sort-ind');
    if (th.dataset.field === sortField) {
      if (ind) ind.textContent = sortDir === 'asc' ? ' ▲' : ' ▼';
      th.classList.add('sorted');
    } else {
      if (ind) ind.textContent = '';
      th.classList.remove('sorted');
    }
  });
}

/* ── Storage ────────────────────────────────────────────── */
function loadFromStorage() {
  try {
    const raw = localStorage.getItem('scheduleData_v1');
    if (!raw) return;
    const saved = JSON.parse(raw);
    planData      = saved.data          || [];
    completedData = saved.completedData || [];
    activeTab     = saved.activeTab === 'completed' ? 'completed' : 'plan';
    nextId        = saved.nextId || (Math.max(0, ...planData.map(r => r.id), ...completedData.map(r => r.id)) + 1);
    scheduleData  = activeTab === 'plan' ? planData : completedData;
    currentVersionId = saved.versionId || null;
  } catch (_) {
    planData = []; completedData = []; scheduleData = planData; activeTab = 'plan'; nextId = 1;
    currentVersionId = null;
  }
}

function saveToStorage() {
  syncActiveData();
  localStorage.setItem('scheduleData_v1', JSON.stringify({ data: planData, completedData, nextId, activeTab, versionId: currentVersionId }));
}

let _saveTimer = null;
function saveToStorageDeferred() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveToStorage, 400);
}

/* ── CRUD ───────────────────────────────────────────────── */
function addRow() {
  if (scheduleData.length >= MAX_ROWS) { showToast(`최대 ${MAX_ROWS}행까지 추가할 수 있습니다.`, 'error'); return; }
  const user = getUser();
  if (collabMode === 'collab' && !user) { showToast('로그인이 필요합니다.', 'error'); return; }
  const today = fmtDate(new Date());
  const ny = new Date(); ny.setFullYear(ny.getFullYear() + 1);
  const newRow = { id: nextId++, lv1: '', lv2: '', content: '', link: '', manager: '', startDate: today, endDate: fmtDate(ny), createdBy: user ? { id: user.id, name: user.name } : null, createdAt: new Date().toISOString() };
  scheduleData.splice(findInsertIdx(), 0, newRow);
  selectedRowIds.clear();
  saveToStorage();
  renderTable();
  markGanttDirty();
}
function addRowAtEnd() {
  if (scheduleData.length >= MAX_ROWS) { showToast(`최대 ${MAX_ROWS}행까지 추가할 수 있습니다.`, 'error'); return; }
  const user = getUser();
  if (collabMode === 'collab' && !user) { showToast('로그인이 필요합니다.', 'error'); return; }
  const today = fmtDate(new Date());
  const ny = new Date(); ny.setFullYear(ny.getFullYear() + 1);
  const newRow = { id: nextId++, lv1: '', lv2: '', content: '', link: '', manager: '', startDate: today, endDate: fmtDate(ny), createdBy: user ? { id: user.id, name: user.name } : null, createdAt: new Date().toISOString() };
  scheduleData.push(newRow);
  saveToStorage();
  renderTable();
  markGanttDirty();
}
function findInsertIdx() {
  if (selectedRowIds.size > 0) {
    let last = -1;
    scheduleData.forEach((r, i) => { if (selectedRowIds.has(r.id) && i > last) last = i; });
    if (last >= 0) return last + 1;
  }
  return scheduleData.length;
}

function copyRow(id) {
  const src = scheduleData.find(r => r.id === id);
  if (!src) return;
  if (!canEditRow(src)) { showToast('작성자만 복사할 수 있습니다.', 'info'); return; }
  const idx  = scheduleData.indexOf(src);
  const user = getUser();
  const copy = { ...src, id: nextId++, createdBy: user ? { id: user.id, name: user.name } : null, createdAt: new Date().toISOString() };
  scheduleData.splice(idx + 1, 0, copy);
  saveToStorage();
  renderTable();
  markGanttDirty();
}

function deleteRow(id) {
  const row = scheduleData.find(r => r.id === id);
  if (!row) return;
  if (!canEditRow(row)) { showToast('작성자만 삭제할 수 있습니다.', 'info'); return; }
  if (detailEditingId === id) closeDetailPopup();
  selectedRowIds.delete(id);
  scheduleData = scheduleData.filter(r => r.id !== id);
  saveToStorage();
  renderTable();
  markGanttDirty();
}

/* ── 참고 링크 열기 ─────────────────────────────────────── */
function openLink(id) {
  const row = scheduleData.find(r => r.id === id);
  const link = row?.link?.trim();
  if (!link) { showToast('참고 링크가 입력되지 않았습니다.', 'error'); return; }
  const url = /^https?:\/\//i.test(link) ? link : `https://${link}`;
  window.open(url, '_blank', 'noopener');
}

/* ── 상세 내용 팝업 ─────────────────────────────────────── */
let detailEditingId = null;

function openDetailPopup(id) {
  const row = scheduleData.find(r => r.id === id);
  if (!row) return;
  detailEditingId = id;
  const label = [row.lv1, row.lv2, row.content].filter(Boolean).join(' / ');
  document.getElementById('detailRowLabel').textContent = label ? ` — ${label}` : '';
  document.getElementById('detailTextarea').value = row.detail || '';
  document.getElementById('detailOverlay').classList.add('open');
  document.getElementById('detailTextarea').focus();
}

function closeDetailPopup() {
  document.getElementById('detailOverlay').classList.remove('open');
  detailEditingId = null;
}

function saveDetailPopup() {
  if (detailEditingId === null) return;
  const row = scheduleData.find(r => r.id === detailEditingId);
  if (row) {
    if (!canEditRow(row)) { showToast('작성자만 수정할 수 있습니다.', 'info'); closeDetailPopup(); return; }
    row.detail = document.getElementById('detailTextarea').value;
    saveToStorage();
    renderTable();
    showToast('상세 내용이 저장되었습니다.', 'success');
  }
  closeDetailPopup();
}

function resetData() {
  const label = activeTab === 'plan' ? '일정 계획' : '완료';
  if (!confirm(`'${label}' 탭의 모든 데이터를 초기화하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
  selectedRowIds.clear();
  scheduleData = scheduleData.filter(r => !canEditRow(r));
  saveToStorage();
  renderTable();
  markGanttDirty();
}

/* ── 새로 만들기: 전체 초기화 후 신규모드로 입력 시작 ─────── */
function startNewVersion() {
  if (!confirm('현재 데이터를 모두 초기화하고 새 버전 작성을 시작하시겠습니까?\n저장하지 않은 변경사항은 사라집니다.')) return;

  planData = [];
  completedData = [];
  scheduleData = planData;
  activeTab = 'plan';
  nextId = 1;
  selectedRowIds.clear();

  filterManager = ''; filterKeyword = '';
  const fm = document.getElementById('filterManager'); if (fm) fm.value = '';
  const fk = document.getElementById('filterKeyword'); if (fk) fk.value = '';
  sortField = null; sortDir = 'asc';

  currentVersionId = null;
  currentVersionMeta = null;
  collabMode = null; collabToken = null; collabSaveId = null; collabOwnerName = null;
  hideCollabBanner();

  saveToStorage();
  updateTabUI();
  renderTable();
  updateSortIndicators();
  renderVersionMeta();
  markGanttDirty();
  renderGantt();
  showToast('새 버전 작성을 시작합니다. 입력 후 "💾 내 버전 저장"으로 저장해주세요.', 'info');
}

/* ── 페이지 이탈 시 신규모드 데이터 저장 확인 ─────────────── */
function confirmLeavePage() {
  syncActiveData();
  const hasData = planData.length > 0 || completedData.length > 0;
  if (collabMode === null && currentVersionId === null && hasData) {
    if (confirm('저장하지 않은 새 버전입니다. 메뉴로 나가면 변경사항이 사라집니다.\n저장하시겠습니까?')) {
      openSavePopup();
      return false;
    }
  }
  return true;
}

function updateField(id, field, value) {
  const row = scheduleData.find(r => r.id === id);
  if (!row) return;
  if (!canEditRow(row)) return;

  // 시작일~종료일 3년 초과 차단
  if ((field === 'startDate' || field === 'endDate') && value) {
    const s = field === 'startDate' ? value : row.startDate;
    const e = field === 'endDate'   ? value : row.endDate;
    if (s && e && s <= e) {
      const days = (new Date(e) - new Date(s)) / 86400000;
      if (days >= 1096) {
        showToast('기간이 3년을 초과할 수 없습니다.', 'error');
        const tr2 = document.querySelector(`#tableBody tr.data-row[data-id="${id}"]`);
        if (tr2) { const inp2 = tr2.querySelector(`[data-field="${field}"]`); if (inp2) inp2.value = row[field] ?? ''; }
        return;
      }
    }
  }

  row[field] = value;

  const tr = document.querySelector(`#tableBody tr.data-row[data-id="${id}"]`);
  if (field === 'startDate' && value && row.endDate && value > row.endDate) {
    row.endDate = value;
    if (tr) tr.querySelector('[data-field="endDate"]').value = value;
  }
  if (field === 'endDate' && value && row.startDate && value < row.startDate) {
    row.startDate = value;
    if (tr) tr.querySelector('[data-field="startDate"]').value = value;
  }

  saveToStorageDeferred();
  markGanttDirty();
}

/* ── Gantt (debounced render) ───────────────────────────── */

/* ── Row Selection ──────────────────────────────────────── */
function startRowSelect(e, id) {
  e.preventDefault();
  if (xlSel || xlRange) xlClearSel(); // 셀/범위 선택 해제 후 행 선택으로 전환
  isDragging   = true;
  dragAnchorId = id;
  if (e.ctrlKey || e.metaKey) {
    if (selectedRowIds.has(id)) selectedRowIds.delete(id);
    else selectedRowIds.add(id);
  } else if (e.shiftKey && dragAnchorId !== null) {
    selectRange(dragAnchorId, id);
  } else {
    selectedRowIds.clear();
    selectedRowIds.add(id);
    dragAnchorId = id;
  }
  updateRowHighlights();
}

function continueRowSelect(_e, id) {
  if (!isDragging || schedDrag.active) return;
  selectRange(dragAnchorId, id);
  updateRowHighlights();
}

function selectRange(fromId, toId) {
  const fromIdx = scheduleData.findIndex(r => r.id === fromId);
  const toIdx   = scheduleData.findIndex(r => r.id === toId);
  if (fromIdx < 0 || toIdx < 0) return;
  selectedRowIds.clear();
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  for (let i = lo; i <= hi; i++) selectedRowIds.add(scheduleData[i].id);
}

function updateRowHighlights() {
  document.querySelectorAll('#tableBody tr.data-row').forEach(tr => {
    tr.classList.toggle('row-selected', selectedRowIds.has(parseInt(tr.dataset.id)));
  });
  updateSelectedDeleteBtn();
}

function updateSelectedDeleteBtn() {
  const btn = document.getElementById('btnDeleteSelected');
  if (!btn) return;
  const n = selectedRowIds.size;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `🗑 선택 삭제 (${n})` : '🗑 선택 삭제';
}

function deleteSelectedRows() {
  if (selectedRowIds.size === 0) return;
  const ids = [...selectedRowIds];
  const rows = scheduleData.filter(r => ids.includes(r.id));
  const deletable = rows.filter(r => canEditRow(r));
  const blocked   = rows.filter(r => !canEditRow(r));
  if (deletable.length === 0) {
    showToast('선택한 행은 모두 다른 작성자의 행입니다. 삭제할 수 없습니다.', 'info');
    return;
  }
  const msg = blocked.length > 0
    ? `선택한 ${ids.length}개 중 내 행 ${deletable.length}개만 삭제됩니다.\n다른 작성자의 행 ${blocked.length}개는 삭제되지 않습니다.\n계속하시겠습니까?`
    : `선택한 ${ids.length}개 행을 삭제하시겠습니까?`;
  if (!confirm(msg)) return;
  const deletableIds = new Set(deletable.map(r => r.id));
  if (detailEditingId !== null && deletableIds.has(detailEditingId)) closeDetailPopup();
  if (xlSel || xlRange) xlClearSel();
  scheduleData = scheduleData.filter(r => !deletableIds.has(r.id));
  selectedRowIds.clear();
  if (blocked.length > 0) showToast(`다른 작성자의 행 ${blocked.length}개는 삭제되지 않았습니다.`, 'info');
  saveToStorage();
  renderTable();
  markGanttDirty();
}

function copySelectedRows() {
  const rows = scheduleData.filter(r => selectedRowIds.has(r.id));
  if (!rows.length) return;
  const text = rows.map(r =>
    [r.lv1, r.lv2, r.content, r.link, r.manager, r.startDate, r.endDate].join('\t')
  ).join('\n');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text)
      .then(() => showToast(`${rows.length}행 복사됨`))
      .catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  syncCopy(text);
  showToast('복사됨');
}

function _execCmdCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
}

function syncCopy(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => _execCmdCopy(text));
  } else {
    _execCmdCopy(text);
  }
}

/* ── Table Render ───────────────────────────────────────── */
function renderTable() {
  xlEdit = false; xlSel = null; // clear XL state on rebuild
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';

  if (scheduleData.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    tr.innerHTML = '<td colspan="12">행 추가 버튼을 눌러 일정을 추가하세요.</td>';
    tbody.appendChild(tr);
    updateRowHighlights();
    return;
  }

  const moveTitle = activeTab === 'plan' ? '완료로 이동' : '계획으로 이동';
  const moveIcon  = activeTab === 'plan' ? '✅' : '↩';
  const filterActive = !!(filterManager.trim() || filterKeyword.trim());
  let visibleCount = 0;

  scheduleData.forEach((row, idx) => {
    const visible = matchesFilter(row);
    if (visible) visibleCount++;
    const tr = document.createElement('tr');
    const editable = canEditRow(row);
    const readonly = !editable;
    const collabClass = readonly ? ' row-uneditable' : ' row-editable';
    tr.className  = 'data-row' + (visible ? '' : ' row-hidden') + (readonly ? ' row-readonly' : '') + collabClass;
    tr.dataset.id = row.id;
    tr.setAttribute('onmouseenter', `continueRowSelect(event,${row.id})`);
    const xd = (ci, extraClass = '') => `class="xl-cell${extraClass}" data-ri="${idx}" data-ci="${ci}" tabindex="-1" onmousedown="xlMd(event,${idx},${ci})" ondblclick="xlDbl(event,${idx},${ci})"`;
    const dis = readonly ? ' disabled' : '';
    const dragMd = readonly ? '' : `onmousedown="startDragReorder(event,${idx})"`;
    const contentRows = (row.content.match(/\n/g) || []).length + 1;
    tr.innerHTML  = `
      <td class="drag-handle" ${dragMd}>⠿</td>
      <td class="row-handle" onmousedown="startRowSelect(event,${row.id})">${idx + 1}</td>
      <td ${xd(0)}><input type="text" value="${esc(row.lv1)}"     placeholder="대분류"    oninput="updateField(${row.id},'lv1',this.value)"${dis}></td>
      <td ${xd(1)}><input type="text" value="${esc(row.lv2)}"     placeholder="중분류"    oninput="updateField(${row.id},'lv2',this.value)"${dis}></td>
      <td ${xd(2, ' cell-content')}><textarea class="cell-textarea" rows="${contentRows}" placeholder="내용" oninput="updateField(${row.id},'content',this.value);growContentCell(this)"${dis}>${esc(row.content)}</textarea></td>
      <td ${xd(3)}>
        <div class="link-cell">
          <input type="text" value="${esc(row.link)}" placeholder="https://…" oninput="updateField(${row.id},'link',this.value)"${dis}>
          <button class="link-open-btn" title="참고링크 열기" onmousedown="event.stopPropagation()" ondblclick="event.stopPropagation()" onclick="event.stopPropagation();openLink(${row.id})">🔗</button>
        </div>
      </td>
      <td ${xd(4)}><input type="text" value="${esc(row.manager)}" placeholder="담당자"    oninput="updateField(${row.id},'manager',this.value)"${dis}></td>
      <td ${xd(5)}><input type="text" data-field="startDate" value="${row.startDate}" placeholder="YYYYMMDD" maxlength="10" oninput="onDateInput(this,${row.id},'startDate')" onblur="onDateBlur(this,${row.id},'startDate')" onpaste="handleDateInputPaste(event,${row.id},'startDate')"${dis}></td>
      <td ${xd(6)}><input type="text" data-field="endDate"   value="${row.endDate}"   placeholder="YYYYMMDD" maxlength="10" oninput="onDateInput(this,${row.id},'endDate')"   onblur="onDateBlur(this,${row.id},'endDate')"   onpaste="handleDateInputPaste(event,${row.id},'endDate')"${dis}></td>
      <td class="cell-creator" title="${esc(row.createdBy?.name || '')}">${esc(row.createdBy?.name || '-')}</td>
      <td class="cell-createdat">${fmtDateTime(row.createdAt)}</td>
      <td class="action-cell">
        <button class="btn-detail${row.detail ? ' has-detail' : ''}" onclick="openDetailPopup(${row.id})" title="상세 내용${row.detail ? ' (작성됨)' : ''}">📝</button>
        <button class="btn-copy"   onclick="copyRow(${row.id})"   title="행 복사">⧉</button>
        <button class="btn-move"   onclick="moveRow(${row.id})"   title="${moveTitle}">${moveIcon}</button>
        <button class="btn-delete" onclick="deleteRow(${row.id})" title="삭제">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (filterActive && visibleCount === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    tr.innerHTML = '<td colspan="12">필터 조건에 맞는 일정이 없습니다.</td>';
    tbody.appendChild(tr);
  }

  updateRowHighlights();
}

/* ── 내용 셀: Shift+Enter 줄바꿈 시 행 높이 자동 확장 ───────── */
function growContentCell(ta) {
  const n = (ta.value.match(/\n/g) || []).length + 1;
  if (ta.rows !== n) ta.rows = n;
}

/* ── 생성일시 표시 포맷 ─────────────────────────────────── */
function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/* ── 오늘 컬럼 스크롤 ───────────────────────────────────── */
function scrollToToday() {
  const wrap     = document.getElementById('ganttWrap');
  const scrollEl = wrap?.querySelector('.gantt-scroll');
  const todayTh  = wrap?.querySelector('.gth.day-th.today');
  if (!scrollEl || !todayTh) return;
  const fixedW = ganttColWidths.reduce((a,b)=>a+b,0);
  scrollEl.scrollLeft = todayTh.offsetLeft - fixedW - (scrollEl.clientWidth - fixedW) / 2;
}

/* ── Gantt Popup ────────────────────────────────────────── */
function ganttShowPopup(e, text) {
  if (!text) return;
  const popup = document.getElementById('ganttPopup');
  if (!popup) return;
  popup.textContent = text;
  popup.style.left = (e.clientX + 12) + 'px';
  popup.style.top  = (e.clientY + 12) + 'px';
  popup.style.display = 'block';
  setTimeout(() => {
    const r = popup.getBoundingClientRect();
    if (r.right  > window.innerWidth)  popup.style.left = Math.max(0, e.clientX - r.width  - 6) + 'px';
    if (r.bottom > window.innerHeight) popup.style.top  = Math.max(0, e.clientY - r.height - 6) + 'px';
    document.addEventListener('mousedown', closeGanttPopup, { once: true });
  }, 0);
}
function closeGanttPopup() {
  const p = document.getElementById('ganttPopup');
  if (p) p.style.display = 'none';
}

/* ── Gantt Hover Tooltip ────────────────────────────────── */
let _gttTimer = null;
let _gttCell  = null;

function initGanttTooltip(wrap) {
  const scroll = wrap.querySelector('.gantt-scroll');
  if (!scroll) return;
  scroll.addEventListener('mouseover', e => {
    const cell = e.target.closest('td.fix-col[data-text], td.gantt-cell.active');
    if (cell === _gttCell) return;
    clearTimeout(_gttTimer);
    hideGanttTooltip();
    _gttCell = cell;
    if (cell) _gttTimer = setTimeout(() => showGanttTooltip(e, cell), 320);
  });
  scroll.addEventListener('mousemove', e => {
    const tt = document.getElementById('ganttTooltip');
    if (tt?.style.display === 'block') positionGanttTooltip(tt, e);
  });
  scroll.addEventListener('mouseout', e => {
    if (!e.relatedTarget?.closest('.gantt-scroll')) {
      clearTimeout(_gttTimer); hideGanttTooltip(); _gttCell = null;
    }
  });
}

function showGanttTooltip(e, cell) {
  const tt = document.getElementById('ganttTooltip');
  if (!tt) return;
  let html = '';
  if (cell.classList.contains('fix-col')) {
    const text = cell.dataset.text;
    if (!text) return;
    html = `<div class="gtt-label">${esc(text)}</div>`;
  } else {
    const tr = cell.closest('tr');
    if (!tr) return;
    const { content, manager, start, end } = tr.dataset;
    if (!content && !manager) return;
    if (content) html += `<div class="gtt-title">${esc(content)}</div>`;
    const metas = [];
    if (manager) metas.push(`<span class="gtt-meta">👤 ${esc(manager)}</span>`);
    if (start && end) metas.push(`<span class="gtt-meta">📅 ${start} ~ ${end}</span>`);
    if (metas.length) html += `<div class="gtt-meta-row">${metas.join('')}</div>`;
  }
  if (!html) return;
  tt.innerHTML = html;
  positionGanttTooltip(tt, e);
  tt.style.display = 'block';
}

function positionGanttTooltip(tt, e) {
  tt.style.left = (e.clientX + 14) + 'px';
  tt.style.top  = (e.clientY + 14) + 'px';
  requestAnimationFrame(() => {
    const r = tt.getBoundingClientRect();
    if (r.right  > window.innerWidth  - 8) tt.style.left = Math.max(8, e.clientX - r.width  - 8) + 'px';
    if (r.bottom > window.innerHeight - 8) tt.style.top  = Math.max(8, e.clientY - r.height - 8) + 'px';
  });
}

function hideGanttTooltip() {
  const tt = document.getElementById('ganttTooltip');
  if (tt) tt.style.display = 'none';
}


/* ── Gantt Render ───────────────────────────────────────── */
function renderGantt() {
  const wrap = document.getElementById('ganttWrap');
  const info = document.getElementById('ganttInfo');
  const _dirtyBtn = document.querySelector('.btn-update');
  if (_dirtyBtn) _dirtyBtn.classList.remove('dirty');

  try {
    let items = scheduleData.filter(r => r.startDate && r.endDate && r.startDate <= r.endDate && matchesFilter(r));
    if (ganttGroupByLv2) items = groupByLv2(items);

    if (items.length === 0) {
      const filterActive = !!(filterManager.trim() || filterKeyword.trim());
      wrap.innerHTML   = filterActive
        ? '<p class="gantt-empty">필터 조건에 맞는 일정이 없습니다.</p>'
        : '<p class="gantt-empty">시작일·종료일이 모두 설정된 일정이 없습니다.</p>';
      info.textContent = '';
      return;
    }

    const minDate = items.reduce((m, r) => (r.startDate < m ? r.startDate : m), items[0].startDate);
    const maxDate = items.reduce((m, r) => (r.endDate   > m ? r.endDate   : m), items[0].endDate);

    const MAX_DAYS = 1096;
    const allDates = [];
    let cur = minDate;
    while (cur <= maxDate) {
      allDates.push(cur);
      if (allDates.length > MAX_DAYS) {
        wrap.innerHTML   = `<p class="gantt-empty">날짜 범위가 ${MAX_DAYS}일을 초과합니다. 일정 범위를 줄여주세요.</p>`;
        info.textContent = '';
        return;
      }
      cur = dateNext(cur);
    }

    const today        = fmtDate(new Date());
    const currentMonth = today.slice(0, 7);
    const dates = allDates.filter(d =>
      d.slice(0, 7) === currentMonth || items.some(r => d >= r.startDate && d <= r.endDate)
    );

    // Compact mode: only show start/end date columns
    let visDates = dates;
    if (ganttCompact) {
      const keySet = new Set();
      items.forEach(r => { if (r.startDate) keySet.add(r.startDate); if (r.endDate) keySet.add(r.endDate); });
      if (dates.includes(today)) keySet.add(today); // 오늘 날짜는 항상 포함
      const filtered = dates.filter(d => keySet.has(d));
      if (filtered.length) visDates = filtered;
    }

    info.textContent = `${minDate} ~ ${maxDate}  (${visDates.length}일 · ${items.length}건)${ganttCompact ? ' [날짜요약]' : ''}${ganttGroupByLv2 ? ' [중분류요약]' : ''}`;

    const months = [];
    visDates.forEach(d => {
      const key = d.slice(0, 7);
      if (!months.length || months[months.length - 1].key !== key) {
        const [y, mo] = key.split('-');
        months.push({ key, year: y, label: ganttCompact ? `${y.slice(2)}년 ${+mo}월` : `${y}년 ${+mo}월`, count: 1 });
      } else months[months.length - 1].count++;
    });
    const uniqueYears = [];
    months.forEach(m => { if (!uniqueYears.includes(m.year)) uniqueYears.push(m.year); });
    const yearColorIdx = Object.fromEntries(uniqueYears.map((y, i) => [y, i % 3]));

    const dateMeta = visDates.map(d => {
      const dow     = dateDow(d);
      const isToday = d === today;
      const dayCls  = isToday ? ' today' : dow === 6 ? ' sat' : dow === 0 ? ' sun' : '';
      const yi      = yearColorIdx[d.slice(0, 4)] ?? 0;
      return { d, dow, dayCls, yi };
    });

    // Sequential rowspans — respects input order, splits non-consecutive same-value groups
    const n = items.length;
    const lv1Spans = new Array(n).fill(0);
    const lv2Spans = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (i === 0 || items[i].lv1 !== items[i-1].lv1) {
        let s = 1;
        while (i + s < n && items[i+s].lv1 === items[i].lv1) s++;
        lv1Spans[i] = s;
      }
      if (i === 0 || items[i].lv2 !== items[i-1].lv2 || items[i].lv1 !== items[i-1].lv1) {
        let s = 1;
        while (i + s < n && items[i+s].lv2 === items[i].lv2 && items[i+s].lv1 === items[i].lv1) s++;
        lv2Spans[i] = s;
      }
    }

    const DOW = ['일', '월', '화', '수', '목', '금', '토'];
    const W   = ganttColWidths;
    const L   = ganttComputeLeft();

    const p = [];
    p.push(`<div class="gantt-scroll"><table class="gantt-table${ganttCompact ? ' gantt-compact' : ''}"><thead><tr>`);
    p.push(`<th rowspan="2" class="gth fix-col" style="left:${L[0]}px;min-width:${W[0]}px">대분류</th>`);
    p.push(`<th rowspan="2" class="gth fix-col" style="left:${L[1]}px;min-width:${W[1]}px">중분류</th>`);
    p.push(`<th rowspan="2" class="gth fix-col" style="left:${L[2]}px;min-width:${W[2]}px">내용</th>`);
    p.push(`<th rowspan="2" class="gth fix-col fix-shadow" style="left:${L[3]}px;min-width:${W[3]}px">담당자</th>`);
    months.forEach(mg => {
      const yi = yearColorIdx[mg.year];
      p.push(`<th colspan="${mg.count}" class="gth month-th month-th-y${yi}">${mg.label}</th>`);
    });
    p.push('</tr><tr>');
    dateMeta.forEach(({ d, dow, dayCls, yi }) => {
      p.push(`<th class="gth day-th${dayCls} day-y${yi}">${dateDay(d)}<br>${DOW[dow]}</th>`);
    });
    p.push('</tr></thead><tbody>');

    items.forEach((item, i) => {
      const lv1 = item.lv1 || '(미분류)';
      const lv2 = item.lv2 || '(미분류)';
      p.push(`<tr data-content="${esc(item.content)}" data-manager="${esc(item.manager)}" data-start="${item.startDate}" data-end="${item.endDate}">`);
      if (lv1Spans[i] > 0)
        p.push(`<td class="gtd fix-col lv1-td" rowspan="${lv1Spans[i]}" style="left:${L[0]}px;min-width:${W[0]}px" data-text="${esc(lv1)}" ondblclick="ganttShowPopup(event,this.dataset.text)"><div class="gtd-clip" style="width:${W[0]-21}px">${esc(lv1)}</div></td>`);
      if (lv2Spans[i] > 0)
        p.push(`<td class="gtd fix-col lv2-td" rowspan="${lv2Spans[i]}" style="left:${L[1]}px;min-width:${W[1]}px" data-text="${esc(lv2)}" ondblclick="ganttShowPopup(event,this.dataset.text)"><div class="gtd-clip" style="width:${W[1]-21}px">${esc(lv2)}</div></td>`);
      p.push(`<td class="gtd fix-col content-td" style="left:${L[2]}px;min-width:${W[2]}px" data-text="${esc(item.content)}" ondblclick="ganttShowPopup(event,this.dataset.text)"><div class="gtd-clip" style="width:${W[2]-21}px">${esc(item.content)}</div></td>`);
      p.push(`<td class="gtd fix-col fix-shadow mgr-td" style="left:${L[3]}px;min-width:${W[3]}px" data-text="${esc(item.manager)}" ondblclick="ganttShowPopup(event,this.dataset.text)"><div class="gtd-clip" style="width:${W[3]-21}px">${esc(item.manager)}</div></td>`);
      dateMeta.forEach(({ d, dayCls, yi }) => {
        const active = d >= item.startDate && d <= item.endDate;
        p.push(`<td class="gantt-cell${active ? ' active' : ''}${dayCls} day-y${yi}"></td>`);
      });
      p.push('</tr>');
    });

    p.push('</tbody></table></div>');
    wrap.innerHTML = p.join('');
    initGanttColResize(wrap);
    initGanttTooltip(wrap);
    requestAnimationFrame(scrollToToday);

  } catch (err) {
    wrap.innerHTML   = `<p class="gantt-empty">렌더링 오류: ${esc(err.message)}</p>`;
    info.textContent = '';
    console.error('[Gantt]', err);
  }
}

/* ── Excel 다운로드 ──────────────────────────────────────── */
function downloadExcel() {
  const headers = ['대분류(LV1)', '중분류(LV2)', '내용', '참고링크', '담당자', '시작일', '종료일'];
  const rows    = scheduleData.map(r => [r.lv1, r.lv2, r.content, r.link, r.manager, r.startDate, r.endDate]);
  const wb      = XLSX.utils.book_new();
  const ws      = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols']   = [{ wch: 18 }, { wch: 18 }, { wch: 50 }, { wch: 40 }, { wch: 12 }, { wch: 14 }, { wch: 14 }];
  const rowCount = rows.length + 1;
  ws['!rows']   = Array.from({ length: rowCount }, () => ({ hpx: 15 }));
  XLSX.utils.book_append_sheet(wb, ws, '일정관리');
  const wsGantt = buildGanttSheet();
  if (wsGantt) XLSX.utils.book_append_sheet(wb, wsGantt, '간트차트');
  XLSX.writeFile(wb, '일정관리.xlsx');
}

function buildGanttSheet() {
  const items = scheduleData.filter(r => r.startDate && r.endDate && r.startDate <= r.endDate);
  if (!items.length) return null;

  const keySet = new Set();
  items.forEach(r => { keySet.add(r.startDate); keySet.add(r.endDate); });
  const keyDates = [...keySet].sort();

  // Month map
  const monthMap = [];
  keyDates.forEach((d, i) => {
    const mo = d.slice(0, 7);
    if (!monthMap.length || monthMap[monthMap.length - 1].key !== mo) {
      monthMap.push({ key: mo, start: 4 + i, count: 1 });
    } else {
      monthMap[monthMap.length - 1].count++;
    }
  });

  // Year color palettes: y0=indigo, y1=amber, y2=rose
  const Y_FILLS        = ['E0E7FF', 'FEF3C7', 'FFE4E6'];
  const Y_FONTS        = ['312E81', '78350F', '9F1239'];
  const Y_ACTIVE_FILLS = ['C7D2FE', 'FDE68A', 'FECDD3'];
  const Y_ACTIVE_BORDS = ['A5B4FC', 'FCD34D', 'FDA4AF'];
  const uYears  = [...new Set(monthMap.map(m => m.key.slice(0, 4)))];
  const yIdx    = Object.fromEntries(uYears.map((y, i) => [y, i % 3]));

  const totalRows = 2 + items.length;
  const totalCols = 4 + keyDates.length;
  const merges    = [];
  const ws        = {};

  const tb = (rgb = 'CCCCCC') => ({
    top: { style: 'thin', color: { rgb } }, bottom: { style: 'thin', color: { rgb } },
    left: { style: 'thin', color: { rgb } }, right: { style: 'thin', color: { rgb } },
  });
  const sc = (r, c, v, s) => { ws[XLSX.utils.encode_cell({ r, c })] = { v: v ?? '', t: 's', s }; };

  // Row 0: month headers (fixed-col placeholders + month labels)
  for (let c = 0; c < 4; c++) {
    sc(0, c, '', { fill: { patternType: 'solid', fgColor: { rgb: '1E293B' } }, border: tb('475569') });
  }
  monthMap.forEach(m => {
    const yi = yIdx[m.key.slice(0, 4)];
    const [y, mo] = m.key.split('-');
    sc(0, m.start, `${y}년 ${+mo}월`, {
      fill: { patternType: 'solid', fgColor: { rgb: Y_FILLS[yi] } },
      font: { name: 'Arial', sz: 9, bold: true, color: { rgb: Y_FONTS[yi] } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: tb('AAAAAA'),
    });
    for (let i = 1; i < m.count; i++) {
      sc(0, m.start + i, '', {
        fill: { patternType: 'solid', fgColor: { rgb: Y_FILLS[yi] } },
        border: tb('AAAAAA'),
      });
    }
    if (m.count > 1) merges.push({ s: { r: 0, c: m.start }, e: { r: 0, c: m.start + m.count - 1 } });
  });

  // Row 1: column headers
  const HDR = {
    fill: { patternType: 'solid', fgColor: { rgb: '334155' } },
    font: { name: 'Arial', sz: 9, bold: true, color: { rgb: 'FFFFFF' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: tb('475569'),
  };
  ['대분류(LV1)', '중분류(LV2)', '내용', '담당자'].forEach((h, c) => sc(1, c, h, HDR));
  keyDates.forEach((d, i) => {
    const yi = yIdx[d.slice(0, 4)] ?? 0;
    sc(1, 4 + i, d.slice(5), {
      fill: { patternType: 'solid', fgColor: { rgb: Y_FILLS[yi] } },
      font: { name: 'Arial', sz: 8, bold: true, color: { rgb: Y_FONTS[yi] } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: tb('AAAAAA'),
    });
  });

  // Row 2+: data
  const LV1 = { fill: { patternType: 'solid', fgColor: { rgb: 'C7D2FE' } }, font: { name: 'Arial', sz: 9, color: { rgb: '1E1B4B' } }, alignment: { horizontal: 'center', vertical: 'center' }, border: tb('AAAAAA') };
  const LV2 = { fill: { patternType: 'solid', fgColor: { rgb: 'EDE9FE' } }, font: { name: 'Arial', sz: 9, color: { rgb: '4C1D95' } }, alignment: { horizontal: 'center', vertical: 'center' }, border: tb('AAAAAA') };
  const CTX = { fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } }, font: { name: 'Arial', sz: 9 }, alignment: { horizontal: 'left', vertical: 'center' }, border: tb('CCCCCC') };
  const MGR = { fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } }, font: { name: 'Arial', sz: 9 }, alignment: { horizontal: 'center', vertical: 'center' }, border: tb('CCCCCC') };

  items.forEach((item, ri) => {
    const r = 2 + ri;
    sc(r, 0, item.lv1, LV1);
    sc(r, 1, item.lv2, LV2);
    sc(r, 2, item.content, CTX);
    sc(r, 3, item.manager, MGR);
    keyDates.forEach((d, i) => {
      const active = d >= item.startDate && d <= item.endDate;
      const yi = yIdx[d.slice(0, 4)] ?? 0;
      sc(r, 4 + i, '', {
        fill: { patternType: 'solid', fgColor: { rgb: active ? Y_ACTIVE_FILLS[yi] : 'FFFFFF' } },
        border: tb(active ? Y_ACTIVE_BORDS[yi] : 'E5E7EB'),
      });
    });
  });

  ws['!cols']   = [{ wch: 18 }, { wch: 18 }, { wch: 40 }, { wch: 12 }, ...keyDates.map(() => ({ wch: 7 }))];
  ws['!rows']   = Array.from({ length: totalRows }, () => ({ hpx: 15 }));
  ws['!merges'] = merges;
  ws['!ref']    = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totalRows - 1, c: totalCols - 1 } });
  return ws;
}


/* ── Excel 업로드 ────────────────────────────────────────── */
function uploadExcel(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb   = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' });

      scheduleData = [];

      rows.slice(1).forEach(row => {
        if (!row || row.every(c => c === null || c === undefined || c === '')) return;
        const toDate = v => {
          if (!v) return '';
          const s = String(v).trim().slice(0, 10);
          return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
        };
        scheduleData.push({
          id: nextId++,
          lv1:       String(row[0] ?? ''),
          lv2:       String(row[1] ?? ''),
          content:   String(row[2] ?? ''),
          link:      String(row[3] ?? ''),
          manager:   String(row[4] ?? ''),
          startDate: toDate(row[5]),
          endDate:   toDate(row[6]),
        });
      });

      saveToStorage();
      renderTable();
      alert(`✅ ${scheduleData.length}개 일정을 불러왔습니다.`);
      ganttCompact = true;
      updateCompactBtn();
      renderGantt();
    } catch (err) {
      alert('파일 읽기 오류: ' + err.message);
    } finally {
      input.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ── Toast ───────────────────────────────────────────────── */
function showToast(msg, type = 'error') {
  let toast = document.getElementById('schedToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'schedToast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `sched-toast ${type}`;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 2800);
}

/* ── Data Manager callbacks ─────────────────────────────── */
window.getMenuData = () => {
  syncActiveData();
  return { data: planData, completedData, nextId, activeTab };
};
window.setMenuData = d => {
  planData      = d.data || [];
  completedData = d.completedData || [];
  activeTab     = d.activeTab === 'completed' ? 'completed' : 'plan';
  nextId = d.nextId || (Math.max(0, ...planData.map(r => r.id), ...completedData.map(r => r.id), 0) + 1);
  scheduleData = activeTab === 'plan' ? planData : completedData;
  filterManager = '';
  filterKeyword = '';
  sortField = null;
  sortDir   = 'asc';
  saveToStorage();
  updateTabUI();
  renderTable();
  updateSortIndicators();
  ganttCompact = true;
  updateCompactBtn();
  renderGantt();
};

/* ── 공유 진입(?share=, ?collab=) ────────────────────────── */
async function initSharedView(token) {
  try {
    const res = await fetch(SCHED_API + '/data/public', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      _blockPage(res.status === 404
        ? { icon: '🔗', title: '유효하지 않은 공유 링크입니다', desc: '공유가 취소됐거나 링크가 만료됐습니다.' }
        : { icon: '⚠️', title: '링크 조회 중 오류가 발생했습니다', desc: '잠시 후 다시 시도해주세요.' });
      return;
    }
    const d = await res.json();
    currentVersionId = null;
    currentVersionMeta = null;
    collabMode = 'view'; collabToken = null; collabSaveId = null; collabOwnerName = null;
    setMenuData(d.data);
    document.body.insertAdjacentHTML('afterbegin',
      `<div class="dm-share-banner">👁 공유된 버전을 보는 중입니다 · 수정 후 저장하면 별도 버전으로 저장되며, 공유자의 내용은 변경되지 않습니다.&nbsp;&nbsp;<a href="${location.pathname}">내 데이터로 돌아가기</a></div>`
    );
  } catch {
    _blockPage({ icon: '⚠️', title: '서버에 연결할 수 없습니다', desc: '네트워크 상태를 확인해주세요.' });
  }
}

async function initCollabView(token) {
  try {
    const res = await fetch(SCHED_API + '/data/public-collab', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      _blockPage(res.status === 404
        ? { icon: '🔗', title: '유효하지 않은 공유 링크입니다', desc: '공유가 취소됐거나 링크가 만료됐습니다.' }
        : { icon: '⚠️', title: '링크 조회 중 오류가 발생했습니다', desc: '잠시 후 다시 시도해주세요.' });
      return;
    }
    const d = await res.json();
    currentVersionId = null;
    currentVersionMeta = null;
    collabMode = 'collab';
    collabToken = token;
    collabSaveId = d.saveId;
    collabOwnerName = d.ownerName;
    setMenuData(d.data);
    showCollabBanner();
  } catch {
    _blockPage({ icon: '⚠️', title: '서버에 연결할 수 없습니다', desc: '네트워크 상태를 확인해주세요.' });
  }
}

function _blockPage({ icon, title, desc }) {
  document.body.insertAdjacentHTML('afterbegin', `
    <div class="dm-block-page">
      <div class="dm-block-box">
        <div class="dm-block-icon">${icon}</div>
        <div class="dm-block-title">${title}</div>
        <div class="dm-block-desc">${desc}</div>
        <a class="dm-block-btn" href="${location.pathname}">페이지로 돌아가기</a>
      </div>
    </div>
  `);
  document.body.style.overflow = 'hidden';
}

/* ── 협업 배너 ─────────────────────────────────────────── */
function showCollabBanner() {
  const el = document.getElementById('collabBanner');
  if (!el) return;
  const loggedIn = !!getUser();
  el.innerHTML =
    `<span>🤝 ${esc(collabOwnerName || '')}님의 일정에 협업 중입니다.${loggedIn ? '' : ' 🔒 로그인하면 일정을 추가할 수 있습니다.'}</span>` +
    (loggedIn ? `<button class="btn-save-original" onclick="saveToOriginal()">원본에 저장</button>` : '');
  el.classList.add('show');
}
function hideCollabBanner() {
  const el = document.getElementById('collabBanner');
  if (!el) return;
  el.classList.remove('show');
  el.innerHTML = '';
}
async function refreshCollabBanner() {
  try {
    const res = await fetch(SCHED_API + '/data/meta', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: collabSaveId }),
    });
    const d = await res.json();
    collabOwnerName = res.ok ? d.meta.creator_name : '알수없음';
  } catch { collabOwnerName = '알수없음'; }
  showCollabBanner();
}

/* ── 협업 권한 ─────────────────────────────────────────── */
function canEditRow(row) {
  if (collabMode === 'view') return true;
  if (!row.createdBy) return true;
  const user = getUser();
  return !!user && row.createdBy.id === user.id;
}

/* ── 원본에 저장 (협업) ──────────────────────────────────── */
async function saveToOriginal() {
  if (!getToken()) { showToast('로그인이 필요합니다.', 'error'); return; }
  try {
    const res = await fetch(SCHED_API + '/data/collab-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ token: collabToken, saveId: collabSaveId, data: getMenuData() }),
    });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || '저장 실패', 'error'); return; }
    collabSaveId = d.saveId;
    setMenuData(d.data);
    showToast('원본에 저장되었습니다.', 'success');
  } catch { showToast('서버 연결 오류', 'error'); }
}

/* ── 버전 메타(회색 텍스트) ──────────────────────────────── */
function renderVersionMeta() {
  const el = document.getElementById('versionMeta');
  if (!el) return;
  if (!currentVersionMeta) { el.innerHTML = ''; return; }
  const fmt = t => new Date(t).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const created = fmt(currentVersionMeta.created_at);
  const updated = currentVersionMeta.updated_at ? fmt(currentVersionMeta.updated_at) : null;
  const lines = [
    `📌 ${esc(currentVersionMeta.title)}`,
    `저장: ${created}${updated && updated !== created ? ` · 수정: ${updated}` : ''}`,
    `등록: ${esc(currentVersionMeta.creator_name || '')}`,
  ];
  el.innerHTML = lines.join('<br>');
}

async function refreshVersionMeta() {
  if (!currentVersionId) { currentVersionMeta = null; renderVersionMeta(); return; }
  try {
    const res = await fetch(SCHED_API + '/data/meta', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentVersionId }),
    });
    const d = await res.json();
    if (!res.ok) {
      currentVersionId = null; currentVersionMeta = null;
      saveToStorage(); renderVersionMeta();
      return;
    }
    currentVersionMeta = d.meta;
    renderVersionMeta();
  } catch { /* 네트워크 오류 시 회색 텍스트는 갱신하지 않음 */ }
}

/* ── 버전 저장 팝업 ──────────────────────────────────────── */
let _savingVer = false;
let _pendingShareAfterSave = false;

function openSavePopup() {
  if (!getToken()) { showToast('로그인이 필요합니다.', 'error'); return; }
  const titleInput = document.getElementById('saveTitleInput');
  titleInput.value = currentVersionMeta?.title || '';
  const own = !!(currentVersionId && currentVersionMeta?.user_id === getUser()?.id);
  document.getElementById('btnOverwrite').style.display = own ? '' : 'none';
  document.getElementById('btnSaveCopy').textContent = own ? '신규 버전 복사' : '저장';
  document.getElementById('saveOverlay').classList.add('open');
  setTimeout(() => titleInput.focus(), 50);
}
function closeSavePopup() {
  document.getElementById('saveOverlay').classList.remove('open');
  _pendingShareAfterSave = false;
}

async function confirmOverwrite() {
  if (_savingVer) return;
  const title = document.getElementById('saveTitleInput').value.trim();
  if (!title) { showToast('제목을 입력하세요.', 'error'); return; }
  _savingVer = true;
  try {
    const res = await fetch(SCHED_API + '/data/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ id: currentVersionId, title, data: getMenuData() }),
    });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || '저장 실패', 'error'); return; }
    currentVersionMeta = { ...currentVersionMeta, title, updated_at: d.updated_at };
    renderVersionMeta();
    closeSavePopup();
    showToast('저장되었습니다.', 'success');
  } catch { showToast('서버 연결 오류', 'error'); }
  finally { _savingVer = false; }
}

async function confirmSaveCopy() {
  if (_savingVer) return;
  const title = document.getElementById('saveTitleInput').value.trim();
  if (!title) { showToast('제목을 입력하세요.', 'error'); return; }
  _savingVer = true;
  try {
    const res = await fetch(SCHED_API + '/data/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ menu_key: 'schedule', title, data: getMenuData() }),
    });
    const d = await res.json();
    if (!res.ok) {
      if (d.limitExceeded) {
        closeSavePopup();
        showToast(d.error, 'error');
        setTimeout(() => openLoadPopup(), 300);
        return;
      }
      showToast(d.error || '저장 실패', 'error'); return;
    }
    const user = getUser();
    currentVersionId = d.id;
    currentVersionMeta = { id: d.id, title, created_at: d.created_at, updated_at: d.created_at, user_id: user?.id, creator_name: user?.name };
    saveToStorage();
    renderVersionMeta();
    closeSavePopup();
    showToast('저장되었습니다.', 'success');
    if (_pendingShareAfterSave) { _pendingShareAfterSave = false; openSharePopup(); }
  } catch { showToast('서버 연결 오류', 'error'); }
  finally { _savingVer = false; }
}

/* ── 공유 팝업 ──────────────────────────────────────────── */
function openSharePopup() {
  if (collabMode === 'collab') { showToast('협업 공유본에서는 공유하기를 사용할 수 없습니다.', 'error'); return; }
  if (!getToken()) { showToast('로그인이 필요합니다.', 'error'); return; }
  if (currentVersionId === null) {
    _pendingShareAfterSave = true;
    openSavePopup();
    showToast('먼저 버전을 저장해주세요.', 'info');
    return;
  }
  if (currentVersionMeta?.user_id !== getUser()?.id) {
    showToast('본인이 등록한 버전만 공유할 수 있습니다.', 'error');
    return;
  }
  document.getElementById('shareOverlay').classList.add('open');
}
function closeSharePopup() {
  document.getElementById('shareOverlay').classList.remove('open');
}

async function shareView() {
  try {
    const res = await fetch(SCHED_API + '/data/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ id: currentVersionId }),
    });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || '공유 링크 생성 실패', 'error'); return; }
    const url = `${location.origin}${location.pathname}?share=${d.token}`;
    await navigator.clipboard.writeText(url);
    closeSharePopup();
    showToast('공유(조회) 링크가 복사됐습니다.', 'success');
  } catch { showToast('링크 생성 오류', 'error'); }
}

async function shareCollabLink() {
  try {
    const res = await fetch(SCHED_API + '/data/share-collab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ id: currentVersionId }),
    });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || '공유 링크 생성 실패', 'error'); return; }
    const url = `${location.origin}${location.pathname}?collab=${d.token}`;
    await navigator.clipboard.writeText(url);
    closeSharePopup();
    showToast('변경공유 링크가 복사됐습니다.', 'success');
  } catch { showToast('링크 생성 오류', 'error'); }
}

async function quickShareView(id, btn) {
  btn.disabled = true; btn.textContent = '생성 중...';
  try {
    const res = await fetch(SCHED_API + '/data/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || '공유 링크 생성 실패', 'error'); return; }
    const url = `${location.origin}${location.pathname}?share=${d.token}`;
    await navigator.clipboard.writeText(url);
    showToast('공유(조회) 링크가 복사됐습니다.', 'success');
  } catch { showToast('링크 생성 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '🔍 조회'; }
}

async function quickShareCollab(id, btn) {
  btn.disabled = true; btn.textContent = '생성 중...';
  try {
    const res = await fetch(SCHED_API + '/data/share-collab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || '공유 링크 생성 실패', 'error'); return; }
    const url = `${location.origin}${location.pathname}?collab=${d.token}`;
    await navigator.clipboard.writeText(url);
    showToast('변경공유 링크가 복사됐습니다.', 'success');
  } catch { showToast('링크 생성 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '변경공유'; }
}


/* ── 버전 불러오기 팝업 ──────────────────────────────────── */
async function openLoadPopup() {
  if (!getToken()) { showToast('로그인이 필요합니다.', 'error'); return; }
  document.getElementById('versionList').innerHTML = '<div class="version-empty">불러오는 중...</div>';
  document.getElementById('loadOverlay').classList.add('open');
  try {
    const res = await fetch(SCHED_API + '/data/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ menu_key: 'schedule' }),
    });
    const d = await res.json();
    if (!res.ok) { document.getElementById('versionList').innerHTML = '<div class="version-empty">목록 조회 실패</div>'; return; }
    _renderVersionList(d.list);
  } catch { document.getElementById('versionList').innerHTML = '<div class="version-empty">서버 연결 오류</div>'; }
}
function closeLoadPopup() {
  document.getElementById('loadOverlay').classList.remove('open');
}

function _renderVersionList(list) {
  const el = document.getElementById('versionList');
  if (!list?.length) { el.innerHTML = '<div class="version-empty">저장된 버전이 없습니다.</div>'; return; }
  el.innerHTML = list.map(v => {
    const dt = new Date(v.updated_at || v.created_at).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const badge = v.is_collab ? `<span class="version-collab-badge">🤝 ${esc(v.owner_name)}</span>` : '';
    const shareBtns = v.is_collab ? '' : `
      <button class="btn-load-ver" onclick="quickShareView(${v.id},this)">🔍 조회</button>
      <button class="btn-load-ver btn-ver-collab" onclick="quickShareCollab(${v.id},this)">변경공유</button>`;
    return `<div class="version-item">
      ${badge}
      <span class="version-title">${esc(v.title)}</span>
      <span class="version-date">${dt}</span>
      <div class="version-item-btns">
        <button class="btn-load-ver" onclick="loadVersion(${v.id},${!!v.is_collab})">불러오기</button>
        ${shareBtns}
        <button class="btn-del-ver" onclick="deleteVersionEntry(${v.id})">${v.is_collab ? '목록에서 제거' : '삭제'}</button>
      </div>
    </div>`;
  }).join('');
}

async function loadVersion(id, isCollab) {
  if (!confirm('현재 데이터가 초기화됩니다. 계속하시겠습니까?')) return;
  try {
    const res = await fetch(SCHED_API + '/data/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || '불러오기 실패', 'error'); return; }
    if (isCollab) {
      collabMode = 'collab';
      collabToken = null;
      collabSaveId = id;
      currentVersionId = null;
      currentVersionMeta = null;
      setMenuData(d.data);
      renderVersionMeta();
      await refreshCollabBanner();
    } else {
      collabMode = null;
      collabToken = null;
      collabSaveId = null;
      collabOwnerName = null;
      currentVersionId = id;
      setMenuData(d.data);
      hideCollabBanner();
      await refreshVersionMeta();
    }
    closeLoadPopup();
    showToast('불러왔습니다.', 'success');
  } catch { showToast('서버 연결 오류', 'error'); }
}

/* ── 첫 화면 진입 시 최근 버전 자동 로드(수정모드) ────────── */
async function loadMostRecentVersion() {
  try {
    const res = await fetch(SCHED_API + '/data/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ menu_key: 'schedule' }),
    });
    const d = await res.json();
    if (!res.ok || !d.list?.length) return false;
    const top = d.list[0];
    const lr = await fetch(SCHED_API + '/data/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ id: top.id }),
    });
    const ld = await lr.json();
    if (!lr.ok) return false;
    if (top.is_collab) {
      collabMode = 'collab';
      collabToken = null;
      collabSaveId = top.id;
      currentVersionId = null;
      currentVersionMeta = null;
      setMenuData(ld.data);
      renderVersionMeta();
      await refreshCollabBanner();
    } else {
      collabMode = null;
      collabToken = null;
      collabSaveId = null;
      collabOwnerName = null;
      currentVersionId = top.id;
      setMenuData(ld.data);
      hideCollabBanner();
      await refreshVersionMeta();
    }
    showToast('최근 저장된 버전을 불러왔습니다.', 'success');
    return true;
  } catch { return false; /* 자동 로드 실패 시 빈 화면 유지 */ }
}

async function deleteVersionEntry(id) {
  if (!confirm('이 버전을 삭제하시겠습니까?')) return;
  try {
    const res = await fetch(SCHED_API + '/data/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) { showToast('삭제 실패', 'error'); return; }
    if (currentVersionId === id) {
      currentVersionId = null; currentVersionMeta = null;
      saveToStorage(); renderVersionMeta();
    }
    openLoadPopup();
    showToast('삭제되었습니다.', 'success');
  } catch { showToast('서버 연결 오류', 'error'); }
}

/* ── 날짜 텍스트 입력 핸들러 ────────────────────────────── */
function onDateInput(input, id, field) {
  const digits = input.value.replace(/\D/g, '').slice(0, 8);
  let formatted = digits;
  if (digits.length > 6) formatted = `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6)}`;
  else if (digits.length > 4) formatted = `${digits.slice(0,4)}-${digits.slice(4)}`;
  input.value = formatted;
  if (digits.length === 8) updateField(id, field, formatted);
}

function onDateBlur(input, id, field) {
  if (_xlPasting) return; // xlHandlePaste 중 renderTable blur → 무시
  const v = input.value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    updateField(id, field, v);
  } else if (!v) {
    updateField(id, field, '');
  } else {
    input.value = '';
    updateField(id, field, '');
  }
}

/* ── 엑셀 붙여넣기 ──────────────────────────────────────── */
function handleTablePaste(e) {
  if (xlEdit) return;
  const clip = e.clipboardData?.getData('text/plain');
  if (!clip) return;

  // XL 탐색 모드: xlSel 기준으로 직접 처리 (날짜 셀 onpaste와 TD 위치 계산 의존 제거)
  if (xlSel) {
    e.preventDefault();
    xlHandlePaste(clip);
    return;
  }

  const td = e.target?.closest('td');
  const tr = e.target?.closest('tr.data-row');
  if (!td || !tr) return;
  e.preventDefault();

  const lines = clip.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return;

  const tds           = [...tr.querySelectorAll('td')];
  const startCol      = tds.indexOf(td);
  const startFieldIdx = startCol - 2; // drag-handle(0) + row-handle(1) 보정
  if (startFieldIdx < 0 || startFieldIdx >= XL_FIELDS.length) return;

  const startIdx = scheduleData.findIndex(r => r.id === parseInt(tr.dataset.id));
  if (startIdx < 0) return;

  lines.forEach((rowText, ri) => {
    const cols = rowText.split('\t');
    const idx  = startIdx + ri;

    if (idx >= scheduleData.length) {
      const user = getUser();
      scheduleData.push({ id: nextId++, lv1: '', lv2: '', content: '', link: '', manager: '', startDate: fmtDate(new Date()), endDate: fmtDate(new Date()), createdBy: user ? { id: user.id, name: user.name } : null, createdAt: new Date().toISOString() });
    }

    const row = scheduleData[idx];
    if (!canEditRow(row)) return;
    cols.forEach((val, ci) => {
      const fi = startFieldIdx + ci;
      if (fi >= XL_FIELDS.length) return;
      const field = XL_FIELDS[fi];
      row[field] = (field === 'startDate' || field === 'endDate') ? normalizeDate(val.trim()) : val.trim();
    });

    if (row.startDate && row.endDate && row.startDate > row.endDate) row.endDate = row.startDate;
  });

  saveToStorage();
  renderTable();
  markGanttDirty();
}

function normalizeDate(s) {
  if (!s) return '';
  // Strip trailing time component: "2024-05-15 00:00:00" → "2024-05-15"
  const cleaned = s.trim().replace(/^(\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2})[T \t].*$/, '$1');
  if (/^\d{8}$/.test(cleaned))
    return `${cleaned.slice(0,4)}-${cleaned.slice(4,6)}-${cleaned.slice(6)}`;
  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD (allows 1-digit month or day)
  const ymd = cleaned.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2,'0')}-${ymd[3].padStart(2,'0')}`;
  // M/D/YYYY (US format)
  const us = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return '';
}

/* ── 날짜 입력칸 붙여넣기 (단일 값) ────────────────────────── */
function handleDateInputPaste(e, id, field) {
  // xlSel이 설정된 탐색/편집 모드: handleTablePaste → xlHandlePaste에 위임
  if (xlSel) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  const trimmed = text.trim();
  // 탭이나 줄바꿈이 있으면 다중셀 붙여넣기 → handleTablePaste 에 위임
  if (trimmed.includes('\t') || /\r?\n/.test(trimmed)) return;
  e.preventDefault();
  e.stopPropagation();
  const normalized = normalizeDate(trimmed);
  e.target.value = normalized;
  updateField(id, field, normalized);
}

/* ── Drag Reorder ───────────────────────────────────────── */
document.addEventListener('mousemove', e => {
  if (!schedDrag.active) return;
  const rows = [...document.querySelectorAll('#tableBody tr.data-row')];
  let ov = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { ov = i; break; }
  }
  if (ov !== schedDrag.ovIdx) { schedDrag.ovIdx = ov; updateDragUI(); }
});

function startDragReorder(e, idx) {
  e.preventDefault(); e.stopPropagation();
  schedDrag.active = true; schedDrag.srcIdx = idx; schedDrag.ovIdx = idx;
  updateDragUI();
}
function endSchedDrag() {
  const from = schedDrag.srcIdx; let to = schedDrag.ovIdx;
  schedDrag.active = false; schedDrag.srcIdx = null; schedDrag.ovIdx = null;
  clearDragUI();
  if (from === null || to === null || from === to) return;
  if (to > from) to--;
  if (from === to) return;
  const [item] = scheduleData.splice(from, 1);
  scheduleData.splice(to, 0, item);
  saveToStorage(); renderTable(); markGanttDirty();
}
function updateDragUI() {
  const rows = [...document.querySelectorAll('#tableBody tr.data-row')];
  const { srcIdx, ovIdx } = schedDrag;
  rows.forEach((r, i) => {
    r.classList.toggle('row-dragging', i === srcIdx);
    r.classList.toggle('drop-before', i === ovIdx && i !== srcIdx && ovIdx < rows.length);
    r.classList.toggle('drop-after', false);
  });
  if (ovIdx >= rows.length && rows.length > 0) rows[rows.length - 1].classList.add('drop-after');
}
function clearDragUI() {
  document.querySelectorAll('#tableBody tr').forEach(r =>
    r.classList.remove('row-dragging', 'drop-before', 'drop-after'));
}

/* ── Excel Navigation Functions ─────────────────────────── */
function xlTd(ri, ci) {
  return document.querySelector(`#tableBody td.xl-cell[data-ri="${ri}"][data-ci="${ci}"]`);
}
function xlInp(ri, ci) { return xlTd(ri, ci)?.querySelector('input,textarea'); }

function xlClearSel() {
  if (xlEdit) xlExitEdit(true);
  if (xlSel) xlTd(xlSel.ri, xlSel.ci)?.classList.remove('xl-selected', 'xl-editing');
  if (xlRange) clearRangeHighlight();
  xlSel = null; xlEdit = false; xlRange = null; xlAnchor = null;
}

function xlSelect(ri, ci) {
  if (xlEdit) xlExitEdit(true);
  if (xlSel) xlTd(xlSel.ri, xlSel.ci)?.classList.remove('xl-selected', 'xl-editing');
  if (xlRange) { clearRangeHighlight(); xlRange = null; xlAnchor = null; }
  if (ri < 0 || ri >= scheduleData.length || ci < 0 || ci >= XL_COLS) return;
  xlSel = { ri, ci }; xlEdit = false;
  const td = xlTd(ri, ci);
  if (!td) return;
  td.classList.add('xl-selected');
  td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const _selInp = td.querySelector('input,textarea');
  (_selInp ?? td).focus({ preventScroll: true });
}

function xlEnterEdit(replaceChar, clearFirst) {
  if (!xlSel) return;
  const td  = xlTd(xlSel.ri, xlSel.ci);
  const inp = xlInp(xlSel.ri, xlSel.ci);
  if (!td || !inp) return;
  xlEdit = true;
  xlOrig = inp.value;
  td.classList.add('xl-editing');
  inp.focus({ preventScroll: true });
  if (replaceChar !== undefined) {
    inp.value = replaceChar;
    inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
  } else if (clearFirst) {
    inp.value = '';
    inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  inp.setSelectionRange(inp.value.length, inp.value.length);
}

function xlExitEdit(save) {
  if (!xlSel || !xlEdit) return;
  const td  = xlTd(xlSel.ri, xlSel.ci);
  const inp = xlInp(xlSel.ri, xlSel.ci);
  if (!save && inp) {
    inp.value = xlOrig;
    const row = scheduleData[xlSel.ri];
    const field = XL_FIELDS[xlSel.ci];
    if (row && field) { row[field] = xlOrig; saveToStorage(); }
  } else if (save) {
    xlUndo = { ri: xlSel.ri, ci: xlSel.ci, value: xlOrig };
  }
  td?.classList.remove('xl-editing');
  xlEdit = false;
  const _exitInp = td?.querySelector('input,textarea');
  (_exitInp ?? td)?.focus({ preventScroll: true });
}

function xlMove(dri, dci) {
  if (!xlSel) return;
  xlSelect(
    Math.max(0, Math.min(scheduleData.length - 1, xlSel.ri + dri)),
    Math.max(0, Math.min(XL_COLS - 1, xlSel.ci + dci))
  );
}

function xlMd(e, ri, ci) {
  if (e.button !== 0) return;
  if (!canEditRow(scheduleData[ri])) return;
  if (xlEdit && xlSel?.ri === ri && xlSel?.ci === ci) return;
  e.preventDefault();
  xlDragging = true;
  xlSelect(ri, ci);
  xlAnchor = { ri, ci }; // must be set AFTER xlSelect — xlSelect clears xlAnchor
}

function xlDbl(e, ri, ci) {
  e.preventDefault();
  if (!canEditRow(scheduleData[ri])) return;
  if (!xlEdit || xlSel?.ri !== ri || xlSel?.ci !== ci) xlSelect(ri, ci);
  xlEnterEdit();
}

function xlHandlePaste(text) {
  if (!xlSel || !text) return;
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return;
  const ri = xlSel.ri, ci = xlSel.ci; // renderTable이 xlSel을 null로 초기화하기 전에 저장
  if (!canEditRow(scheduleData[ri])) return;
  const user = getUser();
  _xlPasting = true;
  try {
    lines.forEach((rowText, r) => {
      const cols = rowText.split('\t');
      const idx  = ri + r;
      if (idx >= scheduleData.length) {
        if (scheduleData.length >= MAX_ROWS) return;
        if (collabMode === 'collab' && !user) return;
        scheduleData.push({ id: nextId++, lv1:'', lv2:'', content:'', link:'', manager:'', startDate: fmtDate(new Date()), endDate: fmtDate(new Date()), createdBy: user ? { id: user.id, name: user.name } : null, createdAt: new Date().toISOString() });
      }
      const row = scheduleData[idx];
      if (!canEditRow(row)) return;
      cols.forEach((val, c) => {
        const fi = ci + c;
        if (fi >= XL_COLS) return;
        const field = XL_FIELDS[fi];
        row[field] = (field === 'startDate' || field === 'endDate') ? normalizeDate(val.trim()) : val.trim();
      });
      if (row.startDate && row.endDate && row.startDate > row.endDate) row.endDate = row.startDate;
    });
    saveToStorage(); renderTable(); markGanttDirty();
  } finally {
    _xlPasting = false;
  }
}

/* ── Range Selection Helpers ────────────────────────────── */
function updateRangeHighlight() {
  document.querySelectorAll('#tableBody td.xl-cell').forEach(td => {
    const ri = parseInt(td.dataset.ri), ci = parseInt(td.dataset.ci);
    const inRange = xlRange && ri >= xlRange.r1 && ri <= xlRange.r2 && ci >= xlRange.c1 && ci <= xlRange.c2;
    td.classList.toggle('xl-range', inRange);
  });
}
function clearRangeHighlight() {
  document.querySelectorAll('#tableBody td.xl-range').forEach(td => td.classList.remove('xl-range'));
}

/* ── Range Keyboard Handler ─────────────────────────────── */
document.addEventListener('keydown', e => {
  if (!xlRange) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'c') {
      e.preventDefault();
      const lines = [];
      for (let r = xlRange.r1; r <= xlRange.r2; r++) {
        const cols = [];
        for (let c = xlRange.c1; c <= xlRange.c2; c++) cols.push(xlInp(r, c)?.value ?? '');
        lines.push(cols.join('\t'));
      }
      const text = lines.join('\r\n');
      const nr = xlRange.r2-xlRange.r1+1, nc = xlRange.c2-xlRange.c1+1;
      _xlCopiedText = text;
      syncCopy(text);
      showToast(`${nr}×${nc} 범위 복사됨`, 'info');
    } else if (e.key === 'v') {
      const { r1, c1 } = xlRange;
      clearRangeHighlight(); xlRange = null; xlAnchor = null;
      if (_xlCopiedText) {
        // 저장된 복사 내용이 있으면 직접 처리 (클립보드 비동기 경쟁 우회)
        e.preventDefault();
        const txt = _xlCopiedText;
        _xlCopiedText = null;
        xlSelect(r1, c1);
        xlHandlePaste(txt);
      } else {
        // 외부 소스 붙여넣기: 시작 셀로 이동 후 paste 이벤트에 위임
        xlSelect(r1, c1);
      }
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    clearRangeHighlight(); xlRange = null; xlAnchor = null;
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    for (let r = xlRange.r1; r <= xlRange.r2; r++)
      for (let c = xlRange.c1; c <= xlRange.c2; c++) {
        const inp = xlInp(r, c), id = scheduleData[r]?.id;
        if (inp && id) { inp.value = ''; updateField(id, XL_FIELDS[c], ''); }
      }
  }
});

/* XL keyboard handler */
document.addEventListener('keydown', e => {
  if (!xlSel) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'c') {
      const inp = xlInp(xlSel.ri, xlSel.ci);
      if (inp) {
        // 편집 중 텍스트 선택이 있으면 브라우저 기본 복사 허용
        if (xlEdit && inp.selectionEnd > inp.selectionStart) return;
        if (!xlEdit) {
          // 탐색 모드: input 전체 선택 후 브라우저 기본 복사에 위임 (no preventDefault)
          _xlCopiedText = inp.value; // 단일 셀 복사도 저장
          inp.select();
          showToast('셀 복사됨', 'info');
          return;
        }
        // 편집 모드, 선택 없음: Clipboard API 사용
        e.preventDefault();
        syncCopy(inp.value);
        showToast('셀 복사됨', 'info');
      }
    } else if (e.key === 'v') {
      if (xlEdit) return; // 편집 중엔 브라우저 기본 붙여넣기 허용
      // 탐색 모드: 저장된 복사 내용이 있으면 직접 처리 (클립보드 비동기 경쟁 우회)
      if (_xlCopiedText) {
        e.preventDefault();
        const txt = _xlCopiedText;
        _xlCopiedText = null;
        xlHandlePaste(txt);
        return;
      }
      // 외부 붙여넣기(엑셀 등): paste 이벤트가 handleTablePaste로 처리됨
    } else if (e.key === 'z') {
      if (!xlEdit && xlUndo) {
        e.preventDefault();
        const { ri, ci, value } = xlUndo;
        const inp = xlInp(ri, ci), id = scheduleData[ri]?.id;
        if (inp && id) {
          inp.value = value;
          updateField(id, XL_FIELDS[ci], value);
          xlSelect(ri, ci);
          showToast('되돌렸습니다', 'info');
        }
        xlUndo = null;
      }
    }
    return;
  }
  if (xlEdit) {
    if (e.key === 'Enter' && e.shiftKey && XL_FIELDS[xlSel.ci] === 'content') {
      // 줄바꿈은 textarea 기본 동작에 맡기고, oninput의 growContentCell이 행 높이를 갱신
      return;
    }
    if      (e.key === 'Escape')    { e.preventDefault(); xlExitEdit(false); }
    else if (e.key === 'Enter')     { e.preventDefault(); xlExitEdit(true); }
    else if (e.key === 'Tab')       { e.preventDefault(); xlExitEdit(true);  xlMove( 0,  e.shiftKey ? -1 : 1); }
    return;
  }
  switch (e.key) {
    case 'ArrowUp':    e.preventDefault(); xlMove(-1,  0); break;
    case 'ArrowDown':  e.preventDefault(); xlMove( 1,  0); break;
    case 'ArrowLeft':  e.preventDefault(); xlMove( 0, -1); break;
    case 'ArrowRight': e.preventDefault(); xlMove( 0,  1); break;
    case 'Tab':        e.preventDefault(); xlMove( 0,  e.shiftKey ? -1 : 1); break;
    case 'Enter': case 'F2': e.preventDefault(); xlEnterEdit(); break;
    case 'Escape':
      e.preventDefault();
      xlTd(xlSel.ri, xlSel.ci)?.classList.remove('xl-selected');
      xlSel = null;
      break;
    case 'Delete': case 'Backspace': {
      e.preventDefault();
      const inp = xlInp(xlSel.ri, xlSel.ci);
      const id  = scheduleData[xlSel.ri]?.id;
      if (inp && id) {
        xlUndo = { ri: xlSel.ri, ci: xlSel.ci, value: inp.value };
        inp.value = ''; updateField(id, XL_FIELDS[xlSel.ci], '');
      }
      break;
    }
    default:
      if (!e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === 'Process' || e.key === 'Unidentified' || e.key.length === 1) {
          // Clear cell and focus input — no preventDefault so browser/IME inserts char naturally
          xlEnterEdit(undefined, true);
        }
      }
  }
});

/* ── Global Keyboard Intercepts ─────────────────────────── */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    // XL 탐색 모드에서 셀이 선택된 경우 전체선택 차단 (input에 focus가 있어도)
    if (xlSel && !xlEdit) { e.preventDefault(); return; }
    if (!document.activeElement?.matches('input,textarea')) e.preventDefault();
  }
});

/* ── Column Resize ───────────────────────────────────────── */
function _colResizeStart(e, handleEl, onDelta) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  handleEl.classList.add('active');
  document.body.classList.add('col-resizing');
  function move(ev) { onDelta(ev.clientX - startX); }
  function up() {
    handleEl.classList.remove('active');
    document.body.classList.remove('col-resizing');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  }
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function initColResize(table) {
  table.style.width = table.offsetWidth + 'px';
  const ths = [...table.querySelectorAll('thead th')];
  ths.forEach((th, i) => {
    if (i < 2 || i === ths.length - 1) return;
    const h = document.createElement('div');
    h.className = 'col-resizer';
    th.appendChild(h);
    h.addEventListener('click', e => e.stopPropagation());
    h.addEventListener('mousedown', e => {
      const startW = th.offsetWidth;
      let prevW = startW;
      _colResizeStart(e, h, delta => {
        const newW = Math.max(50, startW + delta);
        const diff = newW - prevW;
        prevW = newW;
        th.style.width = newW + 'px';
        table.style.width = (parseInt(table.style.width) + diff) + 'px';
      });
    });
  });
}

function initGanttColResize(wrap) {
  const table = wrap.querySelector('.gantt-table');
  if (!table) return;
  const fixThs = [...table.querySelectorAll('thead th.fix-col')];
  const selMap = ['.lv1-td', '.lv2-td', '.content-td', '.mgr-td'];
  fixThs.forEach((th, ci) => {
    const h = document.createElement('div');
    h.className = 'col-resizer';
    th.appendChild(h);
    h.addEventListener('mousedown', e => {
      const startW = ganttColWidths[ci];
      _colResizeStart(e, h, delta => {
        ganttColWidths[ci] = Math.max(50, startW + delta);
        const L = ganttComputeLeft();
        fixThs.forEach((t, k) => {
          t.style.minWidth = ganttColWidths[k] + 'px';
          t.style.left = L[k] + 'px';
        });
        selMap.forEach((sel, k) => {
          table.querySelectorAll(sel).forEach(td => {
            td.style.minWidth = ganttColWidths[k] + 'px';
            td.style.left = L[k] + 'px';
            const clip = td.querySelector('.gtd-clip');
            if (clip) clip.style.width = (ganttColWidths[k] - 21) + 'px';
          });
        });
      });
    });
  });
}

/* ── 유틸 ───────────────────────────────────────────────── */
function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
