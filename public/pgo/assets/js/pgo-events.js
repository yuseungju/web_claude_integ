/**
 * 일정 데이터 모듈 — events.json 로딩 + 기간/날짜 질의
 *
 * 일정은 매주 바뀐다. 저장소에 번들된 사본을 먼저 쓰고, 원본(ScrapedDuck)에서
 * 더 최신 데이터를 받아오면 그것으로 갈아끼운다. 네트워크가 막히거나 실패하면
 * 번들본을 그대로 쓰므로 화면이 비지 않는다.
 */
(function (global) {
  'use strict';

  const CAT = {
    legendary: { ko: '전설 레이드', color: '#ffcb05', icon: '★' },
    mega:      { ko: '메가 레이드', color: '#ff8f5f', icon: 'M' },
    shadow:    { ko: '섀도우 레이드', color: '#b07bd8', icon: 'S' },
    raidhour:  { ko: '레이드 아워', color: '#ff6b8a', icon: '⏱' },
    raidday:   { ko: '레이드 데이', color: '#ff4d6d', icon: '⚔' },
    commday:   { ko: '커뮤니티 데이', color: '#3fcf8e', icon: 'C' },
    fest:      { ko: '페스티벌', color: '#59e0c5', icon: 'F' },
    pass:      { ko: 'GO 패스', color: '#6fc9ff', icon: 'P' },
    ticket:    { ko: '유료 티켓', color: '#8fa6d8', icon: 'T' },
    sale:      { ko: '할인 · 무료', color: '#ffd166', icon: '%' },
    research:  { ko: '리서치', color: '#7dd3fc', icon: 'R' },
    max:       { ko: '맥스 먼데이', color: '#c084fc', icon: 'X' },
    maxday:    { ko: '맥스 배틀 데이', color: '#a855f7', icon: 'X' },
    wild:      { ko: '와일드 에리어', color: '#7aa2c9', icon: 'W' },
    spotlight: { ko: '스포트라이트', color: '#94a3b8', icon: '·' },
    gbl:       { ko: '배틀 리그', color: '#64748b', icon: 'L' },
    season:    { ko: '시즌', color: '#475569', icon: '—' },
    event:     { ko: '이벤트', color: '#a3b3cc', icon: 'E' },
    raid:      { ko: '레이드', color: '#ffcb05', icon: '★' },
  };

  let DB = null;
  let loadPromise = null;

  // ── 날짜 유틸 (전부 로컬 시간 기준) ─────────────────────────
  const pad = n => String(n).padStart(2, '0');
  /** Date -> 'YYYY-MM-DD' */
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  /** 'YYYY-MM-DDTHH:mm:ss' 문자열을 로컬 Date 로 (Z 없는 문자열이라 브라우저가 로컬로 해석) */
  const parse = s => new Date(s);
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  function fmtTime(s) {
    const d = parse(s);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDate(s) {
    const d = parse(s);
    return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`;
  }
  function fmtRange(e) {
    const a = parse(e.start), b = parse(e.end);
    const sameDay = ymd(a) === ymd(b);
    return sameDay
      ? `${fmtDate(e.start)} ${fmtTime(e.start)}~${fmtTime(e.end)}`
      : `${fmtDate(e.start)} ~ ${fmtDate(e.end)}`;
  }

  /** 이벤트가 해당 날짜(YYYY-MM-DD)에 걸쳐 있는지 */
  function onDay(e, dayStr) {
    const dayStart = `${dayStr}T00:00:00`;
    const dayEnd = `${dayStr}T23:59:59`;
    return e.start <= dayEnd && e.end >= dayStart;
  }

  /** 그 날 '시작'하는 이벤트인지 (달력에서 긴 기간 이벤트를 매일 반복 표시하지 않으려고) */
  const startsOn = (e, dayStr) => e.start.slice(0, 10) === dayStr;

  /** 하루 안에 끝나는 시간 한정 이벤트인지 (레이드 아워 등) */
  function isTimed(e) {
    return e.start.slice(0, 10) === e.end.slice(0, 10)
      && (parse(e.end) - parse(e.start)) <= 12 * 3600 * 1000;
  }

  // ── 한국어 표기 ─────────────────────────────────────────────
  const MONTHS = { January: '1월', February: '2월', March: '3월', April: '4월',
    May: '5월', June: '6월', July: '7월', August: '8월', September: '9월',
    October: '10월', November: '11월', December: '12월' };

  /** 영문 이벤트명을 한국어로 옮긴다. 모르는 형태는 원문을 그대로 둔다. */
  function label(e, monNames) {
    const mons = (monNames && monNames.length) ? monNames.join(' · ') : null;
    const n = e.name || '';
    const rules = [
      [/^(.+) in 5-star Raid Battles$/i, () => `${mons || '$1'} 5성 레이드`],
      [/^(.+) in Mega Raids$/i,          () => `${mons || '$1'} 메가 레이드`],
      [/^(.+) in Shadow Raids$/i,        () => `${mons || '$1'} 섀도우 레이드`],
      [/^(.+) in Elite Raids$/i,         () => `${mons || '$1'} 엘리트 레이드`],
      [/^(.+) Raid Hour$/i,              () => `${mons || '$1'} 레이드 아워`],
      [/^(.+) Raid Day$/i,               () => `${mons || '$1'} 레이드 데이`],
      [/^(.+) Community Day Classic$/i,  () => `${mons || '$1'} 커뮤니티 데이 클래식`],
      [/^(.+) Community Day$/i,          () => `${mons || '$1'} 커뮤니티 데이`],
      [/^(.+) Spotlight Hour$/i,         () => `${mons || '$1'} 스포트라이트 아워`],
      [/^Dynamax (.+) during Max Monday$/i, () => `다이맥스 ${mons || '$1'} 맥스 먼데이`],
      [/^(.+) Timed Research$/i,         () => `${mons || '$1'} 타임드 리서치`],
      [/^(.+) Special Research$/i,       () => `${mons || '$1'} 스페셜 리서치`],
      [/^(.+) Catch Mastery$/i,          () => `${mons || '$1'} 캐치 마스터리`],
    ];
    for (const [re, make] of rules) {
      const m = n.match(re);
      if (m) return make().replace('$1', m[1]);
    }
    const pass = n.match(/^GO Pass: (\w+)$/i);
    if (pass) return `GO 패스: ${MONTHS[pass[1]] || pass[1]}`;
    if (/Super Mega Raid Day/i.test(n)) return `${mons || n} 슈퍼 메가 레이드 데이`;
    return n;
  }

  // ── 표시 범위 필터 ──────────────────────────────────────────
  // 5성(전설)·6성(메가) 레이드가 핵심이고, 그중에서도 보유 등급이 좋은 것만 보고 싶다는
  // 요구가 있어 등급 기준 필터를 둔다. 등급 판정은 도감 데이터가 필요하므로
  // 페이지에서 resolver 를 주입받는다.
  let tierOf = () => null;          // (pokemonKey) -> tier id (0 필수보유 ~ 3 버림)
  function setTierResolver(fn) { tierOf = fn; }
  let classOf = () => null;         // (pokemonKey) -> 등급 코드 (0 일반 / 1 전설 / 2 환상 / 3 UB / 4 메가)
  function setClassResolver(fn) { classOf = fn; }

  /** 이벤트에 전설·환상·울트라비스트가 등장하는지 */
  function hasSpecial(e) {
    return (e.mons || []).some(k => {
      const c = classOf(k);
      return c === 1 || c === 2 || c === 3;
    });
  }

  const RAID_56 = ['legendary', 'mega'];              // 5성 전설 · 6성 메가
  const RAID_LIKE = ['legendary', 'mega', 'raidhour', 'raidday'];
  const PERK = ['pass', 'sale', 'research', 'ticket'];  // 패스 · 할인 · 리서치

  /** 이벤트에 등장하는 포켓몬 중 가장 높은 등급 (숫자가 작을수록 좋음) */
  function bestTier(e) {
    let best = null;
    (e.mons || []).forEach(k => {
      const t = tierOf(k);
      if (t === null || t === undefined) return;
      if (best === null || t < best) best = t;
    });
    return best;
  }

  /**
   * 엄선 기준 — 5성과 메가에 다른 잣대를 쓴다.
   *   5성(전설): 등장 자체가 드무니 '버림(C)' 등급만 뺀다
   *   메가(6성): 자주 돌아오니 '보유(A)' 이상만 남긴다
   *   섀도우: 상시로 도는 편이라 기본에서는 제외
   * 레이드 아워·데이는 그 보스가 위 기준을 통과할 때만 남긴다.
   */
  function passesSelect(e) {
    const t = bestTier(e);
    if (t === null) return false;
    const isMega = e.cat === 'mega' || (e.mons || []).some(k => /_MEGA|_PRIMAL/.test(k));
    return isMega ? t <= 1 : t <= 2;
  }

  const MODES = {
    select: e => {
      if (PERK.includes(e.cat)) return true;
      // 맥스 배틀 데이·기간틱스맥스는 단발 행사라 항상 포함.
      // 매주 도는 맥스 먼데이는 전설·환상·UB 가 나올 때만 (전설의 새 다이맥스 등)
      if (e.cat === 'maxday') return true;
      if (e.cat === 'max') return hasSpecial(e);
      if (!RAID_LIKE.includes(e.cat)) return false;
      return passesSelect(e);
    },
    // 5성·메가 레이드 전부 (등급 무관) + 패스·할인·리서치
    raids: e => PERK.includes(e.cat) || RAID_LIKE.includes(e.cat)
      || e.cat === 'maxday' || (e.cat === 'max' && hasSpecial(e)),
    // 기존 '귀한 것' — 섀도우 레이드, 커뮤니티 데이, 페스티벌까지 포함
    rare: e => !!e.rare || e.cat === 'max' || e.cat === 'maxday',
    all: () => true,
  };
  const MODE_LABEL = {
    select: '엄선 (5성 C 제외 · 메가 A 이상 · 전설 맥스배틀 포함 · 섀도우 제외)',
    raids: '5성 · 메가 레이드 전체',
    rare: '귀한 것 전체 (섀도우·커뮤데이 포함)',
    all: '전체 일정',
  };

  const match = (e, mode) => (MODES[mode] || MODES.select)(e);

  // ── 질의 ────────────────────────────────────────────────────
  const all = () => (DB ? DB.events : []);
  const raids = () => (DB ? DB.raids : []);

  /** 특정 날짜에 해당하는 이벤트. opts.mode 를 주면 그 범위로 거른다 */
  function forDay(dayStr, opts) {
    const mode = opts && opts.mode;
    return all()
      .filter(e => onDay(e, dayStr))
      .filter(e => !mode || match(e, mode))
      .sort((a, b) => {
        const at = isTimed(a) ? 0 : 1, bt = isTimed(b) ? 0 : 1;
        return at - bt || a.start.localeCompare(b.start);
      });
  }

  /** 특정 연-월(0-based month)의 날짜별 이벤트 맵 */
  function forMonth(year, month, opts) {
    const mode = opts && opts.mode;
    const map = {};
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    for (let d = 1; d <= last.getDate(); d++) {
      map[ymd(new Date(year, month, d))] = [];
    }
    all().forEach(e => {
      if (mode && !match(e, mode)) return;
      const s = parse(e.start), t = parse(e.end);
      if (t < first || s > new Date(year, month, last.getDate(), 23, 59, 59)) return;
      Object.keys(map).forEach(day => { if (onDay(e, day)) map[day].push(e); });
    });
    Object.values(map).forEach(list => list.sort((a, b) => a.start.localeCompare(b.start)));
    return map;
  }

  /** 오늘 이후 다가오는 이벤트 */
  function upcoming(fromDayStr, limit, opts) {
    const mode = opts && opts.mode;
    return all()
      .filter(e => e.end >= `${fromDayStr}T00:00:00`)
      .filter(e => !mode || match(e, mode))
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, limit || 20);
  }

  // ── 현재 도는 레이드 보스 (raids.json) ──────────────────────
  // events.json 은 '공지된 이벤트'만 담는다. 메가라티오스처럼 상시 로테이션으로
  // 도는 보스는 여기에만 있으므로, 오늘 뭘 잡을 수 있는지는 이 목록을 봐야 한다.
  const TIER_LABEL = [
    [/5-?star/i, { ko: '5성 전설', rank: 0 }],
    [/mega/i,    { ko: '메가 (6성)', rank: 1 }],
    [/elite/i,   { ko: '엘리트', rank: 2 }],
    [/3-?star/i, { ko: '3성', rank: 3 }],
    [/1-?star/i, { ko: '1성', rank: 4 }],
  ];
  function raidTier(r) {
    for (const [re, info] of TIER_LABEL) if (re.test(r.tier || '')) return info;
    return { ko: r.tier || '기타', rank: 9 };
  }
  const isShadowRaid = r => /^shadow/i.test(r.name || '');

  /**
   * 현재 보스를 티어별로 묶는다.
   * @param opts.valuableOnly 보유 등급 A 이상만 (등급 판정은 setTierResolver 필요)
   */
  function raidGroups(opts) {
    const valuableOnly = opts && opts.valuableOnly;
    const groups = new Map();
    raids().forEach(r => {
      const t = raidTier(r);
      const best = bestTier({ mons: r.mons });
      if (valuableOnly && (best === null || best > 1)) return;
      const key = `${t.rank}|${t.ko}${isShadowRaid(r) ? ' · 섀도우' : ''}`;
      if (!groups.has(key)) groups.set(key, { label: key.split('|')[1], rank: t.rank, shadow: isShadowRaid(r), list: [] });
      groups.get(key).list.push(Object.assign({ best }, r));
    });
    const out = [...groups.values()];
    out.forEach(g => g.list.sort((a, b) => (a.best === null ? 9 : a.best) - (b.best === null ? 9 : b.best)));
    // 섀도우는 같은 티어 안에서 뒤로
    out.sort((a, b) => a.rank - b.rank || (a.shadow ? 1 : 0) - (b.shadow ? 1 : 0));
    return out;
  }

  // ── 로딩 ────────────────────────────────────────────────────
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = fetch('/pgo/assets/data/events.json')
      .then(r => {
        if (!r.ok) throw new Error(`일정 데이터를 불러오지 못했습니다 (HTTP ${r.status})`);
        return r.json();
      })
      .then(json => { DB = json; return DB; });
    return loadPromise;
  }

  /**
   * 원본에서 최신 일정을 받아 갈아끼운다. 실패하면 조용히 번들본을 유지한다.
   * @returns {Promise<boolean>} 갱신되었으면 true
   */
  function refresh() {
    if (!DB || !DB.refreshUrl) return Promise.resolve(false);
    return fetch(DB.refreshUrl)
      .then(r => (r.ok ? r.json() : null))
      .then(raw => {
        if (!Array.isArray(raw) || !raw.length) return false;
        // 번들본과 같은 형태로 맞춘다 (분류/포켓몬 매칭은 빌드 때 계산된 것을 재사용)
        const known = new Map(DB.events.map(e => [e.eventID || e.id, e]));
        const merged = raw.filter(e => e.start).map(e => {
          const old = known.get(e.eventID);
          return {
            id: e.eventID,
            name: e.name,
            type: e.eventType,
            cat: old ? old.cat : 'event',
            rare: old ? old.rare : false,
            start: e.start,
            end: e.end || e.start,
            link: e.link,
            mons: old ? old.mons : [],
          };
        }).sort((a, b) => a.start.localeCompare(b.start));

        const changed = merged.length !== DB.events.length
          || merged.some((e, i) => !DB.events[i] || e.id !== DB.events[i].id || e.start !== DB.events[i].start);
        if (changed) {
          DB.events = merged;
          DB.refreshedAt = new Date().toISOString();
        }
        return changed;
      })
      .catch(() => false);
  }

  global.PGOEvents = {
    CAT, load, refresh, label,
    MODES, MODE_LABEL, RAID_56, RAID_LIKE, PERK,
    setTierResolver, setClassResolver, hasSpecial, bestTier, match,
    raidGroups, raidTier, isShadowRaid,
    get db() { return DB; },
    all, raids, forDay, forMonth, upcoming,
    ymd, parse, fmtTime, fmtDate, fmtRange, onDay, startsOn, isTimed, DOW,
    cat: c => CAT[c] || CAT.event,
  };
})(window);
