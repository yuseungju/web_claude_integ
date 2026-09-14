// ── 열 파싱 유틸 ──────────────────────────────────────────────────────────────
function parseCol(val) {
  const v = (val || 'A').trim().toUpperCase();
  if (/^\d+$/.test(v)) return Math.max(0, parseInt(v) - 1);
  let n = 0;
  for (const c of v) n = n * 26 + (c.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}
function colLabel(idx) {
  let s = '', i = idx + 1;
  while (i > 0) { s = String.fromCharCode(64 + ((i - 1) % 26 + 1)) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 페이지 데이터 존재 여부 ────────────────────────────────────────────────────
function hasPageData() {
  if (excelState.dataA || excelState.dataB) return true;
  for (const side of ['left', 'right']) {
    if (manualState[side].rows.some(r => r.some(c => String(c ?? '').trim() !== ''))) return true;
  }
  return false;
}

// ── 탭 전환 (데이터 있으면 초기화 확인) ─────────────────────────────────────────
function switchTab(tab) {
  const curTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (curTab && curTab !== tab) {
    if (curTab === 'excel' && (excelState.dataA || excelState.dataB)) {
      if (!confirm('업로드된 엑셀 데이터를 초기화하고 탭을 전환하시겠습니까?')) return;
      resetExcel();
    } else if (curTab === 'manual') {
      const hasData = ['left','right'].some(s =>
        manualState[s].rows.some(r => r.some(c => String(c ?? '').trim() !== ''))
      );
      if (hasData) {
        if (!confirm('입력된 데이터를 초기화하고 탭을 전환하시겠습니까?')) return;
        resetManualSide('left'); resetManualSide('right');
      }
    }
  }
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tabExcel').style.display  = tab === 'excel'  ? '' : 'none';
  document.getElementById('tabManual').style.display = tab === 'manual' ? '' : 'none';
}

function showStatus(elId, type, msg) {
  const bar = document.getElementById(elId);
  bar.className    = `status-bar ${type}`;
  bar.textContent  = msg;
  bar.style.display = '';
}

// ══════════════════════════════════════════════════════════════════════════════
//  탭 1: 엑셀 업로드
// ══════════════════════════════════════════════════════════════════════════════
const excelState = {
  dataA: null, nameA: '',
  dataB: null, nameB: '',
  mapA: null, mapB: null,
  rowMapA: null, rowMapB: null,
  colsA: [], colsB: [],
  filterA: false, filterB: false,
};

const dropA = new FileDropZone($('#zoneA'), $('#inputA'), { onFile: f => loadFile(f, 'A') });
const dropB = new FileDropZone($('#zoneB'), $('#inputB'), { onFile: f => loadFile(f, 'B') });

function tick() { return new Promise(r => setTimeout(r, 0)); }

function _setExcelProgress(pct) {
  const btn   = document.getElementById('excelCompareBtn');
  const bar   = document.getElementById('compareProgressBar');
  const wrap  = document.getElementById('compareProgressWrap');
  const label = document.getElementById('compareProgressLabel');
  if (pct < 0) {
    if (wrap) wrap.style.display = 'none';
    if (btn)  { btn.disabled = false; btn.textContent = '⚖️ 비교 실행'; btn.classList.remove('dirty'); }
  } else if (pct === 0) {
    if (btn)  { btn.disabled = true; btn.textContent = '⚖️ 비교 중...'; }
    if (wrap) wrap.style.display = '';
    if (bar)  bar.style.width = '0%';
  } else if (pct >= 100) {
    if (btn)   btn.textContent = '⚖️ 완료';
    if (bar)   bar.style.width = '100%';
    if (label) label.textContent = '완료';
  } else {
    if (btn)   btn.textContent = `⚖️ 비교 중... ${pct}%`;
    if (bar)   bar.style.width = pct + '%';
    if (label) label.textContent = `비교 중... ${pct}%`;
  }
}

function _updateExcelCompareBtn() {
  const btn  = document.getElementById('excelCompareBtn');
  const both = !!(excelState.dataA && excelState.dataB);
  if (btn) { btn.disabled = !both; if (both) btn.classList.add('dirty'); else btn.classList.remove('dirty'); }
}

async function loadFile(file, side) {
  try {
    const result = await ExcelReader.read(file);
    const sheet  = result.sheets[result.sheetNames[0]];
    // 빈 행(모든 셀이 비어있거나 공백)이 나오면 그 이전까지만 사용
    const firstEmpty = sheet.rows.findIndex(r => r.every(c => String(c ?? '').trim() === ''));
    if (firstEmpty >= 0) sheet.rows = sheet.rows.slice(0, firstEmpty);
    if (side === 'A') { excelState.dataA = sheet; excelState.nameA = file.name; }
    else              { excelState.dataB = sheet; excelState.nameB = file.name; }
    _updateExcelCompareBtn();
    // 파일 로드 후 읽은 행 수 표시
    const infoEl = document.getElementById(side === 'A' ? 'infoA' : 'infoB');
    if (infoEl) infoEl.innerHTML = `<span class="file-label" title="${escHtml(file.name)}">${escHtml(file.name)}</span> <span class="count-badge success">${sheet.rows.length}행</span>`;
    $('#compareSection').style.display = 'none'; // 새 파일 올리면 결과 숨김
  } catch (err) {
    showStatus('statusBar', 'error', '⚠️ ' + err.message);
  }
}

// ── 열 범위 파싱 (A:E, 1:5, A,C,E, A:C,E:G) ─────────────────────────────────
function parseColRange(str) {
  const s = str.trim().toUpperCase();
  if (!s) return [];
  const result = [];
  for (const part of s.split(',').map(p => p.trim()).filter(Boolean)) {
    // 범위: A:E, A-E, A~E, 1:5, 1-5
    const m = part.match(/^([A-Z]{1,2}|\d+)(?::|-|~)([A-Z]{1,2}|\d+)$/);
    if (m) {
      const from = parseCol(m[1]), to = parseCol(m[2]);
      const lo = Math.min(from, to), hi = Math.max(from, to);
      for (let c = lo; c <= hi; c++) result.push(c);
    } else {
      const c = parseCol(part);
      if (c >= 0) result.push(c);
    }
  }
  return [...new Set(result)]; // 중복 제거
}

// ── 모드 토글 (개별 / 범위) ────────────────────────────────────────────────────
const _colMode = { keyColA: 'multi', keyColB: 'multi' };

function setColMode(prefix, mode, btn) {
  _colMode[prefix] = mode;
  const side     = prefix.replace('keyCol', '');
  const multiEl  = document.getElementById(`colMulti${side}`);
  const rangeEl  = document.getElementById(`colRange${side}`);
  if (multiEl) multiEl.style.display = mode === 'multi' ? '' : 'none';
  if (rangeEl) rangeEl.style.display = mode === 'range'  ? '' : 'none';
  document.querySelectorAll(`[data-prefix="${prefix}"].col-mode-btn`).forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));

  // 선택되지 않은 모드의 입력값은 초기화 (표시된 모드 기준으로만 비교)
  if (mode === 'range') {
    for (let i = 1; i <= 5; i++) {
      const el = document.getElementById(`${prefix}_${i}`);
      if (el) el.value = '';
    }
  } else {
    const el = document.getElementById(`${prefix}_range`);
    if (el) el.value = '';
  }

  // dirty 표시
  if (excelState.dataA && excelState.dataB) _updateExcelCompareBtn();
}

// 엑셀 비교열 읽기 (개별 최대 5개 or 범위)
function getExcelKeyCols(prefix) {
  if (_colMode[prefix] === 'range') {
    const el = document.getElementById(`${prefix}_range`);
    if (el && el.value.trim()) {
      const cols = parseColRange(el.value);
      return cols.length ? cols : [0];
    }
    return [0];
  }
  // 개별 모드 (기존)
  const cols = [];
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById(`${prefix}_${i}`);
    if (el && el.value.trim()) cols.push(parseCol(el.value.trim()));
  }
  return cols.length ? cols : [0];
}

function buildExcelKey(row, colIdxs) {
  return colIdxs.map(ci => String(row[ci] ?? '').trim()).join('|||');
}

// 같은 키를 가진 행이 여러 개일 때, 원본 행 위치(idx)와 가장 가까운 행을 선택
function findNearestRow(rowMap, key, idx) {
  const candidates = rowMap.get(key);
  if (!candidates || !candidates.length) return null;
  let best = candidates[0];
  let bestDist = Math.abs(best.idx - idx);
  for (let i = 1; i < candidates.length; i++) {
    const dist = Math.abs(candidates[i].idx - idx);
    if (dist < bestDist) { best = candidates[i]; bestDist = dist; }
  }
  return best.row;
}

async function runCompare() {
  if (!excelState.dataA || !excelState.dataB) return;
  _setExcelProgress(0);
  try {
    await tick();
    const { dataA, dataB, nameA, nameB } = excelState;
    const colsA = getExcelKeyCols('keyColA');
    const colsB = getExcelKeyCols('keyColB');

    if (colsA.length !== colsB.length) {
      showStatus('statusBar', 'error', `⚠️ 왼쪽 비교열 ${colsA.length}개 / 오른쪽 ${colsB.length}개 — 수가 같아야 합니다.`);
      _setExcelProgress(-1);
      return;
    }

    const keyA = r => buildExcelKey(r, colsA);
    const keyB = r => buildExcelKey(r, colsB);

    // mapA — 진행률 0~40%
    const mapA = new Map();
    const rowMapA = new Map();
    const chunkA = Math.max(500, Math.ceil(dataA.rows.length / 20));
    for (let i = 0; i < dataA.rows.length; i++) {
      const k = keyA(dataA.rows[i]); mapA.set(k, (mapA.get(k) || 0) + 1);
      if (!rowMapA.has(k)) rowMapA.set(k, []);
      rowMapA.get(k).push({ idx: i, row: dataA.rows[i] });
      if (i % chunkA === 0) { _setExcelProgress(Math.round(i / dataA.rows.length * 40)); await tick(); }
    }

    // mapB — 진행률 40~80%
    const mapB = new Map();
    const rowMapB = new Map();
    const chunkB = Math.max(500, Math.ceil(dataB.rows.length / 20));
    for (let i = 0; i < dataB.rows.length; i++) {
      const k = keyB(dataB.rows[i]); mapB.set(k, (mapB.get(k) || 0) + 1);
      if (!rowMapB.has(k)) rowMapB.set(k, []);
      rowMapB.get(k).push({ idx: i, row: dataB.rows[i] });
      if (i % chunkB === 0) { _setExcelProgress(40 + Math.round(i / dataB.rows.length * 40)); await tick(); }
    }

    _setExcelProgress(90); await tick();

    excelState.mapA = mapA; excelState.mapB = mapB;
    excelState.rowMapA = rowMapA; excelState.rowMapB = rowMapB;
    excelState.colsA = colsA; excelState.colsB = colsB;
    excelState.filterA = false; excelState.filterB = false;

    const missingInB = dataA.rows.filter(r => !mapB.has(keyA(r))).length;
    const missingInA = dataB.rows.filter(r => !mapA.has(keyB(r))).length;
    const lblA = colsA.map(ci => colLabel(ci)).join('+');
    const lblB = colsB.map(ci => colLabel(ci)).join('+');

    _setExcelProgress(100);

    if (missingInB === 0 && missingInA === 0) {
      showStatus('statusBar', 'success', `✅ 완료 — 모두 일치합니다. (${lblA}열 ↔ ${lblB}열)`);
    } else {
      showStatus('statusBar', 'info', `불일치 — 왼쪽에만 ${missingInB}건 / 오른쪽에만 ${missingInA}건 (${lblA}열 ↔ ${lblB}열)`);
    }

    $('#infoA').innerHTML = buildBadgeHtml(nameA, missingInB, dataA.rows.length);
    $('#infoB').innerHTML = buildBadgeHtml(nameB, missingInA, dataB.rows.length);
    $('#compareSection').style.display = '';
    document.getElementById('resetBtn').style.display = '';

    // 비교 결과 미리보기 (상위 50행)
    renderPreview('A');
    document.getElementById('cmpPreviewWrap').style.display = '';
    document.getElementById('tabPrevA').classList.add('active');
    document.getElementById('tabPrevB').classList.remove('active');

  } catch(err) {
    showStatus('statusBar', 'error', '⚠️ 비교 중 오류: ' + err.message);
  } finally {
    setTimeout(() => _setExcelProgress(-1), 700);
  }
}

// 엑셀 표 렌더 (필터·일치건수 포함)
function renderExcelTable(side) {
  const isA    = side === 'A';
  const data   = isA ? excelState.dataA  : excelState.dataB;
  const myCols = isA ? excelState.colsA  : excelState.colsB;
  const othMap = isA ? excelState.mapB   : excelState.mapA;
  const filter = isA ? excelState.filterA : excelState.filterB;
  const wrap   = document.getElementById(isA ? 'tableA' : 'tableB');
  if (!data || !othMap) return;

  const keyFn = r => buildExcelKey(r, myCols);
  let   rows  = data.rows;
  if (filter) rows = rows.filter(r => !othMap.has(keyFn(r)));

  const hCells = (data.headers || []).map(h => `<th>${escHtml(h)}</th>`).join('');
  const bRows  = rows.map((row, idx) => {
    const cnt      = othMap.get(keyFn(row)) ?? 0;
    const rowClass = cnt > 0 ? 'row-match' : 'row-missing';
    const cells    = row.map(cell => `<td>${escHtml(String(cell ?? ''))}</td>`).join('');
    return `<tr class="${rowClass}" onmouseenter="continueExcelRowSelect(event,'${side}',${idx})">
      <td class="drag-handle" onmousedown="startExcelDragReorder(event,'${side}',${idx})">⠿</td>
      <td class="row-handle" onmousedown="startExcelRowSelect(event,'${side}',${idx})">${idx + 1}</td>
      ${cells}
      <td class="status-cell${cnt > 0 ? ' true' : ' false'}">${cnt}</td></tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th class="drag-handle-th"></th><th class="row-handle-th"></th>${hCells}<th class="status-th">일치건수</th></tr></thead>
      <tbody>${bRows}</tbody>
    </table>`;
  updateExcelRowHighlights(side);
}

// 엑셀 탭 불일치 필터 토글
function toggleExcelFilter(side) {
  const isA = side === 'A';
  if (isA) excelState.filterA = !excelState.filterA;
  else     excelState.filterB = !excelState.filterB;
  const btn = document.getElementById(`excelFilterBtn_${side}`);
  if (btn) btn.classList.toggle('active', isA ? excelState.filterA : excelState.filterB);
  renderExcelTable(side);
}

// 엑셀 탭 다운로드 (일치건수 맨 왼쪽, 원본 헤더·행 단위 색상 · 셀 직접 생성)
function downloadExcelTable(side) {
  const isA       = side === 'A';
  const data      = isA ? excelState.dataA  : excelState.dataB;
  const myCols    = isA ? excelState.colsA  : excelState.colsB;
  const othMap    = isA ? excelState.mapB   : excelState.mapA;
  const othRowMap = isA ? excelState.rowMapB : excelState.rowMapA;
  const filter    = isA ? excelState.filterA : excelState.filterB;
  if (!data || !othMap) return;

  const keyFn      = r => buildExcelKey(r, myCols);
  let   rows       = data.rows.map((row, idx) => ({ row, idx }));
  if (filter) rows = rows.filter(({ row }) => !othMap.has(keyFn(row)));

  const origHeaders = data.headers || [];
  const COLS        = origHeaders.length + 1;
  const ROWS        = rows.length + 1;

  const FILL_BLUE = { patternType: 'solid', fgColor: { rgb: 'DBEAFE' } };
  const FILL_RED  = { patternType: 'solid', fgColor: { rgb: 'FEE2E2' } };
  const FILL_HDR  = { patternType: 'solid', fgColor: { rgb: 'FFF9C4' } };
  const FILL_DIFF = { patternType: 'solid', fgColor: { rgb: 'FCA5A5' } };
  const FONT_BOLD = { bold: true };
  const FONT_BLUE = { bold: true, color: { rgb: '1E3A8A' } };
  const FONT_RED  = { bold: true, color: { rgb: '991B1B' } };
  const ALIGN_C   = { horizontal: 'center' };

  const sc = (r, c, v, s) => {
    const ref = XLSX.utils.encode_cell({ r, c });
    const t   = typeof v === 'number' ? 'n' : 's';
    ws[ref]   = s ? { v: v ?? '', t, s } : { v: v ?? '', t };
  };

  const ws = {};
  ws['!ref']  = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: ROWS - 1, c: COLS - 1 } });
  ws['!cols'] = [{ wch: 8 }, ...origHeaders.map(() => ({ wch: 14 }))];

  // 헤더 행: 일치건수(노랑) + 원본 헤더
  sc(0, 0, '일치건수', { fill: FILL_HDR, font: FONT_BOLD, alignment: ALIGN_C });
  origHeaders.forEach((h, i) => sc(0, i + 1, h, { font: FONT_BOLD }));

  // 데이터 행
  rows.forEach(({ row, idx }, ri) => {
    const r        = ri + 1;
    const cnt      = othMap.get(keyFn(row)) ?? 0;
    const fill     = cnt > 0 ? FILL_BLUE : FILL_RED;
    const otherRow = cnt > 0 ? findNearestRow(othRowMap, keyFn(row), idx) : null;
    sc(r, 0, cnt, { fill, font: cnt > 0 ? FONT_BLUE : FONT_RED, alignment: ALIGN_C });
    row.forEach((v, i) => {
      const isDiff = otherRow && String(v ?? '') !== String(otherRow[i] ?? '');
      sc(r, i + 1, v, isDiff ? { fill: FILL_DIFF, font: FONT_RED } : { fill });
    });
  });

  const srcName = (isA ? excelState.nameA : excelState.nameB).replace(/\.[^.]+$/, '');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, `${srcName}_비교결과.xlsx`);
}

// ── 비교 결과 미리보기 ────────────────────────────────────────────────────────
function showPreview(side) {
  document.getElementById('tabPrevA').classList.toggle('active', side === 'A');
  document.getElementById('tabPrevB').classList.toggle('active', side === 'B');
  renderPreview(side);
}

function renderPreview(side) {
  const isA       = side === 'A';
  const data      = isA ? excelState.dataA  : excelState.dataB;
  const myCols    = isA ? excelState.colsA  : excelState.colsB;
  const othMap    = isA ? excelState.mapB   : excelState.mapA;
  const othRowMap = isA ? excelState.rowMapB : excelState.rowMapA;
  const wrap      = document.getElementById('cmpPreviewTable');
  if (!data || !othMap) return;

  const keyFn  = r => buildExcelKey(r, myCols);
  const keySet = new Set(myCols);
  const PREVIEW = 200;
  const rows    = data.rows.slice(0, PREVIEW);
  const headers = data.headers || [];

  const hCells = headers.map((h, hi) =>
    `<th${keySet.has(hi) ? ' class="preview-key-col"' : ''}>${escHtml(h)}</th>`
  ).join('');

  const bRows = rows.map((row, idx) => {
    const cnt      = othMap.get(keyFn(row)) ?? 0;
    const isMatch  = cnt > 0;
    const otherRow = isMatch ? findNearestRow(othRowMap, keyFn(row), idx) : null;
    const cells = row.map((c, ci) => {
      const isKey  = keySet.has(ci);
      const isDiff = otherRow && String(c ?? '') !== String(otherRow[ci] ?? '');
      let cls = '';
      if (isKey) {
        cls = isMatch ? 'preview-key-match' : 'preview-key-miss';
      } else if (isDiff) {
        cls = 'cell-diff';
      }
      return `<td${cls ? ` class="${cls}"` : ''}>${escHtml(String(c ?? ''))}</td>`;
    }).join('');
    return `<tr>
      <td class="status-cell${isMatch?' true':' false'}" style="width:44px;text-align:center;font-weight:700">${cnt}</td>
      ${cells}
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="data-table" style="font-size:0.78rem">
    <thead><tr>
      <th class="status-th" style="width:44px">일치건수</th>${hCells}
    </tr></thead>
    <tbody>${bRows}</tbody>
  </table>`;
}

function buildBadgeHtml(name, missing, total) {
  const matched = total != null ? total - missing : null;
  let html = `<span class="file-label" title="${escHtml(name)}">${escHtml(name)}</span>`;
  if (total   != null) html += ` <span class="count-badge" style="background:#f1f5f9;color:#475569">${total}행</span>`;
  if (matched != null) html += ` <span class="count-badge success">일치 ${matched}건</span>`;
  if (missing  >    0) html += ` <span class="count-badge danger">불일치 ${missing}건</span>`;
  return html;
}

function resetExcel() {
  excelState.dataA = excelState.dataB = null;
  excelState.nameA = excelState.nameB = '';
  excelState.mapA  = excelState.mapB  = null;
  excelState.rowMapA = excelState.rowMapB = null;
  excelState.colsA = excelState.colsB = [];
  excelState.filterA = excelState.filterB = false;
  excelSelection.A.rows.clear(); excelSelection.A.anchor = null;
  excelSelection.B.rows.clear(); excelSelection.B.anchor = null;
  dropA.reset(); dropB.reset();
  ['excelFilterBtn_A','excelFilterBtn_B'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.classList.remove('active');
  });
  _setExcelProgress(-1);
  document.getElementById('resetBtn').style.display       = 'none';
  document.getElementById('statusBar').style.display      = 'none';
  document.getElementById('compareSection').style.display = 'none';
  const pw = document.getElementById('cmpPreviewWrap');
  if (pw) pw.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════════════════════
//  탭 2: 직접 입력
// ══════════════════════════════════════════════════════════════════════════════
const MANUAL_COLS     = 6;
const MANUAL_MAX_ROWS = 3000;
const DEFAULT_HEADERS = ['열1', '열2', '열3', '열4', '열5', '열6'];

function newEmptyRow() { return Array(MANUAL_COLS).fill(''); }
function newManualSide() {
  return {
    headers:        [...DEFAULT_HEADERS],
    rows:           [newEmptyRow()],
    keyCols:        [0, 1],
    lastOtherMap:    null,
    lastOtherRowMap: null,
    filterMismatch: false,
    filterMatch:    false,
  };
}

const manualState = { left: newManualSide(), right: newManualSide() };

// ── 행 선택 상태 ─────────────────────────────────────────────────────────────
const manualSelection = {
  left:  { rows: new Set(), dragging: false, anchor: null },
  right: { rows: new Set(), dragging: false, anchor: null },
};
const excelSelection = {
  A: { rows: new Set(), dragging: false, anchor: null },
  B: { rows: new Set(), dragging: false, anchor: null },
};

const manualDragState = {
  left:  { active: false, srcIdx: null, ovIdx: null },
  right: { active: false, srcIdx: null, ovIdx: null },
};

const manualColWidths = {
  left:  [110, 110, 110, 110, 110, 110],
  right: [110, 110, 110, 110, 110, 110],
};

// ── 셀 범위 선택 (드래그 복사) ────────────────────────────────────────────────
const mcsSel   = { left: null, right: null }; // { r1,c1,r2,c2 } display 좌표
const mcsState = { active: false, side: null, anchorR: -1, anchorC: -1 };
let   _compareDirty = false;

function mcsStart(e, side, dri, ci) {
  if (e.button !== 0) return;
  mcsClear('left'); mcsClear('right');
  mcsState.active = true; mcsState.side = side;
  mcsState.anchorR = dri; mcsState.anchorC = ci;
}
function mcsExtend(e, side, dri, ci) {
  if (!mcsState.active || !(e.buttons & 1) || mcsState.side !== side) return;
  const r1 = Math.min(mcsState.anchorR, dri), r2 = Math.max(mcsState.anchorR, dri);
  const c1 = Math.min(mcsState.anchorC, ci),   c2 = Math.max(mcsState.anchorC, ci);
  if (r2 > r1 || c2 > c1) { mcsSel[side] = { r1, c1, r2, c2 }; mcsUpdateUI(side); }
}
function mcsClear(side) { mcsSel[side] = null; mcsUpdateUI(side); }
function mcsUpdateUI(side) {
  const wrap = document.getElementById(side === 'left' ? 'manualLeft' : 'manualRight');
  const rng  = mcsSel[side];
  wrap?.querySelectorAll('td[data-dri]').forEach(td => {
    const inRange = rng && +td.dataset.dri >= rng.r1 && +td.dataset.dri <= rng.r2
                        && +td.dataset.dci >= rng.c1 && +td.dataset.dci <= rng.c2;
    td.classList.toggle('cell-range', !!inRange);
  });
}
function markCompareDirty() {
  if (_compareDirty) return;
  _compareDirty = true;
  document.getElementById('manualCompareBtn')?.classList.add('dirty');
}
function clearCompareDirty() {
  _compareDirty = false;
  document.getElementById('manualCompareBtn')?.classList.remove('dirty');
}
const excelDragState = {
  A: { active: false, srcIdx: null, ovIdx: null },
  B: { active: false, srcIdx: null, ovIdx: null },
};

function buildCompositeKey(row, keyCols) {
  return keyCols.map(c => String(row[c] ?? '').trim()).join('|||');
}
function isKeyEmpty(row, keyCols) {
  return keyCols.every(c => !String(row[c] ?? '').trim());
}

// 필터 적용 후 표시될 행 목록 (원본 인덱스 ri 포함)
function getDisplayRows(side) {
  const st = manualState[side];
  let rows = st.rows.map((row, ri) => ({ row, ri }));
  if (st.filterMismatch && st.lastOtherMap !== null) {
    rows = rows.filter(({ row }) =>
      !isKeyEmpty(row, st.keyCols) && !st.lastOtherMap.has(buildCompositeKey(row, st.keyCols))
    );
  } else if (st.filterMatch && st.lastOtherMap !== null) {
    rows = rows.filter(({ row }) =>
      !isKeyEmpty(row, st.keyCols) && st.lastOtherMap.has(buildCompositeKey(row, st.keyCols))
    );
  }
  return rows;
}

// ── 직접입력 테이블 렌더 ─────────────────────────────────────────────────────
function renderManualTable(side, otherMap = null, otherRowMap = null) {
  const st = manualState[side];
  if (otherMap !== null) st.lastOtherMap = otherMap;
  if (otherRowMap !== null) st.lastOtherRowMap = otherRowMap;
  const effectiveMap    = st.lastOtherMap;
  const effectiveRowMap = st.lastOtherRowMap;
  const hasComparison = effectiveMap !== null;
  const wrap = document.getElementById(side === 'left' ? 'manualLeft' : 'manualRight');
  const displayRows   = getDisplayRows(side);

  // 헤더: 열이름(편집 가능) + 아래 영역(클릭=비교열 선택) + 리사이즈 핸들
  const hCells = st.headers.map((h, i) => {
    const keyNum = st.keyCols.indexOf(i);
    const isKey  = keyNum >= 0;
    const w = manualColWidths[side][i];
    return `<th class="manual-th${isKey ? ' key-col' : ''}" style="width:${w}px">
      <div class="th-name-area">
        <input class="manual-hdr-inp" type="text" value="${escHtml(h)}" placeholder="열${i + 1}"
               oninput="updateManualHeader('${side}',${i},this.value)">
      </div>
      <div class="th-key-area${isKey ? ' active' : ''}" onclick="toggleKeyCol('${side}',${i})">
        ${isKey ? `▶ ${keyNum + 1}순위 선택됨` : '+ 비교열 선택'}
      </div>
      <div class="col-resize-handle" onmousedown="startManualColResize(event,'${side}',${i})"></div>
    </th>`;
  }).join('');

  const statusHeader = hasComparison
    ? `<th class="manual-th status-th" style="width:52px">일치건수</th>` : '';

  // 바디
  const bRows = displayRows.map(({ row, ri }, displayIdx) => {
    let rowClass = '', matchVal = '', diffCols = null;
    if (hasComparison && !isKeyEmpty(row, st.keyCols)) {
      const key = buildCompositeKey(row, st.keyCols);
      const cnt = effectiveMap.get(key) ?? 0;
      rowClass  = cnt > 0 ? 'row-match' : 'row-missing';
      matchVal  = String(cnt);
      if (cnt > 0 && effectiveRowMap) {
        const otherRow = findNearestRow(effectiveRowMap, key, ri);
        if (otherRow) {
          diffCols = new Set();
          row.forEach((v, ci) => {
            if (String(v ?? '') !== String(otherRow[ci] ?? '')) diffCols.add(ci);
          });
        }
      }
    }
    const cells = row.map((cell, ci) => {
      const cls = [
        st.keyCols.includes(ci) ? 'key-col' : '',
        diffCols && diffCols.has(ci) ? 'cell-diff' : '',
      ].filter(Boolean).join(' ');
      return `
      <td class="${cls}" data-dri="${displayIdx}" data-dci="${ci}"
          onmousedown="mcsStart(event,'${side}',${displayIdx},${ci})"
          onmouseenter="mcsExtend(event,'${side}',${displayIdx},${ci})">
        <input type="text" value="${escHtml(cell)}"
               oninput="updateManualCell('${side}',${ri},${ci},this.value)">
      </td>`;
    }).join('');
    const statusCell = hasComparison
      ? `<td class="status-cell${matchVal !== '' ? (matchVal !== '0' ? ' true' : ' false') : ''}">${matchVal}</td>`
      : '';
    return `<tr class="${rowClass}" data-ri="${ri}" onmouseenter="continueManualRowSelect(event,'${side}',${ri})">
      <td class="drag-handle" onmousedown="startManualDragReorder(event,'${side}',${displayIdx})">⠿</td>
      <td class="row-handle" onmousedown="startManualRowSelect(event,'${side}',${ri})">${displayIdx + 1}</td>
      ${cells}${statusCell}
      <td class="del-col">
        <button class="btn-del-row" onclick="deleteManualRow('${side}',${ri})">✕</button>
      </td></tr>`;
  }).join('');

  mcsSel[side] = null; // 재렌더 시 범위 초기화
  const colgroup = `<colgroup>
      <col style="width:26px"><col style="width:36px">
      ${st.headers.map((_, i) => `<col style="width:${manualColWidths[side][i]}px">`).join('')}
      ${hasComparison ? '<col style="width:52px">' : ''}
      <col style="width:32px">
    </colgroup>`;
  wrap.innerHTML = `
    <table class="data-table manual-table">
      ${colgroup}
      <thead><tr><th class="drag-handle-th"></th><th class="row-handle-th"></th>${hCells}${statusHeader}<th class="del-col"></th></tr></thead>
      <tbody>${bRows}</tbody>
    </table>`;
  updateManualRowHighlights(side);
}

// ── 엑셀 다운로드 (일치건수 맨 왼쪽 · 행 단위 색상 · 셀 직접 생성) ─────────────
function downloadManualTable(side) {
  const st              = manualState[side];
  const effectiveMap    = st.lastOtherMap;
  const effectiveRowMap = st.lastOtherRowMap;
  const displayRows  = getDisplayRows(side);
  const withStatus   = effectiveMap !== null;
  const origHeaders  = st.headers;
  const DCOLS        = origHeaders.length;
  const COLS         = withStatus ? DCOLS + 1 : DCOLS;
  const ROWS         = displayRows.length + 1;

  const FILL_BLUE = { patternType: 'solid', fgColor: { rgb: 'DBEAFE' } };
  const FILL_RED  = { patternType: 'solid', fgColor: { rgb: 'FEE2E2' } };
  const FILL_HDR  = { patternType: 'solid', fgColor: { rgb: 'FFF9C4' } };
  const FILL_DIFF = { patternType: 'solid', fgColor: { rgb: 'FCA5A5' } };
  const FONT_BOLD = { bold: true };
  const FONT_BLUE = { bold: true, color: { rgb: '1E3A8A' } };
  const FONT_RED  = { bold: true, color: { rgb: '991B1B' } };
  const ALIGN_C   = { horizontal: 'center' };

  const ws = {};
  ws['!ref']  = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: ROWS - 1, c: COLS - 1 } });
  ws['!cols'] = withStatus
    ? [{ wch: 8 }, ...origHeaders.map(() => ({ wch: 14 }))]
    : origHeaders.map(() => ({ wch: 14 }));

  const sc = (r, c, v, s) => {
    const ref = XLSX.utils.encode_cell({ r, c });
    ws[ref] = s ? { v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s } : { v: v ?? '', t: typeof v === 'number' ? 'n' : 's' };
  };

  if (withStatus) {
    // 헤더: 일치건수(노랑) + 원본 헤더
    sc(0, 0, '일치건수', { fill: FILL_HDR, font: FONT_BOLD, alignment: ALIGN_C });
    origHeaders.forEach((h, i) => sc(0, i + 1, h, { font: FONT_BOLD }));

    displayRows.forEach(({ row, ri: origRi }, di) => {
      const r    = di + 1;
      const key  = isKeyEmpty(row, st.keyCols) ? null : buildCompositeKey(row, st.keyCols);
      const cnt  = key !== null ? (effectiveMap.get(key) ?? 0) : 0;
      const fill = cnt > 0 ? FILL_BLUE : FILL_RED;
      const otherRow = (cnt > 0 && effectiveRowMap) ? findNearestRow(effectiveRowMap, key, origRi) : null;
      sc(r, 0, cnt, { fill, font: cnt > 0 ? FONT_BLUE : FONT_RED, alignment: ALIGN_C });
      row.forEach((v, i) => {
        const isDiff = otherRow && String(v ?? '') !== String(otherRow[i] ?? '');
        sc(r, i + 1, v, isDiff ? { fill: FILL_DIFF, font: FONT_RED } : { fill });
      });
    });
  } else {
    origHeaders.forEach((h, i) => sc(0, i, h, { font: FONT_BOLD }));
    displayRows.forEach(({ row }, ri) => row.forEach((v, i) => sc(ri + 1, i, v, null)));
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, `표비교_${side === 'left' ? '왼쪽' : '오른쪽'}.xlsx`);
}

// ── 필터 토글 (mismatch: 불일치만 / match: 일치만) — 둘은 상호 배타적 ────────
function toggleFilter(side, type = 'mismatch') {
  const st = manualState[side];
  if (type === 'mismatch') {
    st.filterMismatch = !st.filterMismatch;
    if (st.filterMismatch) st.filterMatch = false;
  } else {
    st.filterMatch = !st.filterMatch;
    if (st.filterMatch) st.filterMismatch = false;
  }
  const mismatchBtn = document.getElementById(`filterBtn_${side}`);
  const matchBtn    = document.getElementById(`filterMatchBtn_${side}`);
  if (mismatchBtn) mismatchBtn.classList.toggle('active', st.filterMismatch);
  if (matchBtn)    matchBtn.classList.toggle('active',    st.filterMatch);
  renderManualTable(side);
}

// ── 열 너비 드래그 리사이즈 ──────────────────────────────────────────────────
function startManualColResize(e, side, ci) {
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  const th     = handle.closest('th');
  const wrap   = document.getElementById(side === 'left' ? 'manualLeft' : 'manualRight');
  const col    = wrap?.querySelector(`colgroup col:nth-child(${ci + 3})`);
  const startX = e.clientX;
  const startW = th.offsetWidth;
  handle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  const onMove = mv => {
    const newW = Math.max(50, startW + mv.clientX - startX);
    manualColWidths[side][ci] = newW;
    if (col) col.style.width = newW + 'px';
    th.style.width = newW + 'px';
  };
  const onUp = () => {
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ── 비교열 토글 (클릭 순서대로 순위, 0개 허용) ──────────────────────────────
function toggleKeyCol(side, idx) {
  const st  = manualState[side];
  const pos = st.keyCols.indexOf(idx);
  if (pos >= 0) {
    st.keyCols.splice(pos, 1);   // 항상 해제 가능 (0개도 허용)
  } else {
    st.keyCols.push(idx);        // 클릭 순서대로 추가 (정렬 안함)
  }
  renderManualTable(side);
}

function updateManualHeader(side, idx, val) { manualState[side].headers[idx] = val; }
function updateManualCell(side, ri, ci, val) {
  manualState[side].rows[ri][ci] = val;
  mcsClear(side);
  markCompareDirty();
}

function addManualRow(side) {
  const st = manualState[side];
  if (st.rows.length >= MANUAL_MAX_ROWS) return;
  const sel = manualSelection[side];
  const disp = getDisplayRows(side);
  const selDisp = disp.filter(d => sel.rows.has(d.ri));
  if (selDisp.length > 0) {
    const lastRi = Math.max(...selDisp.map(d => d.ri));
    st.rows.splice(lastRi + 1, 0, newEmptyRow());
  } else {
    st.rows.push(newEmptyRow());
  }
  markCompareDirty();
  renderManualTable(side);
}

function deleteManualRow(side, ri) {
  if (manualState[side].rows.length <= 1) return;
  manualState[side].rows.splice(ri, 1);
  markCompareDirty();
  renderManualTable(side);
}

// ── 비교 실행 ─────────────────────────────────────────────────────────────────
function runManualCompare() {
  const L = manualState.left, R = manualState.right;

  if (L.keyCols.length === 0 || R.keyCols.length === 0) {
    showStatus('manualStatus', 'error', '⚠️ 비교열을 한 개 이상 선택해주세요. (열 이름 아래 영역 클릭)');
    return;
  }
  if (L.keyCols.length !== R.keyCols.length) {
    showStatus('manualStatus', 'error',
      `⚠️ 양쪽 선택 열 수가 달라요. 왼쪽 ${L.keyCols.length}개 / 오른쪽 ${R.keyCols.length}개`);
    return;
  }

  // 키별 출현 횟수 Map (일치건수 표시용) + 키별 행 목록 Map (셀 단위 비교용)
  const mapL = new Map(), mapR = new Map();
  const rowMapL = new Map(), rowMapR = new Map();
  L.rows.forEach((r, idx) => {
    if (!isKeyEmpty(r, L.keyCols)) {
      const k = buildCompositeKey(r, L.keyCols);
      mapL.set(k, (mapL.get(k) || 0) + 1);
      if (!rowMapL.has(k)) rowMapL.set(k, []);
      rowMapL.get(k).push({ idx, row: r });
    }
  });
  R.rows.forEach((r, idx) => {
    if (!isKeyEmpty(r, R.keyCols)) {
      const k = buildCompositeKey(r, R.keyCols);
      mapR.set(k, (mapR.get(k) || 0) + 1);
      if (!rowMapR.has(k)) rowMapR.set(k, []);
      rowMapR.get(k).push({ idx, row: r });
    }
  });

  renderManualTable('left',  mapR, rowMapR);
  renderManualTable('right', mapL, rowMapL);

  const matchL = L.rows.filter(r => !isKeyEmpty(r, L.keyCols) &&  mapR.has(buildCompositeKey(r, L.keyCols))).length;
  const missL  = L.rows.filter(r => !isKeyEmpty(r, L.keyCols) && !mapR.has(buildCompositeKey(r, L.keyCols))).length;
  const missR  = R.rows.filter(r => !isKeyEmpty(r, R.keyCols) && !mapL.has(buildCompositeKey(r, R.keyCols))).length;

  const lblL = L.keyCols.map(c => L.headers[c] || `열${c+1}`).join('+');
  const lblR = R.keyCols.map(c => R.headers[c] || `열${c+1}`).join('+');

  showStatus('manualStatus', missL + missR === 0 ? 'success' : 'info',
    `일치 ${matchL}건 (파란색) · 왼쪽만 ${missL}건 · 오른쪽만 ${missR}건 (빨간색)  [${lblL} ↔ ${lblR}]`);
  clearCompareDirty();
}

function resetManualSide(side) {
  manualState[side] = newManualSide();
  manualSelection[side].rows.clear();
  manualSelection[side].anchor = null;
  document.getElementById('manualStatus').style.display = 'none';
  document.getElementById(`filterBtn_${side}`)?.classList.remove('active');
  document.getElementById(`filterMatchBtn_${side}`)?.classList.remove('active');
  mcsClear(side);
  clearCompareDirty();
  renderManualTable(side);
}

// ── 붙여넣기 (동적 행 확장) ───────────────────────────────────────────────────
function handleManualPaste(e, side) {
  const td = e.target?.closest('td');
  const tr = e.target?.closest('tr');
  if (!td || !tr || tr.closest('thead')) return;

  const clip = e.clipboardData?.getData('text/plain');
  if (!clip) return;
  e.preventDefault();

  const pasteRows   = clip.split(/\r?\n/).filter(r => r !== '');
  const startRowIdx = parseInt(tr.dataset.ri ?? '0');
  const allTds      = [...tr.querySelectorAll('td')];
  const startCol    = allTds.indexOf(td) - 2;  // drag-handle(0) + row-handle(1) 보정
  if (startCol < 0 || startCol >= MANUAL_COLS) return;

  const st = manualState[side];

  pasteRows.forEach((rowText, ri) => {
    const cols   = rowText.split('\t');
    const rowIdx = startRowIdx + ri;
    if (rowIdx >= MANUAL_MAX_ROWS) return;
    while (rowIdx >= st.rows.length) st.rows.push(newEmptyRow());
    cols.forEach((val, ci) => {
      const fi = startCol + ci;
      if (fi < MANUAL_COLS) st.rows[rowIdx][fi] = val.trim();
    });
  });

  if (st.rows.length >= MANUAL_MAX_ROWS)
    showStatus('manualStatus', 'info', `ℹ️ 최대 ${MANUAL_MAX_ROWS}행까지 지원합니다.`);

  renderManualTable(side);
}

// ── 초기화 ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  switchTab('manual');
  renderManualTable('left');
  renderManualTable('right');
  document.getElementById('manualLeft').addEventListener('paste',  e => handleManualPaste(e, 'left'));
  document.getElementById('manualRight').addEventListener('paste', e => handleManualPaste(e, 'right'));

  // 열 입력 — 알파벳 자동 대문자 변환
  document.querySelectorAll('.col-key-inp, .col-range-inp').forEach(inp => {
    inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase(); });
  });

  // 동일 파일명 재업로드 허용 — 클릭 시 value 초기화로 change 이벤트 재발생
  ['inputA', 'inputB'].forEach(id => {
    const inp = document.getElementById(id);
    if (inp) inp.addEventListener('click', () => { inp.value = ''; });
  });

  // 페이지 이탈 시 데이터 손실 경고 (로고·뒤로가기 버튼·브라우저 뒤로가기)
  document.querySelectorAll('a.header-logo, a.back-btn').forEach(a => {
    a.addEventListener('click', e => {
      if (hasPageData() && !confirm('데이터가 초기화됩니다. 페이지를 이동하시겠습니까?')) {
        e.preventDefault();
      }
    });
  });
  window.addEventListener('beforeunload', e => {
    if (hasPageData()) { e.preventDefault(); e.returnValue = ''; }
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { mcsClear('left'); mcsClear('right'); return; }
  if (!(e.ctrlKey || e.metaKey) || e.key !== 'c') return;
  const active = document.activeElement;
  if (active?.matches('input,textarea') && (active.selectionEnd - active.selectionStart) > 0) return;
  if (window.getSelection?.()?.toString().length > 0) return;

  // 셀 범위 복사 (드래그 선택)
  for (const side of ['left', 'right']) {
    if (mcsSel[side]) {
      e.preventDefault();
      const { r1, c1, r2, c2 } = mcsSel[side];
      const disp = getDisplayRows(side);
      const lines = [];
      for (let dr = r1; dr <= r2; dr++) {
        if (dr >= disp.length) continue;
        const { row } = disp[dr];
        const cols = [];
        for (let dc = c1; dc <= c2; dc++) cols.push(String(row[dc] ?? ''));
        lines.push(cols.join('\t'));
      }
      doCompareClipboard(lines.join('\r\n'), `${r2-r1+1}×${c2-c1+1} 범위 복사됨`);
      return;
    }
  }

  // 수기입력 테이블 데이터 셀에 포커스된 경우 셀 값 복사
  if (active?.matches('input') && active.closest('#manualLeft tbody, #manualRight tbody')) {
    e.preventDefault();
    doCompareClipboard(active.value, '셀 복사됨');
    return;
  }
  const inManual = document.getElementById('tabManual').style.display !== 'none';
  if (inManual) {
    for (const side of ['left', 'right']) {
      if (manualSelection[side].rows.size > 0) { e.preventDefault(); copyManualRows(side); return; }
    }
  } else {
    for (const side of ['A', 'B']) {
      if (excelSelection[side].rows.size > 0) { e.preventDefault(); copyExcelRows(side); return; }
    }
  }
});

// ── 행 선택 함수 (직접입력) ───────────────────────────────────────────────────
function startManualRowSelect(e, side, ri) {
  e.preventDefault();
  const sel = manualSelection[side];
  sel.dragging = true;
  if (e.shiftKey && sel.anchor !== null) {
    selectManualRange(side, sel.anchor, ri);
  } else if (e.ctrlKey || e.metaKey) {
    if (sel.rows.has(ri)) sel.rows.delete(ri); else sel.rows.add(ri);
    sel.anchor = ri;
  } else {
    sel.rows.clear();
    sel.rows.add(ri);
    sel.anchor = ri;
  }
  updateManualRowHighlights(side);
}

function continueManualRowSelect(e, side, ri) {
  const sel = manualSelection[side];
  if (!sel.dragging || manualDragState[side].active) return;
  selectManualRange(side, sel.anchor, ri);
  updateManualRowHighlights(side);
}

function selectManualRange(side, fromRi, toRi) {
  const sel  = manualSelection[side];
  const disp = getDisplayRows(side);
  const fi   = disp.findIndex(d => d.ri === fromRi);
  const ti   = disp.findIndex(d => d.ri === toRi);
  if (fi < 0 || ti < 0) return;
  sel.rows.clear();
  const lo = Math.min(fi, ti), hi = Math.max(fi, ti);
  for (let i = lo; i <= hi; i++) sel.rows.add(disp[i].ri);
}

function updateManualRowHighlights(side) {
  const wrap = document.getElementById(side === 'left' ? 'manualLeft' : 'manualRight');
  const sel  = manualSelection[side];
  wrap?.querySelectorAll('tbody tr').forEach(tr => {
    tr.classList.toggle('row-selected', sel.rows.has(parseInt(tr.dataset.ri)));
  });
}

// ── 행 선택 함수 (엑셀 업로드) ───────────────────────────────────────────────
function startExcelRowSelect(e, side, idx) {
  e.preventDefault();
  const sel = excelSelection[side];
  sel.dragging = true;
  if (e.shiftKey && sel.anchor !== null) {
    selectExcelRange(side, sel.anchor, idx);
  } else if (e.ctrlKey || e.metaKey) {
    if (sel.rows.has(idx)) sel.rows.delete(idx); else sel.rows.add(idx);
    sel.anchor = idx;
  } else {
    sel.rows.clear();
    sel.rows.add(idx);
    sel.anchor = idx;
  }
  updateExcelRowHighlights(side);
}

function continueExcelRowSelect(e, side, idx) {
  const sel = excelSelection[side];
  if (!sel.dragging || excelDragState[side].active) return;
  selectExcelRange(side, sel.anchor, idx);
  updateExcelRowHighlights(side);
}

function selectExcelRange(side, from, to) {
  const sel = excelSelection[side];
  sel.rows.clear();
  const lo = Math.min(from, to), hi = Math.max(from, to);
  for (let i = lo; i <= hi; i++) sel.rows.add(i);
}

function updateExcelRowHighlights(side) {
  const wrap = document.getElementById(side === 'A' ? 'tableA' : 'tableB');
  const sel  = excelSelection[side];
  wrap?.querySelectorAll('tbody tr').forEach((tr, i) => {
    tr.classList.toggle('row-selected', sel.rows.has(i));
  });
}

// ── 선택 행 복사 ──────────────────────────────────────────────────────────────
function copyManualRows(side) {
  const sel  = manualSelection[side];
  const disp = getDisplayRows(side).filter(({ri}) => sel.rows.has(ri));
  if (!disp.length) return;
  const text = disp.map(({row}) => row.join('\t')).join('\n');
  doCompareClipboard(text, `${disp.length}행 복사됨`);
}

function copyExcelRows(side) {
  const isA    = side === 'A';
  const data   = isA ? excelState.dataA  : excelState.dataB;
  const myCols = isA ? excelState.colsA  : excelState.colsB;
  const othMap = isA ? excelState.mapB   : excelState.mapA;
  const filter = isA ? excelState.filterA : excelState.filterB;
  const sel    = excelSelection[side];
  if (!data || !othMap || !sel.rows.size) return;
  const keyFn  = r => buildExcelKey(r, myCols);
  let   rows   = data.rows;
  if (filter) rows = rows.filter(r => !othMap.has(keyFn(r)));
  const selected = [...sel.rows].sort((a, b) => a - b).map(i => rows[i]).filter(Boolean);
  if (!selected.length) return;
  const text = selected.map(row => row.map(c => String(c ?? '')).join('\t')).join('\n');
  doCompareClipboard(text, `${selected.length}행 복사됨`);
}

function doCompareClipboard(text, msg) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showCompareToast(msg); } catch (_) {}
    document.body.removeChild(ta);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showCompareToast(msg)).catch(fallback);
  } else { fallback(); }
}

function showCompareToast(msg) {
  let t = document.getElementById('compareToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'compareToast'; t.className = 'copy-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── 글로벌 이벤트 ─────────────────────────────────────────────────────────────
document.addEventListener('mouseup', () => {
  mcsState.active = false;
  manualSelection.left.dragging  = false;
  manualSelection.right.dragging = false;
  excelSelection.A.dragging = false;
  excelSelection.B.dragging = false;
  if (manualDragState.left.active)  endManualDrag('left');
  if (manualDragState.right.active) endManualDrag('right');
  if (excelDragState.A.active) endExcelDrag('A');
  if (excelDragState.B.active) endExcelDrag('B');
});

document.addEventListener('mousedown', e => {
  const inTable = e.target.closest('#manualLeft,#manualRight,#tableA,#tableB');
  if (!inTable) {
    ['left','right'].forEach(s => { manualSelection[s].rows.clear(); updateManualRowHighlights(s); });
    ['A','B'].forEach(s => { excelSelection[s].rows.clear(); updateExcelRowHighlights(s); });
    mcsClear('left'); mcsClear('right');
  }
});

// ── 행 드래그 재정렬 ───────────────────────────────────────────────────────────
document.addEventListener('mousemove', e => {
  ['left', 'right'].forEach(side => {
    if (!manualDragState[side].active) return;
    const wrap = document.getElementById(side === 'left' ? 'manualLeft' : 'manualRight');
    const rows = [...(wrap?.querySelectorAll('tbody tr') || [])];
    let ov = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { ov = i; break; }
    }
    if (ov !== manualDragState[side].ovIdx) { manualDragState[side].ovIdx = ov; updateManualDragUI(side); }
  });
  ['A', 'B'].forEach(side => {
    if (!excelDragState[side].active) return;
    const wrap = document.getElementById(side === 'A' ? 'tableA' : 'tableB');
    const rows = [...(wrap?.querySelectorAll('tbody tr') || [])];
    let ov = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { ov = i; break; }
    }
    if (ov !== excelDragState[side].ovIdx) { excelDragState[side].ovIdx = ov; updateExcelDragUI(side); }
  });
});

function startManualDragReorder(e, side, displayIdx) {
  e.preventDefault(); e.stopPropagation();
  const drag = manualDragState[side];
  drag.active = true; drag.srcIdx = displayIdx; drag.ovIdx = displayIdx;
  updateManualDragUI(side);
}
function endManualDrag(side) {
  const drag = manualDragState[side];
  const fromDisp = drag.srcIdx; let toDisp = drag.ovIdx;
  drag.active = false; drag.srcIdx = null; drag.ovIdx = null;
  clearManualDragUI(side);
  if (fromDisp === null || toDisp === null || fromDisp === toDisp) return;
  const disp = getDisplayRows(side);
  if (fromDisp >= disp.length) return;
  const fromRi = disp[fromDisp].ri;
  if (toDisp === fromDisp + 1) return;
  let insertTarget = toDisp >= disp.length ? -1 : disp[toDisp].ri;
  if (insertTarget === fromRi) return;
  const rows = manualState[side].rows;
  const [item] = rows.splice(fromRi, 1);
  if (insertTarget === -1) {
    rows.push(item);
  } else {
    rows.splice(insertTarget > fromRi ? insertTarget - 1 : insertTarget, 0, item);
  }
  renderManualTable(side);
}
function updateManualDragUI(side) {
  const wrap = document.getElementById(side === 'left' ? 'manualLeft' : 'manualRight');
  const rows = [...(wrap?.querySelectorAll('tbody tr') || [])];
  const { srcIdx, ovIdx } = manualDragState[side];
  rows.forEach((r, i) => {
    r.classList.toggle('row-dragging', i === srcIdx);
    r.classList.toggle('drop-before', i === ovIdx && i !== srcIdx && ovIdx < rows.length);
    r.classList.toggle('drop-after', false);
  });
  if (ovIdx >= rows.length && rows.length > 0) rows[rows.length - 1].classList.add('drop-after');
}
function clearManualDragUI(side) {
  const wrap = document.getElementById(side === 'left' ? 'manualLeft' : 'manualRight');
  wrap?.querySelectorAll('tbody tr').forEach(r =>
    r.classList.remove('row-dragging', 'drop-before', 'drop-after'));
}

function startExcelDragReorder(e, side, idx) {
  e.preventDefault(); e.stopPropagation();
  const drag = excelDragState[side];
  drag.active = true; drag.srcIdx = idx; drag.ovIdx = idx;
  updateExcelDragUI(side);
}
function endExcelDrag(side) {
  const drag = excelDragState[side];
  const from = drag.srcIdx; let to = drag.ovIdx;
  drag.active = false; drag.srcIdx = null; drag.ovIdx = null;
  clearExcelDragUI(side);
  if (from === null || to === null || from === to) return;
  if (to > from) to--;
  if (from === to) return;
  const data = side === 'A' ? excelState.dataA : excelState.dataB;
  if (!data) return;
  const [item] = data.rows.splice(from, 1);
  data.rows.splice(to, 0, item);
  renderExcelTable(side);
}
function updateExcelDragUI(side) {
  const wrap = document.getElementById(side === 'A' ? 'tableA' : 'tableB');
  const rows = [...(wrap?.querySelectorAll('tbody tr') || [])];
  const { srcIdx, ovIdx } = excelDragState[side];
  rows.forEach((r, i) => {
    r.classList.toggle('row-dragging', i === srcIdx);
    r.classList.toggle('drop-before', i === ovIdx && i !== srcIdx && ovIdx < rows.length);
    r.classList.toggle('drop-after', false);
  });
  if (ovIdx >= rows.length && rows.length > 0) rows[rows.length - 1].classList.add('drop-after');
}
function clearExcelDragUI(side) {
  const wrap = document.getElementById(side === 'A' ? 'tableA' : 'tableB');
  wrap?.querySelectorAll('tbody tr').forEach(r =>
    r.classList.remove('row-dragging', 'drop-before', 'drop-after'));
}
