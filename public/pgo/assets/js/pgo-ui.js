/**
 * PGO 공용 UI 헬퍼 — pgo-core.js 이후에 로드된다.
 * 렌더링에 쓰는 조각들만 모아둔다. 페이지별 로직은 각 pgo-*.js 에 있다.
 */
(function (global) {
  'use strict';

  const P = global.PGO;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /** 타입 배지 HTML */
  function typeBadge(id) {
    return `<span class="pgo-type" style="background:${P.typeColor(id)}">${esc(P.typeName(id))}</span>`;
  }

  /** 등급(계열) 배지 */
  function classBadge(c) {
    if (c === 0) return '';
    return `<span class="pgo-type" style="background:${P.classColor(c)};color:#141a29">${esc(P.className(c))}</span>`;
  }

  /** 배율 -> 표시 문자열 + 색상 클래스 */
  const MULT_CLASS = [
    [2.56, 'x256'], [1.6, 'x160'], [1, 'x100'],
    [0.625, 'x063'], [0.390625, 'x039'], [0, 'x015'],
  ];
  function multClass(m) {
    for (const [v, cls] of MULT_CLASS) if (m >= v - 1e-6) return cls;
    return 'x015';
  }
  function multText(m) {
    return `${Number(m.toFixed(3))}x`;
  }
  function multHtml(m) {
    return `<span class="pgo-mult ${multClass(m)}">${multText(m)}</span>`;
  }

  function imgTag(p, cls) {
    return `<img class="${cls}" loading="lazy" alt="${esc(P.displayName(p))}"
      src="${P.spriteUrl(p)}" onerror="this.style.visibility='hidden'">`;
  }

  /** 순위 배지 — 상위권일수록 강조 */
  function rankBadge(rank, total, label) {
    if (!rank) return `<span class="pgo-rank-badge none">순위 없음</span>`;
    const pct = total ? rank / total : 1;
    const tier = rank <= 10 ? 'top' : pct <= 0.1 ? 'high' : pct <= 0.4 ? 'mid' : pct <= 0.75 ? 'low' : 'bottom';
    return `<span class="pgo-rank-badge ${tier}">${label ? esc(label) + ' ' : ''}#${rank}${total ? `<i>/${total}</i>` : ''}</span>`;
  }

  /** 보유 판정 배너 — 카드에서 가장 먼저 읽히는 요소 */
  function tierBanner(p) {
    const t = P.tier(p);
    return `<div class="pgo-tier-banner t${t.id}">
      <span class="pgo-tier-word">${esc(t.ko)}</span>
      <span class="pgo-tier-mark">${esc(t.short)}</span>
    </div>`;
  }

  const review = p => (global.PGOReview ? global.PGOReview.of(p) : null);

  /** 카드용 한줄평 */
  function verdictLine(p) {
    const rv = review(p);
    return rv ? `<div class="pgo-card-line">${esc(rv.line)}</div>` : '';
  }

  /** 한줄평 원문 (표 등에서 직접 쓸 때) */
  function reviewLine(p) {
    const rv = review(p);
    return rv ? rv.line : '';
  }

  /** 모달용 전체 평가 리뷰 */
  function reviewBlock(p) {
    const rv = review(p);
    if (!rv) return '';
    const list = (items, cls, mark) => items.length
      ? `<ul class="pgo-review-list ${cls}">${items.map(x => `<li><span>${mark}</span><span>${x}</span></li>`).join('')}</ul>`
      : '';
    return `<div>
      <div class="pgo-section-title">평가 리뷰</div>
      <div class="pgo-review-line">${esc(rv.line)}</div>
      ${list(rv.pros, 'pro', '＋')}
      ${list(rv.cons, 'con', '－')}
      ${rv.notes.map(n => `<div class="pgo-note" style="margin-top:.55rem">${n}</div>`).join('')}
    </div>`;
  }

  /** 진화형 기준으로 판정된 경우 그 근거를 한 줄로 보여준다 */
  function inheritedNote(p) {
    if (!p.potential || !p.potential.inherited) return '';
    return `<div class="pgo-card-basis">→ ${esc(P.displayName(p.potential.src))} 기준</div>`;
  }

  /** 포켓몬 카드 (버튼) */
  function card(p) {
    const t = P.tier(p);
    return `<button class="pgo-card tier-${t.id}" data-idx="${p.idx}">
      ${tierBanner(p)}
      <div class="pgo-card-body">
        <div class="pgo-card-top">
          ${imgTag(p, 'pgo-card-img')}
          <div style="min-width:0">
            <span class="pgo-card-dex">#${String(p.d).padStart(4, '0')}</span>
            <div class="pgo-card-name">${esc(p.n)}</div>
            <div class="pgo-card-types">${p.t.map(typeBadge).join('')}${classBadge(p.c)}</div>
          </div>
        </div>
        ${verdictLine(p)}
        ${inheritedNote(p)}
        <div class="pgo-card-ranks">
          ${rankBadge(p.potentialRank, P.totals.potential, '잠재')}
          ${rankBadge(p.rank.classRank, p.rank.classTotal, P.className(p.c))}
        </div>
        <div class="pgo-card-stats">
          <div><span class="pgo-stat-k">공격</span><span class="pgo-stat-v">${p.go.atk}</span></div>
          <div><span class="pgo-stat-k">방어</span><span class="pgo-stat-v">${p.go.def}</span></div>
          <div><span class="pgo-stat-k">체력</span><span class="pgo-stat-v">${p.go.sta}</span></div>
          <div><span class="pgo-stat-k">최대CP</span><span class="pgo-stat-v">${p.maxCp}</span></div>
        </div>
      </div>
    </button>`;
  }

  /** <select>에 포켓몬 목록 채우기 */
  function fillPokemonSelect(sel, opts) {
    const list = (opts && opts.list) || P.pokemon.filter(p => p.r);
    sel.innerHTML = '<option value="">— 포켓몬 선택 —</option>'
      + list.map(p => `<option value="${p.idx}">${esc(P.displayName(p))} (#${p.d})</option>`).join('');
  }

  /** 타입 <select> 채우기 */
  function fillTypeSelect(sel, allLabel) {
    sel.innerHTML = `<option value="">${esc(allLabel || '전체 타입')}</option>`
      + P.types.map(t => `<option value="${t.id}">${esc(t.ko)}</option>`).join('');
  }

  const byId = idx => P.pokemon[Number(idx)];
  const byKey = k => P.pokemon.find(p => p.k === k);

  /** 스탯 막대 그래프 */
  function statBars(p) {
    const rows = [
      ['공격', p.go.atk, 450, '#ff8f5f'],
      ['방어', p.go.def, 450, '#6fc9ff'],
      ['체력', p.go.sta, 500, '#3fcf8e'],
    ];
    return `<div class="pgo-statbars">${rows.map(([k, v, max, color]) => `
      <div class="pgo-statbar">
        <span class="pgo-statbar-k">${k}</span>
        <span class="pgo-statbar-track">
          <span class="pgo-statbar-fill" style="width:${Math.min(100, v / max * 100).toFixed(1)}%;background:${color}"></span>
        </span>
        <span class="pgo-statbar-v">${v}</span>
      </div>`).join('')}</div>`;
  }

  /** 방어 상성 요약 (약점 / 저항) */
  function defenseSummary(p) {
    const prof = P.defenseProfile(p.t);
    const weak = [], resist = [];
    Object.entries(prof).forEach(([id, m]) => {
      if (m > 1.01) weak.push([Number(id), m]);
      else if (m < 0.99) resist.push([Number(id), m]);
    });
    weak.sort((a, b) => b[1] - a[1]);
    resist.sort((a, b) => a[1] - b[1]);

    const list = arr => arr.length
      ? `<div class="pgo-eff-list">${arr.map(([id, m]) =>
          `<span class="pgo-eff-item">${typeBadge(id)}${multHtml(m)}</span>`).join('')}</div>`
      : '<div style="color:var(--pgo-text-mute);font-size:.78rem">없음</div>';

    return `
      <div>
        <div class="pgo-section-title">받는 피해 ↑ (약점)</div>
        ${list(weak)}
      </div>
      <div>
        <div class="pgo-section-title">받는 피해 ↓ (저항)</div>
        ${list(resist)}
      </div>`;
  }

  /** 순위 요약 블록 — 계열별 순위를 한눈에 */
  function rankSummary(p) {
    const t = P.totals;
    const rows = [
      ['종합 (전체)', p.rank.overall, t.overall],
      [`${P.className(p.c)} 계열`, p.rank.classRank, p.rank.classTotal],
      ['DPS (전체)', p.rank.dps, t.overall],
      ['내구 (전체)', p.rank.bulk, t.overall],
      [`${p.g}세대`, p.rank.byGen && p.rank.byGen[p.g], t.byGen && t.byGen[p.g]],
    ];
    p.t.forEach(ti => rows.push([
      `${P.typeName(ti)} 타입`,
      p.rank.byType && p.rank.byType[ti],
      t.byType && t.byType[ti],
    ]));

    return `<div>
      <div class="pgo-section-title">계열별 순위</div>
      <div class="pgo-rank-grid">
        ${rows.map(([label, rank, total]) => `
          <div class="pgo-rank-cell">
            <span class="pgo-kv-k">${esc(label)}</span>
            ${rankBadge(rank, total)}
          </div>`).join('')}
      </div>
    </div>`;
  }

  /** 최적 기술 조합 */
  function movesetBlock(p) {
    const r = p.rating;
    if (!r.fast || !r.charged) {
      return `<div class="pgo-note">공격 기술 데이터가 없어 전투력을 계산할 수 없습니다.</div>`;
    }
    return `<div>
      <div class="pgo-section-title">최적 기술 조합 (레이드 기준)</div>
      <div class="pgo-kv">
        <div class="pgo-kv-item">
          <span class="pgo-kv-k">속공</span>
          <span class="pgo-kv-v" style="font-size:.85rem">${esc(r.fast.n)}</span>
          <span class="pgo-kv-k">${typeBadge(r.fast.t)} 위력 ${r.fast.p} · ${(r.fast.d / 1000).toFixed(1)}초</span>
        </div>
        <div class="pgo-kv-item">
          <span class="pgo-kv-k">차지</span>
          <span class="pgo-kv-v" style="font-size:.85rem">${esc(r.charged.n)}</span>
          <span class="pgo-kv-k">${typeBadge(r.charged.t)} 위력 ${r.charged.p} · 에너지 ${r.charged.e}</span>
        </div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">DPS</span><span class="pgo-kv-v">${r.dps.toFixed(1)}</span></div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">TDO</span><span class="pgo-kv-v">${Math.round(r.tdo)}</span></div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">종합 ER</span><span class="pgo-kv-v">${r.er.toFixed(1)}</span></div>
      </div>
    </div>`;
  }

  /** 상세 모달 — 페이지에 #pgoModal 백드롭이 있어야 한다 */
  function openDetail(p) {
    const backdrop = document.getElementById('pgoModal');
    if (!backdrop) return;

    const lv = [15, 20, 25, 30, 35, 40, 50];
    const cpRow = lv.map(l => `<tr>
      <td class="num">${l}</td>
      <td class="num">${P.cp(p.go, { a: 15, d: 15, s: 15 }, l)}</td>
      <td class="num">${P.cp(p.go, { a: 0, d: 0, s: 0 }, l)}</td>
      <td class="num">${P.hp(p.go, { a: 15, d: 15, s: 15 }, l)}</td>
    </tr>`).join('');

    backdrop.querySelector('.pgo-modal').innerHTML = `
      ${tierBanner(p)}
      <div class="pgo-modal-head">
        ${imgTag(p, '')}
        <div>
          <div class="pgo-modal-title">${esc(P.displayName(p))}</div>
          <div style="display:flex;gap:.3rem;align-items:center;margin-top:.3rem;flex-wrap:wrap">
            <span class="pgo-card-dex">#${String(p.d).padStart(4, '0')}</span>
            <span class="pgo-badge">${p.g}세대</span>
            ${p.t.map(typeBadge).join('')}
            ${classBadge(p.c)}
            ${p.r ? '' : '<span class="pgo-badge">미출시</span>'}
          </div>
        </div>
        <button class="pgo-modal-close" data-close aria-label="닫기">&times;</button>
      </div>
      <div class="pgo-modal-body">
        ${reviewBlock(p)}
        <div>
          <div class="pgo-section-title">포켓몬GO 종족값 (게임 실측값)</div>
          ${statBars(p)}
        </div>
        ${rankSummary(p)}
        ${movesetBlock(p)}
        <div class="pgo-kv">
          <div class="pgo-kv-item"><span class="pgo-kv-k">최대 CP (50레벨)</span><span class="pgo-kv-v">${p.maxCp}</span></div>
          <div class="pgo-kv-item"><span class="pgo-kv-k">40레벨 CP</span><span class="pgo-kv-v">${p.cp40}</span></div>
          <div class="pgo-kv-item"><span class="pgo-kv-k">내구지수(방×체)</span><span class="pgo-kv-v">${p.bulk}</span></div>
        </div>
        ${defenseSummary(p)}
        <div>
          <div class="pgo-section-title">레벨별 CP / HP</div>
          <div class="pgo-table-wrap">
            <table class="pgo-table">
              <thead><tr><th>레벨</th><th>CP (15/15/15)</th><th>CP (0/0/0)</th><th>HP (15/15/15)</th></tr></thead>
              <tbody>${cpRow}</tbody>
            </table>
          </div>
        </div>
      </div>`;

    backdrop.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeDetail() {
    const backdrop = document.getElementById('pgoModal');
    if (!backdrop) return;
    backdrop.hidden = true;
    document.body.style.overflow = '';
  }

  function bindModal() {
    const backdrop = document.getElementById('pgoModal');
    if (!backdrop) return;
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop || e.target.hasAttribute('data-close')) closeDetail();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !backdrop.hidden) closeDetail();
    });
  }

  function boot(render) {
    P.load().then(() => {
      bindModal();
      render();
    }).catch(err => {
      const main = document.querySelector('.pgo-main');
      if (main) {
        main.innerHTML = `<div class="pgo-panel"><div class="pgo-empty">
          데이터를 불러오지 못했습니다.<br><span style="font-size:.78rem">${esc(err.message)}</span>
        </div></div>`;
      }
      console.error(err);
    });
  }

  global.PGOUI = {
    esc, typeBadge, classBadge, rankBadge, tierBanner, inheritedNote, multClass, multText, multHtml, imgTag, card,
    fillPokemonSelect, fillTypeSelect, byId, byKey, statBars, defenseSummary,
    rankSummary, movesetBlock, verdictLine, reviewLine, reviewBlock, openDetail, closeDetail, bindModal, boot,
  };
})(window);
