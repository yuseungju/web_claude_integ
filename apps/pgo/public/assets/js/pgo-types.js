/**
 * 타입 상성 페이지
 *  1) 타입 하나 골라 보기 — 때릴 때 / 맞을 때 어디에 유리한지 문장으로
 *  2) 복합 타입 계산기
 *  3) 전체 상성표 (세로 = 공격, 가로 = 방어. 열 이름은 가로로 읽는다)
 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI;
  const $ = id => document.getElementById(id);
  const names = ids => ids.map(P.typeName).join(' · ');

  let picked = null;

  /** 공격 타입 하나가 상대별로 내는 배율 */
  function attackProfile(atkId) {
    const out = { super: [], normal: [], resist: [], double: [] };
    P.types.forEach(t => {
      const m = P.db.chart[atkId][t.id];
      if (m > 1.01) out.super.push(t.id);
      else if (m < 0.4) out.double.push(t.id);
      else if (m < 0.99) out.resist.push(t.id);
      else out.normal.push(t.id);
    });
    return out;
  }

  /** 방어 타입 하나가 공격별로 받는 배율 */
  function defendProfile(defId) {
    const out = { weak: [], normal: [], resist: [], double: [] };
    P.types.forEach(t => {
      const m = P.db.chart[t.id][defId];
      if (m > 1.01) out.weak.push(t.id);
      else if (m < 0.4) out.double.push(t.id);
      else if (m < 0.99) out.resist.push(t.id);
      else out.normal.push(t.id);
    });
    return out;
  }

  const badges = ids => ids.length
    ? `<div class="pgo-eff-list">${ids.map(UI.typeBadge).join('')}</div>`
    : '<div style="color:var(--pgo-text-mute);font-size:.78rem">없음</div>';

  function renderTypePicker() {
    $('typePicker').innerHTML = P.types.map(t =>
      `<button class="pgo-type-btn${picked === t.id ? ' on' : ''}" data-t="${t.id}"
        style="background:${P.typeColor(t.id)}">${UI.esc(t.ko)}</button>`).join('');
  }

  function renderTypeDetail() {
    if (!picked) {
      $('typeDetail').innerHTML = '<div class="pgo-empty">위에서 타입을 하나 고르세요.</div>';
      return;
    }
    const ko = P.typeName(picked);
    const atk = attackProfile(picked);
    const def = defendProfile(picked);

    // 한 줄 요약
    const sumAtk = atk.super.length
      ? `<b>${UI.esc(ko)}</b> 공격은 <b class="good">${UI.esc(names(atk.super))}</b>에게 잘 통하고, `
        + `${atk.resist.concat(atk.double).length ? `<b class="bad">${UI.esc(names(atk.resist.concat(atk.double)))}</b>에게는 잘 안 통합니다.` : '특별히 막히는 타입은 없습니다.'}`
      : `<b>${UI.esc(ko)}</b> 공격은 유리하게 들어가는 타입이 없습니다.`;
    const sumDef = def.weak.length
      ? `맞을 때는 <b class="bad">${UI.esc(names(def.weak))}</b> 공격이 아프고, `
        + `${def.resist.concat(def.double).length ? `<b class="good">${UI.esc(names(def.resist.concat(def.double)))}</b> 공격은 잘 버팁니다.` : '특별히 잘 버티는 공격은 없습니다.'}`
      : `맞을 때 약점이 되는 타입이 없습니다.`;

    $('typeDetail').innerHTML = `
      <div class="pgo-type-summary">${sumAtk}<br>${sumDef}</div>
      <div class="pgo-type-cols">
        <div class="pgo-type-col">
          <div class="pgo-type-col-head atk">⚔ ${UI.esc(ko)}(으)로 때릴 때</div>
          <div class="pgo-type-row good">
            <span class="pgo-type-row-k">유리 <span class="pgo-mult x160">1.6x</span></span>
            ${badges(atk.super)}
          </div>
          <div class="pgo-type-row bad">
            <span class="pgo-type-row-k">불리 <span class="pgo-mult x063">0.625x</span></span>
            ${badges(atk.resist)}
          </div>
          <div class="pgo-type-row bad">
            <span class="pgo-type-row-k">거의 안 통함 <span class="pgo-mult x039">0.39x</span></span>
            ${badges(atk.double)}
          </div>
        </div>
        <div class="pgo-type-col">
          <div class="pgo-type-col-head def">🛡 ${UI.esc(ko)}(이)가 맞을 때</div>
          <div class="pgo-type-row bad">
            <span class="pgo-type-row-k">약점 <span class="pgo-mult x160">1.6x</span></span>
            ${badges(def.weak)}
          </div>
          <div class="pgo-type-row good">
            <span class="pgo-type-row-k">저항 <span class="pgo-mult x063">0.625x</span></span>
            ${badges(def.resist)}
          </div>
          <div class="pgo-type-row good">
            <span class="pgo-type-row-k">거의 안 아픔 <span class="pgo-mult x039">0.39x</span></span>
            ${badges(def.double)}
          </div>
        </div>
      </div>`;
  }

  // ── 전체 상성표 (열 이름 가로) ───────────────────────────────
  function renderMatrix() {
    const types = P.types;
    const head = `<thead><tr>
      <th class="corner"><span>공격 \\ 방어</span></th>
      ${types.map(t => `<th class="colhead" data-col="${t.id}">
        <span class="pgo-type" style="background:${P.typeColor(t.id)}">${UI.esc(t.ko)}</span>
      </th>`).join('')}
    </tr></thead>`;

    const body = `<tbody>${types.map(atk => `<tr data-row="${atk.id}">
      <th class="rowhead">
        <span class="pgo-type" style="background:${P.typeColor(atk.id)}">${UI.esc(atk.ko)}</span>
      </th>
      ${types.map(def => {
        const m = P.db.chart[atk.id][def.id];
        return `<td class="c pgo-mult ${UI.multClass(m)}" data-m="${m}"
          data-a="${atk.id}" data-d="${def.id}">${UI.multText(m)}</td>`;
      }).join('')}
    </tr>`).join('')}</tbody>`;

    $('matrix').innerHTML = head + body;
  }

  function describeCell(a, d, m) {
    const A = P.typeName(a), D = P.typeName(d);
    if (m > 1.01) return `<b class="good">${A}</b> 공격이 <b>${D}</b>에게 <b class="good">${UI.multText(m)}</b> — <b>때리는 쪽(${A})이 유리</b>합니다.`;
    if (m < 0.4) return `<b>${A}</b> 공격이 <b class="good">${D}</b>에게 <b class="bad">${UI.multText(m)}</b> — <b>맞는 쪽(${D})이 크게 유리</b>합니다. 거의 안 통합니다.`;
    if (m < 0.99) return `<b>${A}</b> 공격이 <b class="good">${D}</b>에게 <b class="bad">${UI.multText(m)}</b> — <b>맞는 쪽(${D})이 유리</b>합니다.`;
    return `<b>${A}</b> 공격이 <b>${D}</b>에게 <b>1x</b> — 어느 쪽도 유리하지 않습니다.`;
  }

  // ── 복합 타입 계산기 ─────────────────────────────────────────
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
    const label = m => m > 1
      ? '<span class="bad">이 공격에 아픕니다 — 공격 쪽 유리</span>'
      : m < 1 ? '<span class="good">이 공격은 잘 버팁니다 — 방어 쪽 유리</span>'
      : '어느 쪽도 유리하지 않습니다';

    const weak = sorted.filter(([m]) => m > 1).flatMap(([, l]) => l);
    const strong = sorted.filter(([m]) => m < 1).flatMap(([, l]) => l);

    out.innerHTML = `
      <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
        <span style="font-size:.8rem;color:var(--pgo-text-dim)">방어 타입:</span>
        ${ids.map(UI.typeBadge).join('')}
      </div>
      <div class="pgo-type-summary">
        ${weak.length ? `<b class="bad">${UI.esc(names(weak))}</b> 공격에 약합니다.` : '약점이 없습니다.'}
        ${strong.length ? ` <b class="good">${UI.esc(names(strong))}</b> 공격은 잘 버팁니다.` : ''}
      </div>
      ${sorted.map(([m, list]) => `
        <div>
          <div class="pgo-section-title">
            ${UI.multHtml(m)} <span style="font-weight:400">${label(m)}</span>
          </div>
          <div class="pgo-eff-list">${list.map(UI.typeBadge).join('')}</div>
        </div>`).join('')}`;
  }

  function render() {
    UI.fillTypeSelect($('t1'), '— 선택 —');
    UI.fillTypeSelect($('t2'), '— 없음 —');
    $('t1').addEventListener('change', renderCalc);
    $('t2').addEventListener('change', renderCalc);

    renderTypePicker();
    renderTypeDetail();
    renderCalc();
    renderMatrix();

    $('typePicker').addEventListener('click', e => {
      const btn = e.target.closest('.pgo-type-btn');
      if (!btn) return;
      picked = Number(btn.dataset.t);
      renderTypePicker();
      renderTypeDetail();
    });

    // 칸을 짚으면 어느 쪽이 유리한지 문장으로
    const matrix = $('matrix');
    const hint = $('cellHint');
    const highlight = td => {
      matrix.querySelectorAll('.hl').forEach(el => el.classList.remove('hl'));
      if (!td) return;
      td.classList.add('hl');
      const tr = td.closest('tr');
      tr.querySelector('.rowhead').classList.add('hl');
      const idx = [...tr.children].indexOf(td);
      const col = matrix.querySelector(`thead tr`).children[idx];
      if (col) col.classList.add('hl');
    };
    const onCell = e => {
      const td = e.target.closest('td.c');
      if (!td) return;
      highlight(td);
      hint.innerHTML = describeCell(Number(td.dataset.a), Number(td.dataset.d), Number(td.dataset.m));
    };
    matrix.addEventListener('mouseover', onCell);
    matrix.addEventListener('click', onCell);
    matrix.addEventListener('mouseleave', () => highlight(null));

    // 기본으로 격투를 띄워 사용법이 바로 보이게
    const seed = P.types.find(t => t.ko === '격투') || P.types[0];
    if (seed) { picked = seed.id; renderTypePicker(); renderTypeDetail(); }
  }

  UI.boot(render);
})();
