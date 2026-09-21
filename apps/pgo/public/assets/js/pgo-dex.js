/** 도감 페이지 — 검색/계열 필터/정렬 + 상세 모달. 카드에 계열별 순위를 함께 보여준다. */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI;
  const PAGE_SIZE = 60;

  const $ = id => document.getElementById(id);
  const els = {};
  let filtered = [];
  let shown = 0;

  const SORTERS = {
    tier:  (a, b) => (a.potentialRank || 1e9) - (b.potentialRank || 1e9),
    tierWorst: (a, b) => (b.potentialRank || 0) - (a.potentialRank || 0),
    rank:  (a, b) => (a.rank.overall || 1e9) - (b.rank.overall || 1e9),
    dps:   (a, b) => b.rating.dps - a.rating.dps,
    bulk:  (a, b) => b.rating.bulk - a.rating.bulk,
    dex:   (a, b) => a.d - b.d || a.c - b.c,
    maxCp: (a, b) => b.maxCp - a.maxCp,
    atk:   (a, b) => b.go.atk - a.go.atk,
    def:   (a, b) => b.go.def - a.go.def,
    sta:   (a, b) => b.go.sta - a.go.sta,
    name:  (a, b) => a.n.localeCompare(b.n, 'ko'),
    worst: (a, b) => (b.rank.overall || 0) - (a.rank.overall || 0),
  };

  function apply() {
    const q = els.q.value;
    const type = Number(els.type1.value) || 0;
    const gen = Number(els.gen.value) || 0;
    const cls = els.cls.value;
    const form = els.form.value;
    const tier = els.tier.value;

    filtered = P.pokemon.filter(p => {
      if (!els.unreleased.checked && !p.r) return false;
      if (!P.matches(p, q)) return false;
      if (type && !p.t.includes(type)) return false;
      if (gen && p.g !== gen) return false;
      if (cls !== '' && p.c !== Number(cls)) return false;
      if (tier === 'keep' && p.tier > 1) return false;          // 보유할 만한 것만
      else if (tier !== '' && tier !== 'keep' && p.tier !== Number(tier)) return false;
      if (form === 'base' && p.f) return false;
      if (form === 'only' && !p.f) return false;
      return true;
    });

    filtered.sort(SORTERS[els.sort.value] || SORTERS.tier);

    els.count.textContent = `${filtered.length.toLocaleString('ko-KR')}종`;
    shown = 0;
    els.grid.innerHTML = '';
    renderMore();
  }

  function renderMore() {
    const slice = filtered.slice(shown, shown + PAGE_SIZE);
    if (!slice.length && shown === 0) {
      els.grid.innerHTML = '<div class="pgo-empty" style="grid-column:1/-1">조건에 맞는 포켓몬이 없습니다.</div>';
    }
    els.grid.insertAdjacentHTML('beforeend', slice.map(UI.card).join(''));
    shown += slice.length;
    els.more.hidden = shown >= filtered.length;
    els.more.textContent = `더 보기 (${filtered.length - shown}종 남음)`;
  }

  /**
   * 검색창 바로 아래에 띄우는 빠른 결과.
   * 아래 그리드까지 내려가지 않고 이름 옆에서 바로 보유/버림을 보려는 것이다.
   * 누르면 그 포켓몬 상세가 열린다.
   */
  function renderHints(q) {
    const box = els.qHints;
    if (!box) return;

    const query = (q || '').trim();
    if (!query) { box.hidden = true; box.innerHTML = ''; return; }

    // 미출시 폼은 등급이 의미 없으므로 기본에서는 뺀다 (체크를 켜면 같이 본다)
    const pool = els.unreleased && els.unreleased.checked
      ? P.pokemon : P.pokemon.filter(p => p.r);
    const hits = pool.filter(p => P.matches(p, query)).slice(0, 8);

    if (!hits.length) {
      box.innerHTML = '<div class="pgo-qhint-empty">검색 결과가 없습니다</div>';
      box.hidden = false;
      return;
    }

    box.innerHTML = hits.map(p => {
      const t = P.tier(p);
      return `<button type="button" class="pgo-qhint" data-k="${UI.esc(p.k)}">
        ${UI.imgTag(p, 'pgo-qhint-img')}
        <span class="pgo-qhint-name">${UI.esc(p.n)}</span>
        <span class="pgo-qhint-dex">#${p.d}</span>
        <span class="pgo-tier-tag t${t.id}">${UI.esc(t.ko)}</span>
      </button>`;
    }).join('');
    box.hidden = false;
  }

  function render() {
    ['q', 'type1', 'gen', 'cls', 'form', 'sort', 'tier', 'count', 'grid', 'more', 'reset', 'unreleased', 'qHints']
      .forEach(id => { els[id] = $(id); });

    els.tier.insertAdjacentHTML('beforeend',
      '<option value="keep">보유할 것만 (S+A)</option>'
      + P.TIERS.map(t => `<option value="${t.id}">${t.ko}만</option>`).join(''));

    // 등급 범례 — 각 등급의 뜻과 해당 종 수
    const counts = {};
    P.pokemon.filter(p => p.r).forEach(p => { counts[p.tier] = (counts[p.tier] || 0) + 1; });
    $('tierLegend').innerHTML = P.TIERS.map(t =>
      `<span class="pgo-chip" style="gap:.4rem">
         <span class="pgo-tier-tag t${t.id}">${t.ko}</span>
         <span style="color:var(--pgo-text-mute)">${t.desc} · ${counts[t.id] || 0}종</span>
       </span>`).join('');

    UI.fillTypeSelect(els.type1);

    els.cls.insertAdjacentHTML('beforeend', P.CLASSES
      .map(c => `<option value="${c.id}">${c.ko}</option>`).join(''));

    const gens = [...new Set(P.pokemon.map(p => p.g))].sort((a, b) => a - b);
    els.gen.insertAdjacentHTML('beforeend',
      gens.map(g => `<option value="${g}">${g}세대</option>`).join(''));

    let timer;
    els.q.addEventListener('input', () => {
      renderHints(els.q.value);          // 힌트는 바로 (아래 그리드만 살짝 늦춘다)
      clearTimeout(timer);
      timer = setTimeout(apply, 180);
    });

    // 힌트를 누르면 그 포켓몬 상세를 연다.
    // 상자가 없는 페이지에서도 여기서 죽지 않도록 있을 때만 건다.
    if (els.qHints) els.qHints.addEventListener('click', e => {
      const btn = e.target.closest('.pgo-qhint');
      if (!btn) return;
      const p = P.pokemon.find(x => x.k === btn.dataset.k);
      if (p) UI.openDetail(p);
    });

    // 바깥을 누르거나 Esc 를 누르면 닫는다
    document.addEventListener('click', e => {
      if (els.qHints && !e.target.closest('.pgo-qwrap')) els.qHints.hidden = true;
    });
    els.q.addEventListener('keydown', e => {
      if (e.key === 'Escape' && els.qHints) els.qHints.hidden = true;
    });
    ['type1', 'gen', 'cls', 'form', 'sort', 'tier'].forEach(id => els[id].addEventListener('change', apply));
    els.unreleased.addEventListener('change', apply);

    els.reset.addEventListener('click', () => {
      els.q.value = '';
      if (els.qHints) els.qHints.hidden = true;
      els.type1.value = '';
      els.gen.value = '';
      els.cls.value = '';
      els.form.value = 'all';
      els.tier.value = '';
      els.sort.value = 'tier';
      els.unreleased.checked = false;
      apply();
    });

    els.more.addEventListener('click', renderMore);

    els.grid.addEventListener('click', e => {
      const btn = e.target.closest('.pgo-card');
      if (btn) UI.openDetail(UI.byId(btn.dataset.idx));
    });

    apply();
  }

  UI.boot(render);
})();
