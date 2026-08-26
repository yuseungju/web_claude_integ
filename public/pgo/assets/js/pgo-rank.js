/** 계열별 순위 페이지 — 등급/타입/세대로 나눠 강함 순위를 매긴다 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI;
  const $ = id => document.getElementById(id);

  const METRIC = {
    potential: { label: '보유 잠재력', get: p => p.potential.er, fmt: v => v.toFixed(1) },
    er:   { label: '종합 ER', get: p => p.rating.er,   fmt: v => v.toFixed(1) },
    dps:  { label: 'DPS',     get: p => p.rating.dps,  fmt: v => v.toFixed(1) },
    bulk: { label: '내구',    get: p => p.rating.bulk, fmt: v => Math.round(v) },
    tdo:  { label: 'TDO',     get: p => p.rating.tdo,  fmt: v => Math.round(v) },
  };

  /** 계열 축 정의 — 값 목록과 소속 판정 */
  const AXIS = {
    class: {
      label: '등급',
      options: () => P.CLASSES.map(c => ({ v: String(c.id), ko: c.ko })),
      match: (p, v) => p.c === Number(v),
    },
    type: {
      label: '타입',
      options: () => P.types.map(t => ({ v: String(t.id), ko: `${t.ko} 타입` })),
      match: (p, v) => p.t.includes(Number(v)),
    },
    gen: {
      label: '세대',
      options: () => [...new Set(P.pokemon.map(p => p.g))].sort((a, b) => a - b)
        .map(g => ({ v: String(g), ko: `${g}세대` })),
      match: (p, v) => p.g === Number(v),
    },
    all: {
      label: '전체',
      options: () => [{ v: '', ko: '전체 포켓몬' }],
      match: () => true,
    },
  };

  /** 현재 필터를 적용한 후보 목록 */
  function pool() {
    const axis = AXIS[$('axis').value];
    const group = $('group').value;
    const megaOff = $('megaOff').checked;
    const formOff = $('formOff').checked;

    return P.pokemon.filter(p => {
      if (!p.r) return false;                       // 미출시 폼 제외
      if (megaOff && p.c === 4) return false;
      if (formOff && p.f) return false;
      return axis.match(p, group);
    });
  }

  function groupLabel() {
    const axis = AXIS[$('axis').value];
    const opt = axis.options().find(o => o.v === $('group').value);
    return opt ? opt.ko : axis.label;
  }

  /** 등급별 최상위 요약 카드 */
  function renderTiers(list) {
    const byClass = new Map();
    list.forEach(p => {
      const cur = byClass.get(p.c);
      if (!cur || p.rating.er > cur.rating.er) byClass.set(p.c, p);
    });

    const cells = P.CLASSES
      .filter(c => byClass.has(c.id))
      .map(c => {
        const p = byClass.get(c.id);
        return `<button class="pgo-tier-cell" data-idx="${p.idx}">
          <span class="pgo-tier-label" style="color:${c.color}">${c.ko} 1위</span>
          ${UI.imgTag(p, 'pgo-tier-img')}
          <span class="pgo-tier-name">${UI.esc(p.n)}</span>
          <span class="pgo-tier-er">ER ${p.rating.er.toFixed(1)}</span>
        </button>`;
      }).join('');

    $('tierGrid').innerHTML = cells || '<div class="pgo-empty">해당 계열에 포켓몬이 없습니다.</div>';
    $('tierPanel').hidden = !cells;
  }

  function render() {
    const list = pool();
    const metric = METRIC[$('metric').value];
    const desc = $('dir').value === 'top';
    const limit = Number($('limit').value);

    $('groupCount').textContent = `${groupLabel()} · ${list.length.toLocaleString('ko-KR')}종`;
    renderTiers(list);

    // 계열 내 순위는 항상 좋은 순으로 매기고, 보기 방향만 뒤집는다
    const ranked = [...list].sort((a, b) => metric.get(b) - metric.get(a))
      .map((p, i) => ({ p, rank: i + 1 }));
    const view = desc ? ranked : [...ranked].reverse();
    const rows = limit ? view.slice(0, limit) : view;

    $('metricHead').textContent = metric.label;
    $('rankTitle').textContent =
      `${groupLabel()} — ${metric.label} ${desc ? '상위' : '하위'} ${limit ? `${Math.min(limit, rows.length)}종` : '전체'}`;

    if (!rows.length) {
      $('rankRows').innerHTML = '<tr><td colspan="9" class="pgo-empty">조건에 맞는 포켓몬이 없습니다.</td></tr>';
      return;
    }

    $('rankRows').innerHTML = rows.map(({ p, rank }) => {
      const r = p.rating;
      // metric 은 상위 스코프에서 이미 선택돼 있다
      const moves = r.fast && r.charged ? `${UI.esc(r.fast.n)} + ${UI.esc(r.charged.n)}` : '—';
      const t = P.tier(p);
      return `<tr data-idx="${p.idx}" style="cursor:pointer">
        <td class="num">${UI.rankBadge(rank, ranked.length)}</td>
        <td><span class="pgo-tier-tag t${t.id}">${UI.esc(t.ko)}</span></td>
        <td>
          <span style="display:inline-flex;align-items:center;gap:.45rem">
            ${UI.imgTag(p, 'pgo-row-img')}<b>${UI.esc(p.n)}</b>
          </span>
        </td>
        <td>${p.t.map(UI.typeBadge).join(' ')}</td>
        <td>${UI.classBadge(p.c) || '<span class="pgo-badge">일반</span>'}</td>
        <td class="num">${p.go.atk} / ${p.go.def} / ${p.go.sta}</td>
        <td class="num">${r.dps.toFixed(1)}</td>
        <td class="num"><b>${metric.fmt(metric.get(p))}</b></td>
        <td class="pgo-rank-line">${UI.esc(UI.reviewLine(p))}<br><span>${moves}</span></td>
      </tr>`;
    }).join('');
  }

  function fillGroups() {
    const axis = AXIS[$('axis').value];
    const opts = axis.options();
    $('group').innerHTML = opts.map(o => `<option value="${o.v}">${UI.esc(o.ko)}</option>`).join('');
    $('group').disabled = opts.length <= 1;
  }

  function boot() {
    fillGroups();

    $('axis').addEventListener('change', () => { fillGroups(); render(); });
    ['group', 'metric', 'dir', 'limit'].forEach(id => $(id).addEventListener('change', render));
    ['megaOff', 'formOff'].forEach(id => $(id).addEventListener('change', render));

    $('rankRows').addEventListener('click', e => {
      const tr = e.target.closest('tr[data-idx]');
      if (tr) UI.openDetail(UI.byId(tr.dataset.idx));
    });
    $('tierGrid').addEventListener('click', e => {
      const cell = e.target.closest('.pgo-tier-cell');
      if (cell) UI.openDetail(UI.byId(cell.dataset.idx));
    });

    render();
  }

  UI.boot(boot);
})();
