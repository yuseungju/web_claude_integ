// ── 상태 ──────────────────────────────────────────────────────────────────────
let rowSeq    = 0;
let _updating = false;   // 양방향 바인딩 순환 방지 플래그
let _allocInsertAfter = null; // 행 추가 시 삽입 위치 (data-id)
const allocDrag = { active: false, srcId: null, ovIdx: null };

// ── 초기화 ────────────────────────────────────────────────────────────────────
$('#totalBudget').addEventListener('input', onBudgetInput);
$('#addRowBtn').addEventListener('mousedown', () => {
  const active = document.activeElement;
  const tr = active?.closest('#allocBody tr');
  _allocInsertAfter = tr ? parseInt(tr.dataset.id) : null;
});
$('#addRowBtn').addEventListener('click',   addRow);
$('#equalBtn').addEventListener('click',    equalDistribute);
$('#distRemainBtn').addEventListener('click', distributeRemaining);
$('#resetBtn').addEventListener('click',    resetAll);

// Excel 버튼
$('#excelUpload').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) { uploadExcel(file); e.target.value = ''; }
});
$('#dlTemplateBtn').addEventListener('click', downloadTemplate);
$('#dlResultBtn').addEventListener('click',   downloadResult);

// 전체 선택/해제
$('#checkAll').addEventListener('change', function () {
  $$('#allocBody .row-check').forEach(cb => {
    cb.checked = this.checked;
    cb.closest('tr').classList.toggle('row-locked', this.checked);
  });
});

addRow(); addRow(); addRow();

// ── 총예산 입력 ───────────────────────────────────────────────────────────────
function onBudgetInput(e) {
  const raw = e.target.value.replace(/[^0-9]/g, '');
  e.target.value = raw ? parseInt(raw, 10).toLocaleString('ko-KR') : '';
  // 예산이 바뀌면 % 값 유지한 채 모든 금액을 재산출
  recalculateAllAmounts();
}

function parseBudget() {
  return parseInt($('#totalBudget').value.replace(/[^0-9]/g, '') || '0', 10);
}

// ── 행 추가 ───────────────────────────────────────────────────────────────────
// itemVal / pctVal / amountVal 를 넘기면 미리 채워진 행으로 추가
function addRow({ itemVal = '', pctVal = '', amountVal = '' } = {}) {
  rowSeq++;
  const id = rowSeq;

  const tr = document.createElement('tr');
  tr.dataset.id = id;
  tr.innerHTML  = `
    <td class="drag-handle" onmousedown="startAllocDragReorder(event,${id})">⠿</td>
    <td class="col-check">
      <input type="checkbox" class="row-check" onchange="onRowCheck(this)" />
    </td>
    <td class="col-num row-idx"></td>
    <td><input type="text"   class="input-item"   placeholder="항목명 입력" /></td>
    <td>
      <div class="pct-wrap">
        <input type="number" class="input-pct" step="0.01" placeholder="0"
               oninput="onPctInput(${id})" />
        <span class="pct-unit">%</span>
      </div>
    </td>
    <td class="td-amount">
      <input type="text" class="input-amount" placeholder="자동 계산"
             oninput="onAmountInput(${id})" onblur="formatAmountBlur(this)" />
    </td>
    <td><button class="del-btn" onclick="deleteRow(${id})" title="행 삭제">×</button></td>
  `;

  if (itemVal)   tr.querySelector('.input-item').value   = itemVal;
  if (pctVal)    tr.querySelector('.input-pct').value    = String(pctVal);
  if (amountVal) tr.querySelector('.input-amount').value = amountVal;

  const tbody = $('#allocBody');
  const insertAfterId = _allocInsertAfter;
  _allocInsertAfter = null;

  if (insertAfterId != null) {
    const refTr = tbody.querySelector(`tr[data-id="${insertAfterId}"]`);
    if (refTr?.nextSibling) {
      tbody.insertBefore(tr, refTr.nextSibling);
    } else {
      tbody.appendChild(tr);
    }
  } else {
    tbody.appendChild(tr);
  }

  refreshRowNumbers();
  updateTotals();
}

// ── 행 삭제 ───────────────────────────────────────────────────────────────────
function deleteRow(id) {
  $('#allocBody').querySelector(`tr[data-id="${id}"]`)?.remove();
  refreshRowNumbers();
  updateTotals();
}

function refreshRowNumbers() {
  $$('#allocBody tr').forEach((tr, i) => {
    const cell = tr.querySelector('.row-idx');
    if (cell) cell.textContent = i + 1;
  });
}

// ── 행 체크박스 토글 ──────────────────────────────────────────────────────────
// 체크된 행 = "고정" 강조 표시
function onRowCheck(cb) {
  cb.closest('tr').classList.toggle('row-locked', cb.checked);
  // 전체선택 체크박스 상태 동기화
  const all     = $$('#allocBody .row-check');
  const checked = all.filter(c => c.checked);
  const checkAll = $('#checkAll');
  checkAll.indeterminate = checked.length > 0 && checked.length < all.length;
  checkAll.checked       = checked.length === all.length && all.length > 0;
}

// ── 선택 고정·나머지 균등 ─────────────────────────────────────────────────────
// 체크된 행: % 값 유지(고정)
// 미체크 행: 잔여 % (100 - 고정 합계) 를 균등하게 나눔
function distributeRemaining() {
  const allRows     = $$('#allocBody tr');
  const locked      = allRows.filter(tr => tr.querySelector('.row-check').checked);
  const free        = allRows.filter(tr => !tr.querySelector('.row-check').checked);

  if (!free.length) {
    alert('나머지 항목이 없습니다. 고정하지 않을 행을 선택 해제해 주세요.'); return;
  }

  // 고정 행들의 % 합계
  const lockedPct = locked.reduce((sum, tr) =>
    sum + (parseFloat(tr.querySelector('.input-pct').value) || 0), 0);

  const remainPct = 100 - lockedPct;
  if (remainPct < -0.005) {
    alert(`선택된 항목의 합계(${lockedPct.toFixed(2)}%)가 이미 100%를 초과합니다.`); return;
  }

  const pctEach  = remainPct / free.length;
  const budget   = parseBudget();

  free.forEach(tr => {
    tr.querySelector('.input-pct').value    = pctEach.toFixed(2);
    tr.querySelector('.input-amount').value =
      budget > 0 ? Math.round(budget * pctEach / 100).toLocaleString('ko-KR') : '';
  });

  updateTotals();
}

// ── 전체 균등 분배 ────────────────────────────────────────────────────────────
function equalDistribute() {
  const trs = $$('#allocBody tr');
  if (!trs.length) return;
  const pct    = (100 / trs.length);
  const budget = parseBudget();
  trs.forEach(tr => {
    tr.querySelector('.input-pct').value    = pct.toFixed(2);
    tr.querySelector('.input-amount').value =
      budget > 0 ? Math.round(budget * pct / 100).toLocaleString('ko-KR') : '';
  });
  updateTotals();
}

// ── 초기화 ────────────────────────────────────────────────────────────────────
function resetAll() {
  $('#totalBudget').value   = '';
  $('#allocBody').innerHTML = '';
  rowSeq = 0;
  addRow(); addRow(); addRow();
}

// ── 양방향 바인딩: % → 금액 ──────────────────────────────────────────────────
// % 입력 시 → 금액 자동 산출
function onPctInput(id) {
  if (_updating) return;
  const tr     = $('#allocBody').querySelector(`tr[data-id="${id}"]`);
  const budget = parseBudget();
  const pct    = parseFloat(tr.querySelector('.input-pct').value) || 0;
  const amount = Math.round(budget * pct / 100);

  _updating = true;
  const amountEl = tr.querySelector('.input-amount');
  amountEl.value = amount > 0 ? amount.toLocaleString('ko-KR') : '';
  _updating = false;

  updateTotals();
}

// ── 양방향 바인딩: 금액 → % ───────────────────────────────────────────────────
// 금액 직접 입력 시 → % 역산
function onAmountInput(id) {
  if (_updating) return;
  const tr     = $('#allocBody').querySelector(`tr[data-id="${id}"]`);
  const budget = parseBudget();
  const raw    = tr.querySelector('.input-amount').value.replace(/[^0-9]/g, '');
  const amount = parseInt(raw || '0', 10);
  const pct    = budget > 0 ? (amount / budget * 100) : 0;

  // 금액 입력 중 천단위 콤마 실시간 포맷
  _updating = true;
  const inputEl = tr.querySelector('.input-amount');
  const cursor  = inputEl.selectionStart;        // 커서 위치 보존
  inputEl.value = amount > 0 ? amount.toLocaleString('ko-KR') : '';

  _updating = false;

  tr.querySelector('.input-pct').value = pct > 0 ? pct.toFixed(2) : '';
  updateTotals();
}

// 금액 입력란 포커스 아웃 시 최종 포맷 정리
function formatAmountBlur(el) {
  const raw = el.value.replace(/[^0-9]/g, '');
  el.value  = raw ? parseInt(raw, 10).toLocaleString('ko-KR') : '';
}

// ── 총예산 변경 시: 모든 행 금액 재산출 (% 유지) ────────────────────────────
function recalculateAllAmounts() {
  const budget = parseBudget();
  $$('#allocBody tr').forEach(tr => {
    const pct    = parseFloat(tr.querySelector('.input-pct').value) || 0;
    const amount = Math.round(budget * pct / 100);
    const amountEl = tr.querySelector('.input-amount');
    // 사용자가 현재 금액란을 편집 중이면 건드리지 않음
    if (document.activeElement !== amountEl) {
      amountEl.value = amount > 0 ? amount.toLocaleString('ko-KR') : '';
    }
  });
  updateTotals();
}

// ── 합계 & 진행률 바 갱신 ────────────────────────────────────────────────────
function updateTotals() {
  const budget = parseBudget();
  let totalPct = 0;

  $$('#allocBody tr').forEach(tr => {
    totalPct += parseFloat(tr.querySelector('.input-pct').value) || 0;
  });

  updateSummary(totalPct, budget);
  updateBudgetHint(budget);
}

function updateSummary(totalPct, budget) {
  const remaining   = 100 - totalPct;
  const totalAmount = budget * totalPct / 100;

  // tfoot
  $('#footPct').textContent    = totalPct.toFixed(2) + '%';
  $('#footAmount').textContent = formatKRW(totalAmount);

  // 진행률 바
  const bar = $('#barFill');
  bar.style.width = Math.min(Math.abs(totalPct), 100) + '%';
  bar.className   = 'bar-fill' +
    (totalPct > 100.005 ? ' over' : totalPct >= 99.995 ? ' ok' : '');

  // 상태 %
  const statusEl = $('#pctStatus');
  statusEl.textContent = totalPct.toFixed(2) + '%';

  // 잔여/초과 안내
  const remainEl = $('#remainInfo');

  if (Math.abs(remaining) < 0.005) {
    statusEl.className   = 'pct-status ok';
    remainEl.textContent = '✓ 100% 완료';
    remainEl.className   = 'remain-info ok';

  } else if (remaining > 0) {
    const underAmt = budget * remaining / 100;
    statusEl.className   = 'pct-status warning';
    remainEl.textContent = `미배분 ${remaining.toFixed(2)}%  (${formatKRW(underAmt)})`;
    remainEl.className   = 'remain-info warning';

  } else {
    // 초과: % + 차액(금액) 모두 표시
    const overPct = Math.abs(remaining);
    const overAmt = budget * overPct / 100;
    statusEl.className   = 'pct-status over';
    remainEl.textContent = `초과 ${overPct.toFixed(2)}%  (차액 ${formatKRW(overAmt)})`;
    remainEl.className   = 'remain-info over';
  }

  // progress-meta 합계
  $('#summaryPct').textContent    = totalPct.toFixed(2) + '%';
  $('#summaryAmount').textContent = formatKRW(totalAmount);
}

function updateBudgetHint(budget) {
  $('#budgetHint').textContent = budget > 0
    ? `총 ${formatKRW(budget)} 기준으로 금액을 계산합니다`
    : '총예산을 입력하면 자동으로 금액이 산출됩니다';
}

// ── 드래그 재정렬 ─────────────────────────────────────────────────────────────
document.addEventListener('mousemove', e => {
  if (!allocDrag.active) return;
  const rows = [...document.querySelectorAll('#allocBody tr')];
  let ov = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { ov = i; break; }
  }
  if (ov !== allocDrag.ovIdx) { allocDrag.ovIdx = ov; updateAllocDragUI(); }
});

document.addEventListener('mouseup', () => { if (allocDrag.active) endAllocDrag(); });

function startAllocDragReorder(e, id) {
  e.preventDefault(); e.stopPropagation();
  const rows = [...document.querySelectorAll('#allocBody tr')];
  const srcIdx = rows.findIndex(tr => parseInt(tr.dataset.id) === id);
  allocDrag.active = true; allocDrag.srcId = id; allocDrag.ovIdx = srcIdx;
  updateAllocDragUI();
}
function endAllocDrag() {
  const srcId = allocDrag.srcId; const toIdx = allocDrag.ovIdx;
  allocDrag.active = false; allocDrag.srcId = null; allocDrag.ovIdx = null;
  clearAllocDragUI();
  if (srcId === null) return;
  const tbody = $('#allocBody');
  const rows = [...tbody.querySelectorAll('tr')];
  const fromIdx = rows.findIndex(tr => parseInt(tr.dataset.id) === srcId);
  if (fromIdx < 0 || toIdx === fromIdx || toIdx === fromIdx + 1) return;
  const srcTr = rows[fromIdx];
  if (toIdx >= rows.length) {
    tbody.appendChild(srcTr);
  } else {
    tbody.insertBefore(srcTr, rows[toIdx]);
  }
  refreshRowNumbers();
  updateTotals();
}
function updateAllocDragUI() {
  const rows = [...document.querySelectorAll('#allocBody tr')];
  const srcIdx = rows.findIndex(tr => parseInt(tr.dataset.id) === allocDrag.srcId);
  const ovIdx  = allocDrag.ovIdx;
  rows.forEach((r, i) => {
    r.classList.toggle('row-dragging', i === srcIdx);
    r.classList.toggle('drop-before', i === ovIdx && i !== srcIdx && ovIdx < rows.length);
    r.classList.toggle('drop-after', false);
  });
  if (ovIdx >= rows.length && rows.length > 0) rows[rows.length - 1].classList.add('drop-after');
}
function clearAllocDragUI() {
  document.querySelectorAll('#allocBody tr').forEach(r =>
    r.classList.remove('row-dragging', 'drop-before', 'drop-after'));
}

// ── Ctrl+C 복사 ───────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key !== 'c') return;
  const active = document.activeElement;
  if (active?.matches('input,textarea') && (active.selectionEnd - active.selectionStart) > 0) return;
  if (window.getSelection?.()?.toString().length > 0) return;
  const rows = [...document.querySelectorAll('#allocBody tr')].filter(tr => tr.querySelector('.row-check')?.checked);
  if (!rows.length) return;
  e.preventDefault();
  const text = rows.map(tr => [
    tr.querySelector('.input-item')?.value  || '',
    tr.querySelector('.input-pct')?.value   || '',
    tr.querySelector('.input-amount')?.value || '',
  ].join('\t')).join('\n');
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
});

// ── KRW 포맷 ─────────────────────────────────────────────────────────────────
function formatKRW(amount) {
  return Math.round(amount).toLocaleString('ko-KR') + '원';
}

// ── Excel 업로드 ──────────────────────────────────────────────────────────────
// 1열: 예산항목, 2열: 금액 → 행으로 변환. 기존 데이터 있으면 덮어쓸지 확인.
function uploadExcel(file) {
  const existing = $$('#allocBody tr').some(tr =>
    tr.querySelector('.input-item').value.trim() ||
    tr.querySelector('.input-pct').value.trim()
  );
  if (existing && !confirm('기존 데이터를 지우고 업로드한 파일로 교체할까요?')) return;

  ExcelReader.read(file)
    .then(result => {
      const sheet = result.sheets[result.sheetNames[0]];
      const rows  = sheet.rows.filter(r => r[0] || r[1]); // 빈 행 제외

      if (!rows.length) { alert('데이터가 없습니다.'); return; }

      // 기존 행 초기화
      $('#allocBody').innerHTML = '';
      rowSeq = 0;

      // 총예산 미입력 시 → 엑셀 금액 열 합계로 자동 세팅
      let budget = parseBudget();
      if (budget === 0) {
        const excelTotal = rows.reduce((sum, row) => {
          const raw = String(row[1] ?? '').replace(/[^0-9]/g, '');
          return sum + parseInt(raw || '0', 10);
        }, 0);
        if (excelTotal > 0) {
          budget = excelTotal;
          $('#totalBudget').value = excelTotal.toLocaleString('ko-KR');
          updateBudgetHint(budget);
        }
      }

      rows.forEach(row => {
        const itemVal   = String(row[0] ?? '').trim();
        // 금액 열: 숫자 또는 문자열("1,000,000원" 등) 모두 처리
        const rawAmt    = String(row[1] ?? '').replace(/[^0-9]/g, '');
        const amtNum    = parseInt(rawAmt || '0', 10);
        const pctVal    = (budget > 0 && amtNum > 0)
                            ? (amtNum / budget * 100).toFixed(2)
                            : '';
        const amountVal = amtNum > 0 ? amtNum.toLocaleString('ko-KR') : '';

        addRow({ itemVal, pctVal, amountVal });
      });

      // 업로드된 파일명 표시
      $('#uploadName').textContent = '✓ ' + file.name;
      refreshRowNumbers();
      updateTotals();
    })
    .catch(err => alert('업로드 실패: ' + err.message));
}

// ── 양식 다운로드 ─────────────────────────────────────────────────────────────
// 1열: 예산항목, 2열: 금액  — 샘플 2행 포함
function downloadTemplate() {
  const wsData = [
    ['예산항목', '금액'],
    ['예) 인건비', 50000000],
    ['예) 임차료', 20000000],
    ['', ''],
    ['', ''],
    ['', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 22 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '예산항목');
  XLSX.writeFile(wb, '예산분배_양식.xlsx');
}

// ── 결과 다운로드 ─────────────────────────────────────────────────────────────
// 상단 요약 헤더 + 분배 테이블 전체를 엑셀로 저장
function downloadResult() {
  const budget = parseBudget();
  let totalPct = 0;
  const dataRows = [];

  $$('#allocBody tr').forEach(tr => {
    const item   = tr.querySelector('.input-item').value  || '';
    const pct    = parseFloat(tr.querySelector('.input-pct').value)    || 0;
    const rawAmt = tr.querySelector('.input-amount').value.replace(/[^0-9]/g, '');
    const amount = parseInt(rawAmt || '0', 10);
    totalPct += pct;
    dataRows.push([item, pct / 100, amount]);   // pct를 소수로 저장 → 셀 서식 활용
  });

  const totalAmount = Math.round(budget * totalPct / 100);
  const now = new Date().toLocaleString('ko-KR', { hour12: false });

  // ── 워크시트 데이터 구성 ──
  const wsData = [
    ['예산 분배 결과'],
    [],
    ['작성일시',      now],
    ['총예산 (원)',    budget],
    ['배분율 합계',   totalPct.toFixed(2) + '%'],
    ['배분금액 합계 (원)', totalAmount],
    [],
    ['예산 항목', '비율 (%)', '금액 (원)'],
    ...dataRows,
    [],
    ['합계', totalPct.toFixed(2) + '%', totalAmount],
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // 열 너비
  ws['!cols'] = [{ wch: 26 }, { wch: 14 }, { wch: 20 }];

  // 데이터 행의 비율 열(B)을 퍼센트 서식으로 지정
  const headerRowIdx = 8;   // wsData 기준 0-indexed row 7 = 엑셀 행 8
  dataRows.forEach((_, i) => {
    const cellAddr = XLSX.utils.encode_cell({ r: headerRowIdx + i, c: 1 });
    if (ws[cellAddr]) ws[cellAddr].z = '0.00%';
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '예산분배');

  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `예산분배_결과_${dateStr}.xlsx`);
}

/* ── Data Manager callbacks ─────────────────────────────── */
window.getMenuData = () => {
  const rows = [...document.querySelectorAll('#allocBody tr')].map(tr => ({
    item:   tr.querySelector('.input-item')?.value || '',
    pct:    tr.querySelector('.input-pct')?.value  || '',
    locked: tr.querySelector('.row-check')?.checked || false,
  }));
  return { budget: document.getElementById('totalBudget').value, rows };
};
window.setMenuData = d => {
  document.getElementById('totalBudget').value = d.budget || '';
  document.getElementById('allocBody').innerHTML = '';
  rowSeq = 0; _allocInsertAfter = null;
  (d.rows || []).forEach(r => addRow({ itemVal: r.item, pctVal: r.pct }));
  const trs = [...document.querySelectorAll('#allocBody tr')];
  (d.rows || []).forEach((r, i) => {
    if (r.locked && trs[i]) {
      const cb = trs[i].querySelector('.row-check');
      if (cb) { cb.checked = true; onRowCheck(cb); }
    }
  });
  recalculateAllAmounts();
};
