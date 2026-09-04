/** 카운터 분석 — 상대 타입 약점 + 상성/공격력/내구 종합 랭킹 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI;
  const $ = id => document.getElementById(id);
  const STAB = 1.2;
  let picker = null;

  function candidatePool(mode) {
    if (mode === 'base') return P.pokemon.filter(p => p.r && !p.f);
    if (mode === 'nomega') return P.pokemon.filter(p => p.r && p.c !== 4);
    return P.pokemon.filter(p => p.r);
  }

  function score(attacker, target) {
    const atkMult = P.bestStab(attacker.t, target.t);        // 공격자 자속 -> 상대
    const hitMult = P.bestStab(target.t, attacker.t);        // 상대 자속 -> 공격자
    const effAtk = attacker.go.atk * atkMult * STAB;
    const bulk = Math.sqrt(attacker.go.def * attacker.go.sta);
    return {
      p: attacker,
      atkMult,
      hitMult,
      effAtk,
      bulk,
      raw: Math.pow(effAtk, 0.75) * Math.pow(bulk / hitMult, 0.25),
    };
  }

  function renderTarget(target) {
    $('targetInfo').innerHTML = `<div class="pgo-panel">
      <div style="display:flex;gap:.9rem;align-items:center;margin-bottom:.9rem;flex-wrap:wrap">
        ${UI.imgTag(target, '')}
        <div>
          <div style="font-size:1.05rem;font-weight:800">${UI.esc(P.displayName(target))}</div>
          <div style="display:flex;gap:.3rem;align-items:center;margin-top:.3rem;flex-wrap:wrap">
            <span class="pgo-card-dex">#${String(target.d).padStart(4, '0')}</span>
            ${target.t.map(UI.typeBadge).join('')}
            ${UI.classBadge(target.c)}
          </div>
        </div>
        <div class="pgo-kv" style="flex:1;min-width:260px">
          <div class="pgo-kv-item"><span class="pgo-kv-k">공격</span><span class="pgo-kv-v">${target.go.atk}</span></div>
          <div class="pgo-kv-item"><span class="pgo-kv-k">방어</span><span class="pgo-kv-v">${target.go.def}</span></div>
          <div class="pgo-kv-item"><span class="pgo-kv-k">체력</span><span class="pgo-kv-v">${target.go.sta}</span></div>
        </div>
      </div>
      <div style="display:grid;gap:.9rem">${UI.defenseSummary(target)}</div>
    </div>`;
  }

  function renderCounters(target) {
    const pool = candidatePool($('pool').value).filter(p => p.idx !== target.idx);
    const topN = Number($('topn').value);

    const ranked = pool.map(p => score(p, target))
      .filter(r => r.atkMult > 1)          // 상대에게 반감되는 조합은 카운터로 보지 않는다
      .sort((a, b) => b.raw - a.raw)
      .slice(0, topN);

    if (!ranked.length) {
      $('counterRows').innerHTML = '<tr><td colspan="8" class="pgo-empty">약점을 찌를 수 있는 후보가 없습니다.</td></tr>';
      $('counterPanel').hidden = false;
      return;
    }

    const top = ranked[0].raw;
    $('counterRows').innerHTML = ranked.map((r, i) => `<tr data-idx="${r.p.idx}" style="cursor:pointer">
      <td class="num">${i + 1}</td>
      <td>${UI.esc(P.displayName(r.p))}</td>
      <td>${r.p.t.map(UI.typeBadge).join(' ')}</td>
      <td class="num">${UI.multHtml(r.atkMult)}</td>
      <td class="num">${Math.round(r.effAtk)}</td>
      <td class="num">${UI.multHtml(r.hitMult)}</td>
      <td class="num">${Math.round(r.bulk)}</td>
      <td class="num"><b>${(r.raw / top * 100).toFixed(1)}</b></td>
    </tr>`).join('');

    $('counterPanel').hidden = false;
  }

  function update() {
    const target = picker.get();
    if (!target) {
      $('targetInfo').innerHTML = '<div class="pgo-panel"><div class="pgo-empty">상대 포켓몬을 선택하세요.</div></div>';
      $('counterPanel').hidden = true;
      return;
    }
    renderTarget(target);
    renderCounters(target);
  }

  function render() {
    picker = UI.mountPicker($('target'), {
      placeholder: '상대 포켓몬 이름 또는 도감번호 (예: 뮤츠, 150)',
      onSelect: update,
    });
    ['pool', 'topn'].forEach(id => $(id).addEventListener('change', update));

    $('counterRows').addEventListener('click', e => {
      const tr = e.target.closest('tr[data-idx]');
      if (tr) UI.openDetail(UI.byId(tr.dataset.idx));
    });

    // 기본값: 초기 화면이 비지 않도록 대표 레이드 보스(뮤츠)를 띄운다
    const seed = P.pokemon.find(p => p.k === 'MEWTWO');
    if (seed) picker.set(seed);
    else update();
  }

  UI.boot(render);
})();
