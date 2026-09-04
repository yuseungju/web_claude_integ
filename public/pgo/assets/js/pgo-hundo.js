/**
 * 4성(100% 개체) 판별 — CP 로 개체값 15/15/15 여부를 가린다.
 *
 * 핵심: 어떤 레벨에서든 개체값 15/15/15 일 때의 CP 가 그 레벨에서 나올 수 있는
 * 최댓값이다. 따라서 레이드·알처럼 조우 레벨이 고정된 경우, CP 가 그 값과 정확히
 * 같으면 개체값은 15/15/15 밖에 될 수 없다 → 확정 판정.
 * 야생은 레벨을 모르므로 여러 레벨 중 어디에 해당하는지, 같은 CP 를 만드는 다른
 * 조합이 몇 개나 되는지까지 계산해서 알려준다.
 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI;
  const $ = id => document.getElementById(id);
  const PAGE = 40;

  /**
   * 조우 경로별 레벨.
   * fixed: 레벨이 하나로 정해져 CP만으로 확정 판정이 가능한 경로
   * range: 야생처럼 레벨 폭이 있는 경로
   */
  const SOURCES = [
    { id: 'raid',     ko: '레이드 · 알 부화 · 전설 조우', fixed: [20], ivMin: 10,
      note: '레이드 보스와 알에서 나온 포켓몬은 항상 레벨 20이고, 개체값이 10 미만으로 나오지 않습니다.' },
    { id: 'raidboost', ko: '레이드 · 알 (날씨 부스트)', fixed: [25], ivMin: 10,
      note: '날씨 부스트를 받으면 레벨 25로 올라갑니다.' },
    { id: 'research', ko: '필드 리서치 · 리서치 브레이크스루', fixed: [15], ivMin: 0,
      note: '리서치 보상 조우는 레벨 15 고정입니다.' },
    { id: 'rocket',   ko: '로켓단 그림자 포켓몬', fixed: [8], ivMin: 0,
      note: '로켓단에게서 구출한 그림자 포켓몬은 레벨 8입니다.' },
    { id: 'wild',     ko: '야생 (레벨 1~30)', range: [1, 30], ivMin: 0,
      note: '야생은 레벨이 정해져 있지 않아 CP만으로는 확정할 수 없습니다. HP를 함께 넣으면 범위가 크게 줄어듭니다.' },
    { id: 'wildboost', ko: '야생 (날씨 부스트, 레벨 6~35)', range: [6, 35], ivMin: 0,
      note: '날씨 부스트를 받은 야생은 레벨 6~35에서 나옵니다.' },
    { id: 'any',      ko: '모르겠음 (레벨 1~50 전부)', range: [1, 50], ivMin: 0,
      note: '레벨을 모르면 후보가 많아집니다. 어디서 얻었는지 고르면 훨씬 정확해집니다.' },
  ];
  const SRC = {};
  SOURCES.forEach(s => { SRC[s.id] = s; });

  /** 표에 쓰는 대표 조우 레벨 */
  const CHART = [
    { ko: '레이드 · 알 부화', lv: 20 },
    { ko: '레이드 · 알 (날씨 부스트)', lv: 25 },
    { ko: '필드 리서치 · 브레이크스루', lv: 15 },
    { ko: '로켓단 그림자', lv: 8 },
    { ko: '야생 최대 (부스트 없음)', lv: 30 },
    { ko: '야생 최대 (날씨 부스트)', lv: 35 },
    { ko: '파워업 상한 (일반)', lv: 40 },
    { ko: '파워업 상한 (XL사탕)', lv: 50 },
  ];

  const PERFECT = { a: 15, d: 15, s: 15 };
  const ZERO = { a: 0, d: 0, s: 0 };
  const levelsOf = src => (src.fixed
    ? src.fixed
    : P.LEVELS.filter(l => l >= src.range[0] && l <= src.range[1]));

  // ── 판별 ────────────────────────────────────────────────────
  function judge(p, targetCp, targetHp, src) {
    const levels = levelsOf(src);
    // 이 경로에서 100% 가 되는 레벨들
    const hits = levels.filter(l => P.cp(p.go, PERFECT, l) === targetCp
      && (targetHp == null || P.hp(p.go, PERFECT, l) === targetHp));
    const combos = P.solveIV(p, targetCp, targetHp, levels, src.ivMin);
    const perfect = combos.filter(c => c.total === 45);
    const best = combos[0] || null;
    return { hits, combos, perfect, best, levels };
  }

  function renderVerdict(p, targetCp, targetHp, src) {
    const r = judge(p, targetCp, targetHp, src);
    const box = $('verdict');

    if (!r.combos.length) {
      // 그 CP 자체가 이 경로에서 나올 수 없는 값
      const range = r.levels.map(l => P.cp(p.go, ZERO, l)).filter(Boolean);
      const maxes = r.levels.map(l => P.cp(p.go, PERFECT, l));
      box.innerHTML = `<div class="pgo-panel pgo-judge miss">
        <div class="pgo-judge-head"><span class="pgo-judge-mark">✕</span>
          <div><div class="pgo-judge-title">이 경로에서는 나올 수 없는 CP입니다</div>
          <div class="pgo-judge-sub">${UI.esc(P.displayName(p))} · ${UI.esc(src.ko)}</div></div></div>
        <div class="pgo-note">이 경로에서 가능한 CP는 <b>${Math.min(...range)} ~ ${Math.max(...maxes)}</b> 범위입니다.
        조우 경로를 잘못 고르셨거나 CP를 잘못 입력하셨을 수 있습니다.</div>
      </div>`;
      return;
    }

    const pct = t => Math.round(t / 45 * 100);
    const isFixed = !!src.fixed;
    let cls, mark, title, sub;

    if (r.perfect.length && r.combos.length === 1) {
      cls = 'hit'; mark = '★';
      title = '100% 확정입니다 — 4성 개체';
      sub = `레벨 ${r.perfect[0].level} · 개체값 15/15/15. 이 CP는 다른 개체값으로는 나올 수 없습니다.`;
    } else if (r.perfect.length) {
      cls = 'maybe'; mark = '?';
      title = `100%일 수 있습니다 — 후보 ${r.combos.length}가지 중 하나`;
      sub = `레벨 ${r.perfect.map(c => c.level).join(' 또는 ')}이면 15/15/15입니다. `
        + (targetHp == null ? 'HP를 함께 넣으면 후보가 줄어듭니다.' : '감정(별 등급)으로 더 좁힐 수 있습니다.');
    } else {
      cls = 'no'; mark = '✕';
      title = '100%는 아닙니다';
      sub = `이 CP로 가능한 가장 높은 개체값은 ${r.best.a}/${r.best.d}/${r.best.s} (${pct(r.best.total)}%)입니다.`;
    }

    // 이 경로의 100% CP 안내
    const targets = r.levels
      .filter(l => isFixed || [1, 5, 10, 15, 20, 25, 30, 35].includes(l))
      .map(l => ({ lv: l, cp: P.cp(p.go, PERFECT, l), hp: P.hp(p.go, PERFECT, l) }));

    box.innerHTML = `<div class="pgo-panel pgo-judge ${cls}">
      <div class="pgo-judge-head">
        <span class="pgo-judge-mark">${mark}</span>
        <div>
          <div class="pgo-judge-title">${UI.esc(title)}</div>
          <div class="pgo-judge-sub">${UI.esc(P.displayName(p))} · CP ${targetCp}${targetHp != null ? ` · HP ${targetHp}` : ''} · ${UI.esc(src.ko)}</div>
        </div>
        ${UI.imgTag(p, 'pgo-judge-img')}
      </div>
      <div class="pgo-judge-body">${UI.esc(sub)}</div>

      <div class="pgo-kv" style="margin-top:.9rem">
        <div class="pgo-kv-item"><span class="pgo-kv-k">가능한 조합</span><span class="pgo-kv-v">${r.combos.length}</span></div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">개체값 범위</span><span class="pgo-kv-v">${pct(r.combos[r.combos.length - 1].total)}~${pct(r.best.total)}%</span></div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">100% 확률</span><span class="pgo-kv-v">${r.perfect.length ? `${Math.round(r.perfect.length / r.combos.length * 100)}%` : '0%'}</span></div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">50레벨 최대 CP</span><span class="pgo-kv-v">${p.maxCp}</span></div>
      </div>

      <div class="pgo-note" style="margin-top:.9rem">${UI.esc(src.note)}</div>

      <div class="pgo-section-title" style="margin-top:1rem">이 경로의 100% CP</div>
      <div class="pgo-hundo-targets">
        ${targets.map(t => `<span class="pgo-chip${t.cp === targetCp ? ' match' : ''}">
          <b>L${t.lv}</b> CP ${t.cp} <span style="color:var(--pgo-text-mute)">HP ${t.hp}</span>
        </span>`).join('')}
      </div>

      ${r.combos.length > 1 ? `
      <div class="pgo-section-title" style="margin-top:1rem">가능한 개체값 조합 (상위 12)</div>
      <div class="pgo-table-wrap">
        <table class="pgo-table">
          <thead><tr><th>레벨</th><th>공격</th><th>방어</th><th>체력</th><th>합계</th><th>%</th></tr></thead>
          <tbody>${r.combos.slice(0, 12).map(c => `<tr${c.total === 45 ? ' class="perfect"' : ''}>
            <td class="num">${c.level}</td><td class="num">${c.a}</td><td class="num">${c.d}</td>
            <td class="num">${c.s}</td><td class="num">${c.total}/45</td><td class="num">${pct(c.total)}%</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}
    </div>`;
  }

  function renderChart(p) {
    $('chartTitle').textContent = `${P.displayName(p)}의 100% CP 표`;
    $('chartRows').innerHTML = CHART.map(c => `<tr>
      <td>${UI.esc(c.ko)}</td>
      <td class="num">${c.lv}</td>
      <td class="num"><b>${P.cp(p.go, PERFECT, c.lv)}</b></td>
      <td class="num">${P.hp(p.go, PERFECT, c.lv)}</td>
      <td class="num">${P.cp(p.go, ZERO, c.lv)}</td>
    </tr>`).join('');
    $('chartPanel').hidden = false;
  }

  // ── 전체 표 ─────────────────────────────────────────────────
  let shown = PAGE;

  function tableList() {
    const q = $('q').value.trim();
    const rcp = parseInt($('rcp').value, 10);
    const tf = $('tierFilter').value;

    return P.pokemon.filter(p => {
      if (!p.r) return false;
      if (tf !== '' && p.tier !== Number(tf)) return false;
      if (q && !P.matches(p, q)) return false;
      if (rcp) {
        // 어느 조우 레벨에서든 그 CP가 100% CP 인 종만
        return CHART.some(c => P.cp(p.go, PERFECT, c.lv) === rcp);
      }
      return true;
    }).sort((a, b) => a.potentialRank - b.potentialRank);
  }

  function renderTable() {
    const list = tableList();
    const rcp = parseInt($('rcp').value, 10);
    $('tableCount').textContent = rcp
      ? `CP ${rcp}이 100%가 되는 포켓몬 ${list.length}종`
      : `${list.length.toLocaleString('ko-KR')}종`;

    const slice = list.slice(0, shown);
    $('tableRows').innerHTML = slice.length ? slice.map(p => {
      const t = P.tier(p);
      const cell = lv => {
        const v = P.cp(p.go, PERFECT, lv);
        return `<td class="num${rcp && v === rcp ? ' hit' : ''}">${v}</td>`;
      };
      return `<tr data-idx="${p.idx}" style="cursor:pointer">
        <td><span style="display:inline-flex;align-items:center;gap:.4rem">
          ${UI.imgTag(p, 'pgo-row-img')}<b>${UI.esc(p.n)}</b></span></td>
        <td><span class="pgo-tier-tag t${t.id}">${UI.esc(t.short)}</span></td>
        ${cell(20)}${cell(25)}${cell(15)}${cell(8)}${cell(30)}${cell(35)}${cell(40)}${cell(50)}
      </tr>`;
    }).join('') : '<tr><td colspan="10" class="pgo-empty">조건에 맞는 포켓몬이 없습니다.</td></tr>';

    $('tableMore').innerHTML = list.length > shown
      ? `<div style="text-align:center;margin-top:1rem"><button class="pgo-btn ghost" id="more" type="button">더 보기 (${list.length - shown}종 남음)</button></div>`
      : '';
    const more = $('more');
    if (more) more.addEventListener('click', () => { shown += PAGE; renderTable(); });
  }

  // ── 부트 ────────────────────────────────────────────────────
  function run() {
    const p = UI.byId($('mon').value);
    const targetCp = parseInt($('cp').value, 10);
    const hpRaw = $('hp').value.trim();
    const targetHp = hpRaw === '' ? null : parseInt(hpRaw, 10);
    const src = SRC[$('src').value] || SOURCES[0];

    if (!p) { $('verdict').innerHTML = '<div class="pgo-panel"><div class="pgo-empty">포켓몬을 선택해 주세요.</div></div>'; return; }
    renderChart(p);
    if (!targetCp) { $('verdict').innerHTML = '<div class="pgo-panel"><div class="pgo-empty">CP를 입력하면 판별합니다. 아래 표에서 이 포켓몬의 100% CP를 먼저 확인해 보세요.</div></div>'; return; }
    renderVerdict(p, targetCp, targetHp, src);
  }

  function render() {
    UI.fillPokemonSelect($('mon'));
    $('src').innerHTML = SOURCES.map(s => `<option value="${s.id}">${UI.esc(s.ko)}</option>`).join('');
    $('tierFilter').insertAdjacentHTML('beforeend',
      P.TIERS.map(t => `<option value="${t.id}">${t.ko}</option>`).join(''));

    $('check').addEventListener('click', run);
    $('mon').addEventListener('change', () => { const p = UI.byId($('mon').value); if (p) renderChart(p); });
    ['cp', 'hp'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') run(); }));
    $('clear').addEventListener('click', () => {
      $('mon').value = ''; $('cp').value = ''; $('hp').value = ''; $('src').value = 'raid';
      $('verdict').innerHTML = ''; $('chartPanel').hidden = true;
    });

    let timer;
    ['q', 'rcp'].forEach(id => $(id).addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { shown = PAGE; renderTable(); }, 200);
    }));
    $('tierFilter').addEventListener('change', () => { shown = PAGE; renderTable(); });

    $('tableRows').addEventListener('click', e => {
      const tr = e.target.closest('tr[data-idx]');
      if (tr) UI.openDetail(UI.byId(tr.dataset.idx));
    });

    renderTable();
  }

  UI.boot(render);
})();
