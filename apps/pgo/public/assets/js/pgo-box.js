/** 내 보관함 — 저장된 포켓몬 목록/정렬/삭제 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI, Store = window.PGOStore;
  const $ = id => document.getElementById(id);
  let entries = [];

  const ivPct = e => (e.iv_atk == null ? null
    : Math.round((e.iv_atk + e.iv_def + e.iv_sta) / 45 * 100));

  const SORTERS = {
    new:  (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    iv:   (a, b) => (ivPct(b) ?? -1) - (ivPct(a) ?? -1),
    cp:   (a, b) => (b.cp || 0) - (a.cp || 0),
    name: (a, b) => {
      const an = UI.byKey(a.poke_key), bn = UI.byKey(b.poke_key);
      return (an ? an.n : '').localeCompare(bn ? bn.n : '', 'ko');
    },
  };

  function renderMode() {
    const server = Store.mode === 'server';
    $('mode').textContent = server ? '서버 저장 (RDS)' : '브라우저 저장';
    $('modeNote').innerHTML = server
      ? `기기 키 <code>${UI.esc(Store.deviceKey().slice(0, 8))}…</code> 로 서버에 저장됩니다.`
      : '백엔드가 연결되지 않아 이 브라우저에만 저장됩니다. '
        + '<code>pgo-config.js</code> 의 <code>PGO_API_BASE</code> 를 설정하면 서버 저장으로 전환됩니다.';
  }

  function render() {
    const sorted = [...entries].sort(SORTERS[$('sort').value] || SORTERS.new);
    $('boxCount').textContent = `${sorted.length}마리`;

    if (!sorted.length) {
      $('boxRows').innerHTML = `<tr><td colspan="10" class="pgo-empty">
        저장된 포켓몬이 없습니다. <a href="/pgo/iv.html" style="color:var(--pgo-accent-2)">CP · IV 계산기</a>에서 결과를 저장해 보세요.
      </td></tr>`;
      return;
    }

    $('boxRows').innerHTML = sorted.map(e => {
      const p = UI.byKey(e.poke_key);
      const iv = e.iv_atk == null ? null : { a: e.iv_atk, d: e.iv_def, s: e.iv_sta };
      const cp50 = p && iv ? P.cp(p.go, iv, P.MAX_LEVEL_XL) : null;
      const pct = ivPct(e);
      return `<tr>
        <td>
          <span style="display:inline-flex;align-items:center;gap:.45rem">
            ${p ? UI.imgTag(p, 'pgo-card-img') : ''}
            <span>
              <b class="pgo-detail" data-key="${UI.esc(String(e.poke_key))}" style="cursor:pointer">${p ? UI.esc(P.displayName(p)) : '(알 수 없음)'}</b>
              ${e.nickname ? `<br><span style="font-size:.72rem;color:var(--pgo-text-mute)">${UI.esc(e.nickname)}</span>` : ''}
            </span>
          </span>
        </td>
        <td>${p ? p.t.map(UI.typeBadge).join(' ') : '—'}</td>
        <td class="num">${e.cp ?? '—'}</td>
        <td class="num">${e.hp ?? '—'}</td>
        <td class="num">${e.level ?? '—'}</td>
        <td class="num">${iv ? `${iv.a} / ${iv.d} / ${iv.s}` : '—'}</td>
        <td class="num">${pct == null ? '—' : `${pct}%`}</td>
        <td class="num">${cp50 ?? '—'}</td>
        <td>${UI.esc(e.memo || '')}</td>
        <td><button class="pgo-btn ghost pgo-del" data-id="${UI.esc(String(e.id))}" type="button">삭제</button></td>
      </tr>`;
    }).join('');
  }

  async function reload() {
    try {
      entries = await Store.list();
    } catch (err) {
      entries = [];
      $('boxRows').innerHTML = `<tr><td colspan="10" class="pgo-empty">보관함을 불러오지 못했습니다. ${UI.esc(err.message)}</td></tr>`;
      return;
    }
    render();
  }

  function boot() {
    renderMode();
    $('sort').addEventListener('change', render);

    $('clearAll').addEventListener('click', async () => {
      if (!entries.length) return;
      if (!confirm(`보관함의 ${entries.length}마리를 모두 삭제할까요? 되돌릴 수 없습니다.`)) return;
      await Store.clear();
      await reload();
    });

    $('boxRows').addEventListener('click', async e => {
      const del = e.target.closest('.pgo-del');
      if (del) {
        await Store.remove(del.dataset.id);
        await reload();
        return;
      }
      const detail = e.target.closest('.pgo-detail');
      if (detail) {
        const p = UI.byKey(detail.dataset.key);
        if (p) UI.openDetail(p);
      }
    });

    reload();
  }

  UI.boot(boot);
})();
