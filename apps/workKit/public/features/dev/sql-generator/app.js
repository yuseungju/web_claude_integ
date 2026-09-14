// ── 상태 ─────────────────────────────────────────────────────
let excelData = null;      // { headers: string[], rows: any[][] }
let keyCols   = new Set(); // 선택된 KEY 컬럼 인덱스
let dialect   = 'oracle';
let lastSQL   = '';
let lastFileBase = 'query';
let cellSel   = { r1: null, c1: null, r2: null, c2: null, dragging: false }; // 셀 범위 선택

new FileDropZone($('#uploadZone'), $('#fileInput'), { onFile: handleFile });

// ── DB 종류 선택 ─────────────────────────────────────────────
function setDialect(d, btn) {
  dialect = d;
  $$('.dialect-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// ── 엑셀 업로드 ──────────────────────────────────────────────
async function handleFile(file) {
  try {
    const { sheetNames, sheets } = await ExcelReader.read(file, { cellDates: true });
    const sheet = sheets[sheetNames[0]];
    if (!sheet.headers.length) { alert('엑셀에서 컬럼명을 찾을 수 없습니다.'); return; }

    excelData = sheet;
    keyCols = new Set();
    lastFileBase = file.name.replace(/\.[^.]+$/, '');
    cellSel = { r1: null, c1: null, r2: null, c2: null, dragging: false };

    renderPreview();
    $('#sqlSettings').style.display = '';
    $('#colSettingsCard').style.display = '';
    $('#previewCard').style.display = '';
    $('#sqlActions').style.display = '';
    $('#outputCard').style.display = 'none';
    updateUI();
  } catch (e) {
    alert(e.message);
  }
}

// ── 미리보기 테이블 (헤더 클릭 → KEY 토글) ──────────────────
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 엑셀 날짜 셀(Date 객체)을 화면 표시용 YYYY-MM-DD 로 변환
function displayValue(val) {
  return val instanceof Date ? toYmd(val, '-') : val;
}

// Date → 'YYYYMMDD' (sep='') 또는 'YYYY-MM-DD' (sep='-')
function toYmd(date, sep) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return sep ? `${y}${sep}${m}${sep}${d}` : `${y}${m}${d}`;
}

// 컬럼 / KEY 설정 영역 (미리보기 표와 분리된, 스크롤에 영향받지 않는 영역)
function renderColumnSettings() {
  const { headers } = excelData;
  $('#colSettings').innerHTML = headers.map((h, i) => `
    <div class="col-chip${keyCols.has(i) ? ' key-col' : ''}">
      <span class="chip-label" onclick="toggleKey(${i})" title="클릭하여 KEY 설정/해제">
        ${escapeHtml(h)}${keyCols.has(i) ? ' <span class="key-tag">KEY</span>' : ''}
      </span>
      <button class="chip-del-btn" onclick="deleteColumn(${i})" title="이 컬럼 삭제">✕</button>
    </div>`).join('');
}

function renderPreview() {
  const { headers, rows } = excelData;
  $('#rowCount').textContent = rows.length;

  renderColumnSettings();

  const thead = `<tr>
    <th class="col-num">#</th>
    ${headers.map((h, i) => `<th class="${keyCols.has(i) ? 'key-col' : ''}">${escapeHtml(h)}${keyCols.has(i) ? ' <span class="key-tag">KEY</span>' : ''}</th>`).join('')}
  </tr>`;

  const previewRows = rows.slice(0, 200);
  const tbody = previewRows.map((row, i) => {
    const cells = headers.map((_, j) => {
      const cls = keyCols.has(j) ? 'key-col' : '';
      const val = escapeHtml(displayValue(row[j]));
      return `<td class="${cls}" data-r="${i}" data-c="${j}" onmousedown="cellMouseDown(event,${i},${j})" onmouseenter="cellMouseEnter(event,${i},${j})"><input class="cell-input" type="text" value="${val}" oninput="onCellInput(event,${i},${j})"></td>`;
    }).join('');
    return `<tr><td class="col-num">${i + 1}</td>${cells}</tr>`;
  }).join('');

  $('#previewTable').innerHTML = `
    <table class="data-table">
      <thead>${thead}</thead>
      <tbody>${tbody}</tbody>
    </table>
    ${rows.length > 200 ? `<div class="preview-more">상위 200행만 표시됩니다 (쿼리는 전체 ${rows.length}행 기준으로 생성됩니다)</div>` : ''}
  `;
  updateCellRangeUI();
}

// ── 셀 범위 선택 / 복사·붙여넣기 ─────────────────────────────
function cellMouseDown(e, r, c) {
  cellSel = { r1: r, c1: c, r2: r, c2: c, dragging: true };
  updateCellRangeUI();
}

function cellMouseEnter(e, r, c) {
  if (!cellSel.dragging) return;
  cellSel.r2 = r;
  cellSel.c2 = c;
  updateCellRangeUI();
}

document.addEventListener('mouseup', () => { cellSel.dragging = false; });

function updateCellRangeUI() {
  const { r1, c1, r2, c2 } = cellSel;
  $$('#previewTable td[data-r]').forEach(td => td.classList.remove('cell-range'));
  if (r1 === null) return;
  const rmin = Math.min(r1, r2), rmax = Math.max(r1, r2);
  const cmin = Math.min(c1, c2), cmax = Math.max(c1, c2);
  $$('#previewTable td[data-r]').forEach(td => {
    const r = +td.dataset.r, c = +td.dataset.c;
    if (r >= rmin && r <= rmax && c >= cmin && c <= cmax) td.classList.add('cell-range');
  });
}

function onCellInput(e, r, c) {
  excelData.rows[r][c] = e.target.value;
}

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
  if (!excelData || cellSel.r1 === null) return;
  const active = document.activeElement;
  if (active && active.matches('input,textarea') && active.selectionStart !== active.selectionEnd) return;

  const { r1, c1, r2, c2 } = cellSel;
  const rmin = Math.min(r1, r2), rmax = Math.max(r1, r2);
  const cmin = Math.min(c1, c2), cmax = Math.max(c1, c2);
  const lines = [];
  for (let r = rmin; r <= rmax; r++) {
    const row = excelData.rows[r] || [];
    const cells = [];
    for (let c = cmin; c <= cmax; c++) {
      const v = row[c];
      cells.push(v === undefined || v === null ? '' : String(displayValue(v)));
    }
    lines.push(cells.join('\t'));
  }
  navigator.clipboard.writeText(lines.join('\n'));
  e.preventDefault();
});

$('#previewTable').addEventListener('paste', (e) => {
  const active = document.activeElement;
  if (!excelData || !active || !active.matches('.cell-input')) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text) return;
  e.preventDefault();

  const td = active.closest('td');
  const r0 = +td.dataset.r;
  const c0 = +td.dataset.c;

  const tsvRows = text.replace(/\r/g, '').split('\n');
  if (tsvRows.length > 1 && tsvRows[tsvRows.length - 1] === '') tsvRows.pop();

  const { headers, rows } = excelData;
  tsvRows.forEach((line, i) => {
    const cells = line.split('\t');
    const r = r0 + i;
    while (rows.length <= r) rows.push(new Array(headers.length).fill(''));
    cells.forEach((val, j) => {
      const c = c0 + j;
      if (c < headers.length) rows[r][c] = val;
    });
  });

  cellSel = { r1: r0, c1: c0, r2: r0 + tsvRows.length - 1, c2: Math.min(headers.length - 1, c0 + Math.max(...tsvRows.map(l => l.split('\t').length)) - 1), dragging: false };
  renderPreview();
  updateUI();
  $('#outputCard').style.display = 'none';
});

function toggleKey(idx) {
  if (keyCols.has(idx)) keyCols.delete(idx); else keyCols.add(idx);
  renderPreview();
  updateUI();
}

// ── 컬럼 삭제 ────────────────────────────────────────────────
function deleteColumn(idx) {
  if (excelData.headers.length <= 1) {
    alert('최소 1개의 컬럼이 필요합니다.');
    return;
  }
  excelData.headers.splice(idx, 1);
  excelData.rows.forEach(row => row.splice(idx, 1));

  const shifted = new Set();
  keyCols.forEach(k => {
    if (k < idx) shifted.add(k);
    else if (k > idx) shifted.add(k - 1);
  });
  keyCols = shifted;
  cellSel = { r1: null, c1: null, r2: null, c2: null, dragging: false };

  renderPreview();
  updateUI();
  $('#outputCard').style.display = 'none';
}

function updateUI() {
  const keyInfo = $('#keyInfo');
  const hasKey  = keyCols.size > 0;

  if (hasKey) {
    const names = [...keyCols].sort((a, b) => a - b).map(i => excelData.headers[i]).join(', ');
    keyInfo.textContent = `KEY: ${names}`;
    keyInfo.classList.add('active');
  } else {
    keyInfo.textContent = 'KEY 미설정';
    keyInfo.classList.remove('active');
  }

  const hint = $('#keyHint');
  hint.style.display = hasKey ? 'none' : '';
}

// ── 식별자 / 값 변환 ─────────────────────────────────────────
function applyCase(name) {
  const opt = $('#caseOption').value;
  const n = String(name).trim().replace(/\s+/g, '_');
  if (opt === 'upper') return n.toUpperCase();
  if (opt === 'lower') return n.toLowerCase();
  return n;
}

function formatValue(val, d) {
  if (val === '' || val === null || val === undefined) {
    return d === 'abap' ? `''` : 'NULL';
  }
  if (val instanceof Date) {
    return d === 'abap' ? `'${toYmd(val)}'` : `'${toYmd(val, '-')}'`;
  }
  if (typeof val === 'boolean') {
    if (d === 'abap') return val ? `'X'` : `''`;
    return val ? `'1'` : `'0'`;
  }
  const s = String(val).trim();
  return `'${s.replace(/'/g, "''")}'`;
}

function getTableName() {
  return applyCase($('#tableName').value.trim());
}

// ── INSERT 생성 ──────────────────────────────────────────────
function generateInsert() {
  if (!excelData) return;
  const table = getTableName();
  if (!table) { alert('테이블명을 입력해주세요.'); return; }

  const { headers, rows } = excelData;
  const cols  = headers.map(applyCase);
  const sortedKeys = [...keyCols].sort((a, b) => a - b);
  const lines = [];

  if (dialect === 'abap') {
    rows.forEach(row => {
      const fields = cols.map((f, i) => `${f} = ${formatValue(row[i], 'abap')}`).join(' ');
      const verb = sortedKeys.length > 0 ? 'MODIFY' : 'INSERT';
      lines.push(`${verb} ${table} FROM @( VALUE #( ${fields} ) ).`);
    });
  } else {
    const colList = cols.join(', ');
    const semi = dialect === 'abap_st04' ? '' : ';';
    rows.forEach(row => {
      const vals = headers.map((_, i) => formatValue(row[i], dialect)).join(', ');
      if (sortedKeys.length > 0) {
        const cond = sortedKeys.map(i => `${cols[i]} = ${formatValue(row[i], dialect)}`).join(' AND ');
        lines.push(`INSERT INTO ${table} (${colList}) SELECT ${vals} FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${cond})${semi}`);
      } else {
        lines.push(`INSERT INTO ${table} (${colList}) VALUES (${vals})${semi}`);
      }
    });
  }

  const mode = sortedKeys.length > 0
    ? (dialect === 'abap' ? 'MODIFY · KEY 기준 중복 시 갱신' : 'INSERT · KEY 기준 중복 체크')
    : 'INSERT';
  showOutput(lines.join('\n'), `INSERT 문 (${mode})`, rows.length);
}

// ── DELETE 생성 ──────────────────────────────────────────────
function generateDelete() {
  if (!excelData) return;
  const table = getTableName();
  if (!table) { alert('테이블명을 입력해주세요.'); return; }
  if (keyCols.size === 0) { alert('DELETE문을 생성하려면 컬럼 / KEY 설정 영역에서 KEY를 설정해주세요.'); return; }

  const { headers, rows } = excelData;
  const cols  = headers.map(applyCase);
  const sortedKeys = [...keyCols].sort((a, b) => a - b);

  const lines = rows.map(row => {
    const cond = sortedKeys.map(i => `${cols[i]} = ${formatValue(row[i], dialect)}`).join(' AND ');
    if (dialect === 'abap')      return `DELETE FROM ${table} WHERE ${cond}.`;
    if (dialect === 'abap_st04') return `DELETE FROM ${table} WHERE ${cond}`;
    return `DELETE FROM ${table} WHERE ${cond};`;
  });

  showOutput(lines.join('\n'), 'DELETE 문', rows.length);
}

// ── 결과 출력 ────────────────────────────────────────────────
function showOutput(sql, title, count) {
  lastSQL = sql;
  $('#outputTitle').textContent = `${title} — ${count}건`;
  $('#sqlOutput').value = sql;
  $('#outputCard').style.display = '';
  $('#outputCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function copySQL(btn) {
  if (!lastSQL) return;
  navigator.clipboard.writeText(lastSQL).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ 복사됨';
    setTimeout(() => { btn.textContent = orig; }, 1200);
  });
}

function downloadSQL() {
  if (!lastSQL) return;
  const blob = new Blob([lastSQL], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${lastFileBase}_query.sql`;
  a.click();
  URL.revokeObjectURL(url);
}
