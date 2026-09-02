/**
 * 오늘의 일정 — 하루에 챙길 것을 최적 동선 순서로 배치한 체크리스트.
 *
 * 순서 원칙: 집에서 할 것 → 걸으면서 할 것 → 포켓스톱/체육관 구간 →
 * 시간 맞춰야 하는 레이드 → 어디서나 가능한 마무리.
 * 같은 장소에서 할 일을 묶어 두 번 나가지 않게 한다.
 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI, E = window.PGOEvents;
  const $ = id => document.getElementById(id);

  const now = new Date();
  const todayStr = E.ymd(now);
  const LS_KEY = `pgo.today.${todayStr}`;

  /** 매일 반복하는 일과 — 동선 순서대로 */
  const ROUTE = [
    {
      id: 'home', icon: '🌅', title: '나가기 전 (집에서)',
      items: [
        { id: 'gift-open', label: '받은 선물 열기', why: '우정 레벨이 오르고 7km 알·스티커가 나온다. 가방 자리 미리 비워둘 것.' },
        { id: 'gift-send', label: '친구에게 선물 보내기 (최대 20개)', why: '우정 레벨은 하루 1회만 오른다. 아침에 보내야 상대가 열 시간이 생긴다.' },
        { id: 'pass-check', label: '무료 레이드 패스 남았는지 확인', why: '무료 패스는 1개까지만 들고 있을 수 있다. 남아 있으면 오늘 안에 써야 내일 또 받는다.' },
        { id: 'bag', label: '가방·포켓몬 상자 정리', why: '나가서 자리 없어 못 줍는 일이 제일 아깝다.' },
      ],
    },
    {
      id: 'walk', icon: '🚶', title: '걷는 동안',
      items: [
        { id: 'incense', label: '데일리 어드벤처 인센스 15분 켜기', why: '하루 1회. 갈라르 3조 같은 희귀 포켓몬이 여기서만 나온다. 반드시 걸어야 조우가 뜬다.', star: true },
        { id: 'egg', label: '알 부화 슬롯 채우기', why: '빈 인큐베이터로 걸으면 그 거리는 그냥 날아간다.' },
        { id: 'buddy', label: '버디 하트 채우기 (같이 걷기·간식)', why: '최고의 버디까지 올리면 CP 보정이 붙는다.' },
        { id: 'sync', label: '모험을 함께(어드벤처 싱크) 켜져 있는지 확인', why: '주간 거리 보상(사탕·별의모래)이 여기서 나온다.' },
      ],
    },
    {
      id: 'stop', icon: '📍', title: '포켓스톱 · 체육관 구간',
      items: [
        { id: 'spin', label: '포켓스톱 첫 스핀', why: '데일리 스핀 스트릭. 7일째에 별의모래 2,500과 희귀 아이템이 나온다.', star: true },
        { id: 'catch', label: '오늘의 첫 포켓몬 잡기', why: '데일리 캐치 스트릭. 7일째 보너스가 크다.', star: true },
        { id: 'research', label: '필드 리서치 최소 1개 완료', why: '스탬프 7개 = 리서치 브레이크스루. 전설 포켓몬 조우가 여기서 나온다.', star: true },
        { id: 'gym-disc', label: '체육관 포토디스크 돌려 무료 레이드 패스 받기', why: '레이드 하기 전에 미리 받아둬야 한다. 체육관에서만 나온다.', star: true },
      ],
    },
    {
      id: 'raid', icon: '⚔️', title: '레이드',
      items: [
        { id: 'raid-legend', label: '전설 레이드 (오늘 보스 확인)', why: '무료 패스는 하루 1개. 전설이 돌 때 쓰는 게 가장 이득이다.', star: true },
        { id: 'raid-mega', label: '메가 레이드 — 메가 에너지 벌기', why: '메가 진화는 에너지가 있어야 한다. 쓸 만한 메가일 때만 도는 게 효율적이다.' },
      ],
    },
    {
      id: 'night', icon: '🌙', title: '마무리 (어디서나)',
      items: [
        { id: 'gbl', label: 'GO 배틀 리그 세트 돌리기', why: '세트마다 별의모래와 아이템, 랭크가 오르면 전설 조우 기회도 생긴다.' },
        { id: 'special', label: '특별·타임드 리서치 진행도 확인', why: '타임드 리서치는 기한이 지나면 사라진다.' },
        { id: 'trade', label: '친구와 교환 (하루 1회 특별 교환)', why: '개체값이 다시 굴려진다. 전설·색이 다른 포켓몬은 하루 1회뿐.' },
      ],
    },
  ];

  // ── 체크 상태 (날짜별 localStorage) ─────────────────────────
  function readChecks() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function writeChecks(obj) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
      // 지난 날짜 기록은 정리한다
      Object.keys(localStorage)
        .filter(k => k.startsWith('pgo.today.') && k !== LS_KEY)
        .forEach(k => localStorage.removeItem(k));
    } catch (e) { /* 저장 못 해도 화면은 동작 */ }
  }
  let checks = readChecks();

  const allItems = () => ROUTE.reduce((n, b) => n + b.items.length, 0);

  function renderProgress() {
    const done = Object.values(checks).filter(Boolean).length;
    const total = allItems();
    const rate = total ? Math.round(done / total * 100) : 0;
    $('progressText').textContent = `${rate}%`;
    $('progressRing').style.background =
      `conic-gradient(var(--pgo-accent) ${rate * 3.6}deg, var(--pgo-surface-2) 0deg)`;
    $('progressRing').title = `${done} / ${total}`;
  }

  // ── 렌더 ────────────────────────────────────────────────────
  const byKey = k => P.pokemon.find(p => p.k === k);

  /** 이벤트명을 한국어로 (등장 포켓몬은 한국어명으로 치환) */
  function koName(e) {
    const ko = (e.mons || []).map(k => { const p = byKey(k); return p ? p.n : null; }).filter(Boolean);
    return E.label(e, ko);
  }

  function monChips(mons) {
    if (!mons || !mons.length) return '';
    return `<span class="pgo-mon-chips">${mons.map(k => {
      const p = byKey(k);
      if (!p) return '';
      const t = P.tier(p);
      return `<button class="pgo-mon-chip" data-idx="${p.idx}">
        ${UI.imgTag(p, 'pgo-mon-chip-img')}
        <span>${UI.esc(p.n)}</span>
        <span class="pgo-tier-tag t${t.id}">${UI.esc(t.short)}</span>
      </button>`;
    }).join('')}</span>`;
  }

  /** 시간 한정 이벤트: 지금 기준 상태 */
  function timeState(e) {
    const s = E.parse(e.start), t = E.parse(e.end);
    if (now >= s && now <= t) return { cls: 'now', label: '진행 중' };
    if (now < s) {
      const mins = Math.round((s - now) / 60000);
      if (mins <= 180) return { cls: 'soon', label: `${mins < 60 ? `${mins}분` : `${Math.floor(mins / 60)}시간`} 후` };
      return { cls: 'later', label: '예정' };
    }
    return { cls: 'done', label: '종료' };
  }

  function renderTimed() {
    const list = E.forDay(todayStr).filter(E.isTimed)
      .sort((a, b) => a.start.localeCompare(b.start));

    if (!list.length) {
      $('timedBody').innerHTML =
        '<div class="pgo-empty">오늘은 시간 맞춰야 할 이벤트가 없습니다. 아래 동선만 챙기면 됩니다.</div>';
      return;
    }
    $('timedBody').innerHTML = list.map(e => {
      const c = E.cat(e.cat), st = timeState(e);
      return `<div class="pgo-timed ${st.cls}">
        <div class="pgo-timed-when">
          <b>${UI.esc(E.fmtTime(e.start))}</b><span>~${UI.esc(E.fmtTime(e.end))}</span>
        </div>
        <div class="pgo-timed-main">
          <div class="pgo-ev-name">
            <span class="pgo-ev-cat" style="background:${c.color}">${c.icon}</span>
            ${e.link ? `<a href="${UI.esc(e.link)}" target="_blank" rel="noopener" title="${UI.esc(e.name)}">${UI.esc(koName(e))}</a>` : UI.esc(koName(e))}
            <span class="pgo-time-tag ${st.cls}">${UI.esc(st.label)}</span>
          </div>
          ${monChips(e.mons)}
        </div>
      </div>`;
    }).join('');
  }

  function renderRoute() {
    $('routeBody').innerHTML = ROUTE.map(block => `
      <div class="pgo-route-block">
        <div class="pgo-route-title"><span>${block.icon}</span>${UI.esc(block.title)}</div>
        ${block.items.map(it => `
          <label class="pgo-check${checks[it.id] ? ' done' : ''}">
            <input type="checkbox" data-check="${it.id}" ${checks[it.id] ? 'checked' : ''} />
            <span class="pgo-check-body">
              <span class="pgo-check-label">${UI.esc(it.label)}${it.star ? '<span class="pgo-must">놓치면 손해</span>' : ''}</span>
              <span class="pgo-check-why">${UI.esc(it.why)}</span>
            </span>
          </label>`).join('')}
      </div>`).join('');
  }

  function renderRaids() {
    const live = E.forDay(todayStr)
      .filter(e => ['legendary', 'mega', 'shadow', 'raid', 'raidday'].includes(e.cat));
    if (!live.length) {
      $('raidBody').innerHTML = '<div class="pgo-empty">오늘 도는 전설 · 메가 레이드가 없습니다.</div>';
      return;
    }
    $('raidBody').innerHTML = live.map(e => {
      const c = E.cat(e.cat);
      return `<div class="pgo-ev-row">
        <span class="pgo-ev-cat" style="background:${c.color}">${c.icon}</span>
        <div class="pgo-ev-main">
          <div class="pgo-ev-name" title="${UI.esc(e.name)}">${UI.esc(koName(e))}</div>
          <div class="pgo-ev-meta">${UI.esc(c.ko)} · ${UI.esc(E.fmtRange(e))}</div>
          ${monChips(e.mons)}
        </div>
      </div>`;
    }).join('');
  }

  function renderUpcoming() {
    const list = E.upcoming(todayStr, 40, { rareOnly: true })
      .filter(e => e.start > `${todayStr}T23:59:59`)
      .slice(0, 8);
    $('upcomingBody').innerHTML = list.length
      ? list.map(e => {
          const c = E.cat(e.cat);
          return `<div class="pgo-ev-row">
            <span class="pgo-ev-cat" style="background:${c.color}">${c.icon}</span>
            <div class="pgo-ev-main">
              <div class="pgo-ev-name" title="${UI.esc(e.name)}">${UI.esc(koName(e))}</div>
              <div class="pgo-ev-meta">${UI.esc(E.fmtRange(e))}</div>
              ${monChips(e.mons)}
            </div>
          </div>`;
        }).join('')
        + '<div style="margin-top:.8rem"><a class="pgo-btn ghost" href="/pgo/schedule.html">전체 캘린더 보기</a></div>'
      : '<div class="pgo-empty">예정된 일정이 없습니다.</div>';
  }

  function renderHeader() {
    $('todayDate').textContent =
      `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${E.DOW[now.getDay()]})`;
    const season = E.forDay(todayStr).find(e => e.cat === 'season');
    const rare = E.forDay(todayStr, { rareOnly: true }).length;
    $('todaySub').textContent = season
      ? `${koName(season)} 시즌 · 오늘 챙길 귀한 일정 ${rare}건`
      : `오늘 챙길 귀한 일정 ${rare}건`;
  }

  function boot() {
    E.load().then(() => {
      renderHeader();
      renderTimed();
      renderRoute();
      renderRaids();
      renderUpcoming();
      renderProgress();

      E.refresh().then(changed => {
        if (changed) { renderHeader(); renderTimed(); renderRaids(); renderUpcoming(); }
      });
    }).catch(err => {
      $('timedBody').innerHTML = `<div class="pgo-empty">일정을 불러오지 못했습니다. ${UI.esc(err.message)}</div>`;
      renderRoute();
      renderProgress();
    });

    $('routeBody').addEventListener('change', e => {
      const box = e.target.closest('input[data-check]');
      if (!box) return;
      checks[box.dataset.check] = box.checked;
      writeChecks(checks);
      box.closest('.pgo-check').classList.toggle('done', box.checked);
      renderProgress();
    });

    $('resetToday').addEventListener('click', () => {
      checks = {};
      writeChecks(checks);
      renderRoute();
      renderProgress();
    });

    document.addEventListener('click', e => {
      const chip = e.target.closest('.pgo-mon-chip');
      if (chip) UI.openDetail(UI.byId(chip.dataset.idx));
    });
  }

  UI.boot(boot);
})();
