/** CP · IV 계산기 — 표시 CP/HP로 가능한 (레벨, IV) 조합을 역산 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI;
  const $ = id => document.getElementById(id);
  const MAX_ROWS = 300;   // 표에 그리는 최대 행 수 (조합이 수백 개 나올 수 있음)
  let current = null;     // 마지막으로 계산한 포켓몬 (보관함 저장에 사용)
  let picker = null;

  /** 감정 등급 -> IV 합계 범위 */
  const GRADE_RANGE = { 4: [37, 45], 3: [30, 36], 2: [23, 29], 1: [0, 22] };

  function gradeOf(total) {
    if (total >= 37) return '★★★';
    if (total >= 30) return '★★';
    if (total >= 23) return '★';
    return '☆';
  }

  /** 레벨 범위 옵션 -> 검사할 레벨 배열 */
  function levelsFor(cap) {
    if (cap === '20') return [20, 25];           // 레이드/알은 고정 레벨
    const max = Number(cap);
    return P.LEVELS.filter(l => l <= max);
  }

  function solve(p, targetCp, targetHp, grade, cap) {
    const range = GRADE_RANGE[grade];
    const ivMin = cap === '20' ? 10 : 0;         // 레이드/알 산출물은 IV 최소 10
    return P.solveIV(p, targetCp, targetHp, levelsFor(cap), ivMin)
      .filter(r => !range || (r.total >= range[0] && r.total <= range[1]));
  }

  function renderSummary(p, results) {
    const box = $('summary');
    if (!results.length) {
      box.innerHTML = `<div class="pgo-panel"><div class="pgo-empty">
        조건에 맞는 조합이 없습니다.<br>
        <span style="font-size:.78rem">CP·HP 입력값과 레벨 범위를 확인해 주세요. 종족값 환산 오차로 일부 전설 포켓몬은 결과가 안 나올 수 있습니다.</span>
      </div></div>`;
      return;
    }

    const totals = results.map(r => r.total);
    const min = Math.min(...totals), max = Math.max(...totals);
    const levels = [...new Set(results.map(r => r.level))].sort((a, b) => a - b);
    const pct = t => Math.round(t / 45 * 100);
    const best = results[0];

    box.innerHTML = `<div class="pgo-panel">
      <h2>${UI.esc(P.displayName(p))} 분석 결과</h2>
      <div class="pgo-kv">
        <div class="pgo-kv-item"><span class="pgo-kv-k">가능한 조합</span><span class="pgo-kv-v">${results.length}</span></div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">IV 범위</span><span class="pgo-kv-v">${pct(min)}~${pct(max)}%</span></div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">추정 레벨</span><span class="pgo-kv-v">${levels[0]}${levels.length > 1 ? `~${levels[levels.length - 1]}` : ''}</span></div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">최고 조합</span><span class="pgo-kv-v">${best.a}/${best.d}/${best.s}</span></div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">50레벨 최대 CP</span><span class="pgo-kv-v">${p.maxCp}</span></div>
      </div>
      ${results.length > 1 && !$('hp').value
        ? '<div class="pgo-note" style="margin-top:.8rem">HP를 함께 입력하면 조합이 크게 줄어듭니다.</div>'
        : ''}
    </div>`;
  }

  function renderRows(p, results) {
    const rows = results.slice(0, MAX_ROWS).map(r => `<tr>
      <td class="num">${r.level}</td>
      <td class="num">${r.a}</td>
      <td class="num">${r.d}</td>
      <td class="num">${r.s}</td>
      <td class="num">${r.total}/45</td>
      <td class="num">${Math.round(r.total / 45 * 100)}%</td>
      <td>${gradeOf(r.total)}</td>
      <td class="num">${P.cp(p.go, { a: r.a, d: r.d, s: r.s }, P.MAX_LEVEL_XL)}</td>
      <td><button class="pgo-btn ghost pgo-save" type="button"
        data-lv="${r.level}" data-a="${r.a}" data-d="${r.d}" data-s="${r.s}">저장</button></td>
    </tr>`).join('');

    $('rows').innerHTML = rows;
    $('resultCount').textContent = `${results.length}건`;
    $('truncated').innerHTML = results.length > MAX_ROWS
      ? `<div class="pgo-note" style="margin-top:.7rem">상위 ${MAX_ROWS}건만 표시했습니다. HP나 감정 등급을 입력해 범위를 좁혀 보세요.</div>`
      : '';
    $('resultPanel').hidden = false;
  }

  function run() {
    const p = picker.get();
    const targetCp = parseInt($('cp').value, 10);
    const hpRaw = $('hp').value.trim();
    const targetHp = hpRaw === '' ? null : parseInt(hpRaw, 10);

    if (!p) { $('summary').innerHTML = '<div class="pgo-panel"><div class="pgo-empty">포켓몬을 선택해 주세요.</div></div>'; return; }
    if (!targetCp) { $('summary').innerHTML = '<div class="pgo-panel"><div class="pgo-empty">CP를 입력해 주세요.</div></div>'; return; }

    current = p;
    const results = solve(p, targetCp, targetHp, $('grade').value, $('cap').value);
    renderSummary(p, results);
    if (results.length) renderRows(p, results);
    else $('resultPanel').hidden = true;
  }

  async function save(btn) {
    if (!current) return;
    const entry = {
      poke_key: current.k,
      nickname: '',
      cp: parseInt($('cp').value, 10) || null,
      hp: parseInt($('hp').value, 10) || null,
      level: Number(btn.dataset.lv),
      iv_atk: Number(btn.dataset.a),
      iv_def: Number(btn.dataset.d),
      iv_sta: Number(btn.dataset.s),
      memo: '',
    };
    btn.disabled = true;
    try {
      await window.PGOStore.add(entry);
      btn.textContent = '저장됨';
    } catch (err) {
      btn.disabled = false;
      alert(`저장하지 못했습니다: ${err.message}`);
    }
  }

  function render() {
    picker = UI.mountPicker($('mon'), {
      placeholder: '포켓몬 이름 또는 도감번호 (예: 괴력몬, 68)',
    });
    $('calc').addEventListener('click', run);
    $('rows').addEventListener('click', e => {
      const btn = e.target.closest('.pgo-save');
      if (btn) save(btn);
    });
    $('clear').addEventListener('click', () => {
      picker.clear(); $('cp').value = ''; $('hp').value = '';
      $('grade').value = ''; $('cap').value = '50';
      $('summary').innerHTML = '';
      $('resultPanel').hidden = true;
    });
    ['cp', 'hp'].forEach(id => $(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') run();
    }));
  }

  UI.boot(render);
})();
