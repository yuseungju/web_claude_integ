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
    // 0.244140625 같은 값이 그대로 보이지 않게 유효숫자 3자리로 자른다
    return `${Number(m.toFixed(3))}x`;
  }
  function multHtml(m) {
    return `<span class="pgo-mult ${multClass(m)}">${multText(m)}</span>`;
  }

  /** 이미지 로드 실패 시 조용히 숨긴다 (스프라이트는 외부 CDN) */
  function imgTag(p, cls) {
    return `<img class="${cls}" loading="lazy" alt="${esc(P.displayName(p))}"
      src="${P.spriteUrl(p)}" onerror="this.style.visibility='hidden'">`;
  }

  /** 포켓몬 카드 (버튼) */
  function card(p) {
    return `<button class="pgo-card" data-i="${p.i}">
      <div class="pgo-card-top">
        ${imgTag(p, 'pgo-card-img')}
        <div>
          <span class="pgo-card-dex">#${String(p.d).padStart(4, '0')}</span>
          <div class="pgo-card-name">${esc(p.n)}</div>
          ${p.f ? `<div class="pgo-card-form">${esc(p.f)}</div>` : ''}
          <div class="pgo-card-types">${p.t.map(typeBadge).join('')}</div>
        </div>
      </div>
      <div class="pgo-card-stats">
        <div><span class="pgo-stat-k">공격</span><span class="pgo-stat-v">${p.go.atk}</span></div>
        <div><span class="pgo-stat-k">방어</span><span class="pgo-stat-v">${p.go.def}</span></div>
        <div><span class="pgo-stat-k">체력</span><span class="pgo-stat-v">${p.go.sta}</span></div>
        <div><span class="pgo-stat-k">최대CP</span><span class="pgo-stat-v">${p.maxCp}</span></div>
      </div>
    </button>`;
  }

  /** <select>에 포켓몬 목록 채우기 */
  function fillPokemonSelect(sel, opts) {
    const list = (opts && opts.list) || P.pokemon;
    sel.innerHTML = '<option value="">— 포켓몬 선택 —</option>'
      + list.map(p => `<option value="${p.i}">${esc(P.displayName(p))} (#${p.d})</option>`).join('');
  }

  /** 타입 <select> 채우기 */
  function fillTypeSelect(sel, allLabel) {
    sel.innerHTML = `<option value="">${esc(allLabel || '전체 타입')}</option>`
      + P.types.map(t => `<option value="${t.id}">${esc(t.ko)}</option>`).join('');
  }

  const byId = i => P.pokemon.find(p => p.i === Number(i));

  /** 스탯 막대 그래프 */
  function statBars(p) {
    const rows = [
      ['공격', p.go.atk, 400, '#ff8f5f'],
      ['방어', p.go.def, 400, '#6fc9ff'],
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
      <div class="pgo-modal-head">
        ${imgTag(p, '')}
        <div>
          <div class="pgo-modal-title">${esc(P.displayName(p))}</div>
          <div style="display:flex;gap:.3rem;align-items:center;margin-top:.3rem;flex-wrap:wrap">
            <span class="pgo-card-dex">#${String(p.d).padStart(4, '0')}</span>
            <span class="pgo-badge">${p.g}세대</span>
            ${p.t.map(typeBadge).join('')}
            <span class="pgo-badge ${p.measured ? 'measured' : ''}">${p.measured ? '실측값' : '환산값'}</span>
          </div>
        </div>
        <button class="pgo-modal-close" data-close aria-label="닫기">&times;</button>
      </div>
      <div class="pgo-modal-body">
        <div>
          <div class="pgo-section-title">포켓몬GO 종족값</div>
          ${statBars(p)}
        </div>
        <div class="pgo-kv">
          <div class="pgo-kv-item"><span class="pgo-kv-k">최대 CP (50레벨)</span><span class="pgo-kv-v">${p.maxCp}</span></div>
          <div class="pgo-kv-item"><span class="pgo-kv-k">40레벨 CP</span><span class="pgo-kv-v">${p.cp40}</span></div>
          <div class="pgo-kv-item"><span class="pgo-kv-k">내구지수(방×체)</span><span class="pgo-kv-v">${p.bulk}</span></div>
          <div class="pgo-kv-item"><span class="pgo-kv-k">종합지수</span><span class="pgo-kv-v">${Math.round(Math.cbrt(p.go.atk * p.go.def * p.go.sta))}</span></div>
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
        <div class="pgo-note">
          메인시리즈 종족값을 포켓몬GO 환산식으로 변환한 값입니다.
          Niantic이 개별 조정한 일부 종(뮤츠·뮤 등)은 <b>실측값</b> 배지로 구분되며,
          그 외 전설·환상 포켓몬은 실제 게임 수치와 차이가 있을 수 있습니다.
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

  /** 모달 닫기 동작(백드롭 클릭 / X / ESC) 연결 — 페이지당 1회 */
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

  /** 데이터 로드 + 에러를 화면에 표시하는 공통 부트스트랩 */
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
    esc, typeBadge, multClass, multText, multHtml, imgTag, card,
    fillPokemonSelect, fillTypeSelect, byId, statBars, defenseSummary,
    openDetail, closeDetail, bindModal, boot,
  };
})(window);
