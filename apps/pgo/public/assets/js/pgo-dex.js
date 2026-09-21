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

  /** 등급 라디오에서 고른 값 — '' 전체 / keep 보유 이상 / drop 버림 */
  function tierPick() {
    const on = els.tierRadios.querySelector('input[name="tierPick"]:checked');
    return on ? on.value : '';
  }

  function apply() {
    const q = els.q.value;
    const pick = tierPick();
    const worst = P.TIERS[P.TIERS.length - 1].id;

    // 타입·세대·계열·폼은 거르지 않는다. 이름으로 찾고 등급으로만 좁힌다.
    filtered = P.pokemon.filter(p => {
      if (!p.r) return false;                            // 미출시 폼은 등급이 의미 없다
      if (!P.matches(p, q)) return false;
      if (pick === 'keep' && p.tier > 1) return false;    // 보유 이상 = 필수 보유 + 보유
      if (pick === 'drop' && p.tier !== worst) return false;
      return true;
    });

    filtered.sort(SORTERS.tier);                          // 항상 잠재 순위 순

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
    const simple = els.simple.checked;
    els.grid.classList.toggle('simple', simple);
    els.grid.insertAdjacentHTML('beforeend', slice.map(simple ? UI.rowCard : UI.card).join(''));
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

    // 미출시 폼은 등급이 의미 없으므로 뺀다
    const hits = P.pokemon.filter(p => p.r && P.matches(p, query)).slice(0, 8);

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
    ['q', 'count', 'grid', 'more', 'reset', 'simple', 'qHints', 'tierRadios']
      .forEach(id => { els[id] = $(id); });

    // 등급 범례 — 각 등급의 뜻과 해당 종 수
    const counts = {};
    P.pokemon.filter(p => p.r).forEach(p => { counts[p.tier] = (counts[p.tier] || 0) + 1; });
    $('tierLegend').innerHTML = P.TIERS.map(t =>
      `<span class="pgo-chip" style="gap:.4rem">
         <span class="pgo-tier-tag t${t.id}">${t.ko}</span>
         <span style="color:var(--pgo-text-mute)">${t.desc} · ${counts[t.id] || 0}종</span>
       </span>`).join('');

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
    els.tierRadios.addEventListener('change', apply);
    els.simple.addEventListener('change', apply);

    els.reset.addEventListener('click', () => {
      els.q.value = '';
      if (els.qHints) els.qHints.hidden = true;
      els.tierRadios.querySelector('input[value=""]').checked = true;
      apply();
    });

    els.more.addEventListener('click', renderMore);

    els.grid.addEventListener('click', e => {
      const btn = e.target.closest('.pgo-card, .pgo-row');
      if (btn) UI.openDetail(UI.byId(btn.dataset.idx));
    });

    apply();
  }

  UI.boot(render);
})();
