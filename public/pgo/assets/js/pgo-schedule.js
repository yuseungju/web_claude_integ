/** 일정 캘린더 — 월 단위 그리드 + 날짜별 상세 + 이 달의 목록 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI, E = window.PGOEvents;
  const $ = id => document.getElementById(id);

  const today = new Date();
  const todayStr = E.ymd(today);
  let view = new Date(today.getFullYear(), today.getMonth(), 1);
  let selected = null;

  const rareOnly = () => $('rareOnly').checked;
  const byKey = k => P.pokemon.find(p => p.k === k);

  /** 이벤트명을 한국어로 (등장 포켓몬은 한국어명으로 치환) */
  function koName(e) {
    const ko = (e.mons || []).map(k => { const p = byKey(k); return p ? p.n : null; }).filter(Boolean);
    return E.label(e, ko);
  }

  /** 이벤트에 등장하는 포켓몬을 등급 배지와 함께 */
  function monChips(e) {
    if (!e.mons || !e.mons.length) return '';
    return `<span class="pgo-mon-chips">${e.mons.map(k => {
      const p = byKey(k);
      if (!p) return '';
      const t = P.tier(p);
      return `<button class="pgo-mon-chip" data-idx="${p.idx}" title="${UI.esc(t.ko)}">
        ${UI.imgTag(p, 'pgo-mon-chip-img')}
        <span>${UI.esc(p.n)}</span>
        <span class="pgo-tier-tag t${t.id}">${UI.esc(t.short)}</span>
      </button>`;
    }).join('')}</span>`;
  }

  function eventRow(e) {
    const c = E.cat(e.cat);
    const live = e.start <= `${todayStr}T23:59:59` && e.end >= `${todayStr}T00:00:00`;
    return `<div class="pgo-ev-row${live ? ' live' : ''}">
      <span class="pgo-ev-cat" style="background:${c.color}">${c.icon}</span>
      <div class="pgo-ev-main">
        <div class="pgo-ev-name">
          ${e.link ? `<a href="${UI.esc(e.link)}" target="_blank" rel="noopener" title="${UI.esc(e.name)}">${UI.esc(koName(e))}</a>` : UI.esc(koName(e))}
          ${live ? '<span class="pgo-live-tag">진행 중</span>' : ''}
        </div>
        <div class="pgo-ev-meta">${UI.esc(c.ko)} · ${UI.esc(E.fmtRange(e))}</div>
        ${monChips(e)}
      </div>
    </div>`;
  }

  // ── 달력 ────────────────────────────────────────────────────
  function renderCalendar() {
    const y = view.getFullYear(), m = view.getMonth();
    $('calTitle').textContent = `${y}년 ${m + 1}월`;

    const map = E.forMonth(y, m, { rareOnly: rareOnly() });
    const first = new Date(y, m, 1);
    const lead = first.getDay();
    const days = new Date(y, m + 1, 0).getDate();

    $('calDow').innerHTML = E.DOW
      .map((d, i) => `<div class="pgo-cal-dowcell${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${d}</div>`).join('');

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="pgo-cal-cell empty"></div>');
    for (let d = 1; d <= days; d++) {
      const key = E.ymd(new Date(y, m, d));
      const list = map[key] || [];
      const dow = new Date(y, m, d).getDay();
      const cls = [
        'pgo-cal-cell',
        key === todayStr ? 'today' : '',
        key === selected ? 'selected' : '',
        dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
        list.length ? 'has' : '',
      ].filter(Boolean).join(' ');

      // 시작하는 이벤트를 우선 표시하고, 진행 중인 것은 점으로만 센다
      const starting = list.filter(e => E.startsOn(e, key));
      const ongoing = list.length - starting.length;
      const chips = starting.slice(0, 3).map(e => {
        const c = E.cat(e.cat);
        return `<span class="pgo-cal-chip" style="border-left-color:${c.color}" title="${UI.esc(e.name)}">${UI.esc(koName(e))}</span>`;
      }).join('');

      cells.push(`<button class="${cls}" data-day="${key}">
        <span class="pgo-cal-num">${d}</span>
        ${chips}
        ${starting.length > 3 ? `<span class="pgo-cal-more">+${starting.length - 3}건</span>` : ''}
        ${ongoing ? `<span class="pgo-cal-dots">${'·'.repeat(Math.min(ongoing, 6))}</span>` : ''}
      </button>`);
    }
    $('calGrid').innerHTML = cells.join('');
  }

  function renderDay(dayStr) {
    selected = dayStr;
    const list = E.forDay(dayStr, { rareOnly: rareOnly() });
    const d = new Date(`${dayStr}T00:00:00`);
    $('dayTitle').textContent =
      `${d.getMonth() + 1}월 ${d.getDate()}일 (${E.DOW[d.getDay()]}) — ${list.length}건`;
    $('dayBody').innerHTML = list.length
      ? list.map(eventRow).join('')
      : '<div class="pgo-empty">이 날은 챙길 일정이 없습니다.</div>';
    $('dayPanel').hidden = false;
    renderCalendar();
    $('dayPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderMonthList() {
    const y = view.getFullYear(), m = view.getMonth();
    const monthStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const monthEnd = `${y}-${String(m + 1).padStart(2, '0')}-31`;
    const list = E.all()
      .filter(e => (!rareOnly() || e.rare) && e.start <= `${monthEnd}T23:59:59` && e.end >= `${monthStart}T00:00:00`)
      .sort((a, b) => a.start.localeCompare(b.start));

    $('listTitle').textContent = `${y}년 ${m + 1}월 일정 — ${list.length}건`;
    $('monthList').innerHTML = list.length
      ? list.map(eventRow).join('')
      : '<div class="pgo-empty">표시할 일정이 없습니다.</div>';
  }

  function renderLegend() {
    const used = new Set(E.all().filter(e => !rareOnly() || e.rare).map(e => e.cat));
    $('catLegend').innerHTML = [...used].map(k => {
      const c = E.cat(k);
      return `<span class="pgo-chip"><span class="pgo-ev-cat" style="background:${c.color}">${c.icon}</span>${UI.esc(c.ko)}</span>`;
    }).join('');
  }

  function renderAll() {
    renderCalendar();
    renderMonthList();
    renderLegend();
    if (selected) renderDay(selected);
  }

  function renderSource() {
    const db = E.db;
    const at = db.refreshedAt || db.fetchedAt;
    const when = at ? new Date(at).toLocaleString('ko-KR') : '알 수 없음';
    $('srcNote').innerHTML =
      `일정은 <a href="https://leekduck.com/events/" target="_blank" rel="noopener" style="color:var(--pgo-accent-2)">LeekDuck</a>의 공개 데이터를 씁니다. `
      + `기준 시각 <b>${UI.esc(when)}</b>.<br>`
      + `페이지를 열 때마다 원본에서 최신 일정을 다시 받아오며, 실패하면 저장된 사본을 그대로 씁니다. `
      + `일정은 니안틱 공지에 따라 바뀔 수 있으니 중요한 건 게임 내 공지로 한 번 더 확인하세요.`;
  }

  function boot() {
    E.load().then(() => {
      renderAll();
      renderSource();
      renderDay(todayStr);

      // 최신 일정 반영 (실패해도 화면은 그대로)
      E.refresh().then(changed => {
        if (changed) { renderAll(); renderSource(); }
      });
    }).catch(err => {
      $('calGrid').innerHTML = `<div class="pgo-empty" style="grid-column:1/-1">일정을 불러오지 못했습니다. ${UI.esc(err.message)}</div>`;
    });

    $('prevMonth').addEventListener('click', () => {
      view = new Date(view.getFullYear(), view.getMonth() - 1, 1); selected = null;
      $('dayPanel').hidden = true; renderAll();
    });
    $('nextMonth').addEventListener('click', () => {
      view = new Date(view.getFullYear(), view.getMonth() + 1, 1); selected = null;
      $('dayPanel').hidden = true; renderAll();
    });
    $('thisMonth').addEventListener('click', () => {
      view = new Date(today.getFullYear(), today.getMonth(), 1);
      renderAll(); renderDay(todayStr);
    });
    $('rareOnly').addEventListener('change', renderAll);

    $('calGrid').addEventListener('click', e => {
      const cell = e.target.closest('.pgo-cal-cell[data-day]');
      if (cell) renderDay(cell.dataset.day);
    });

    document.addEventListener('click', e => {
      const chip = e.target.closest('.pgo-mon-chip');
      if (chip) UI.openDetail(UI.byId(chip.dataset.idx));
    });
  }

  // 도감 데이터(등급 표시용)와 일정 데이터를 함께 기다린다
  UI.boot(boot);
})();
