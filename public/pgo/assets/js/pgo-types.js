/** 타입 상성 페이지 — 복합 타입 계산기 + 18×18 전체 상성표 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI;
  const $ = id => document.getElementById(id);

  function renderMatrix() {
    const types = P.types;
    const head = `<thead><tr>
      <th></th>
      ${types.map(t => `<th class="pgo-vert" style="color:${P.typeColor(t.id)}">${UI.esc(t.ko)}</th>`).join('')}
    </tr></thead>`;

    const body = `<tbody>${types.map(def => `<tr>
      <th class="rowhead" style="color:${P.typeColor(def.id)}">${UI.esc(def.ko)}</th>
      ${types.map(atk => {
        const m = P.db.chart[atk.id][def.id];
        return `<td class="c pgo-mult ${UI.multClass(m)}" data-m="${m}">${UI.multText(m)}</td>`;
      }).join('')}
    </tr>`).join('')}</tbody>`;

    $('matrix').innerHTML = head + body;
  }

  function renderCalc() {
    const ids = [Number($('t1').value), Number($('t2').value)].filter(Boolean);
    const out = $('calcOut');

    if (!ids.length) {
      out.innerHTML = '<div class="pgo-empty" style="padding:1.2rem">방어 타입을 선택하세요.</div>';
      return;
    }
    if (ids.length === 2 && ids[0] === ids[1]) {
      out.innerHTML = '<div class="pgo-note">같은 타입을 두 번 선택했습니다. 두 번째 타입을 비워 두거나 다른 타입을 고르세요.</div>';
      return;
    }

    const prof = P.defenseProfile(ids);
    const buckets = new Map();
    Object.entries(prof).forEach(([id, m]) => {
      const key = Number(m.toFixed(6));
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(Number(id));
    });

    const sorted = [...buckets.entries()].sort((a, b) => b[0] - a[0]);
    const label = m => m > 1 ? '받는 피해 ↑' : m < 1 ? '받는 피해 ↓' : '등배';

    out.innerHTML = `
      <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
        <span style="font-size:.8rem;color:var(--pgo-text-dim)">방어 타입:</span>
        ${ids.map(UI.typeBadge).join('')}
      </div>
      ${sorted.map(([m, list]) => `
        <div>
          <div class="pgo-section-title">
            ${UI.multHtml(m)} <span style="font-weight:400;text-transform:none">${label(m)}</span>
          </div>
          <div class="pgo-eff-list">${list.map(UI.typeBadge).join('')}</div>
        </div>`).join('')}`;
  }

  function render() {
    UI.fillTypeSelect($('t1'), '— 선택 —');
    UI.fillTypeSelect($('t2'), '— 없음 —');
    $('t1').addEventListener('change', renderCalc);
    $('t2').addEventListener('change', renderCalc);
    renderCalc();
    renderMatrix();
  }

  UI.boot(render);
})();
