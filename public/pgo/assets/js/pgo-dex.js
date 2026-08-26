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

    filtered = P.pokemon.filter(p => {
      if (!els.unreleased.checked && !p.r) return false;
      if (!P.matches(p, q)) return false;
      if (type && !p.t.includes(type)) return false;
      if (gen && p.g !== gen) return false;
      if (cls !== '' && p.c !== Number(cls)) return false;
      if (form === 'base' && p.f) return false;
      if (form === 'only' && !p.f) return false;
      return true;
    });

    filtered.sort(SORTERS[els.sort.value] || SORTERS.rank);

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

  function render() {
    ['q', 'type1', 'gen', 'cls', 'form', 'sort', 'count', 'grid', 'more', 'reset', 'unreleased']
      .forEach(id => { els[id] = $(id); });

    UI.fillTypeSelect(els.type1);

    els.cls.insertAdjacentHTML('beforeend', P.CLASSES
      .map(c => `<option value="${c.id}">${c.ko}</option>`).join(''));

    const gens = [...new Set(P.pokemon.map(p => p.g))].sort((a, b) => a - b);
    els.gen.insertAdjacentHTML('beforeend',
      gens.map(g => `<option value="${g}">${g}세대</option>`).join(''));

    let timer;
    els.q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(apply, 180);
    });
    ['type1', 'gen', 'cls', 'form', 'sort'].forEach(id => els[id].addEventListener('change', apply));
    els.unreleased.addEventListener('change', apply);

    els.reset.addEventListener('click', () => {
      els.q.value = '';
      els.type1.value = '';
      els.gen.value = '';
      els.cls.value = '';
      els.form.value = 'all';
      els.sort.value = 'rank';
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
