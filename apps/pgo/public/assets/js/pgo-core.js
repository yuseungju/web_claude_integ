/**
 * PGO 분석 엔진 — 데이터 로딩 + 포켓몬GO 스탯/CP/타입/랭킹 계산
 *
 * 이 파일은 /pgo/ 앱 전용이다. 기존 SAP 사이트(/assets/*)와 어떤 것도 공유하지 않는다.
 * 전역 오염을 막기 위해 모든 것을 window.PGO 하나에만 노출한다.
 *
 * 종족값은 tools/build-pgo-godata.js 가 만든 godex.json 의 **게임 내 실측값**이다.
 * (예전 메인시리즈 환산식은 더 이상 쓰지 않는다.)
 */
(function (global) {
  'use strict';

  // ── 파워업 배율(CPM): 레벨 1.0 ~ 51.0, 0.5 단위 ───────────────
  const CPM = {
    1: 0.094, 1.5: 0.1351374, 2: 0.16639787, 2.5: 0.192650919,
    3: 0.21573247, 3.5: 0.236572661, 4: 0.25572005, 4.5: 0.273530381,
    5: 0.29024988, 5.5: 0.306057377, 6: 0.3210876, 6.5: 0.335445036,
    7: 0.34921268, 7.5: 0.362457751, 8: 0.37523559, 8.5: 0.387592416,
    9: 0.39956728, 9.5: 0.411193551, 10: 0.42250001, 10.5: 0.432926419,
    11: 0.44310755, 11.5: 0.453059959, 12: 0.46279839, 12.5: 0.472336022,
    13: 0.48168495, 13.5: 0.490855920, 14: 0.49985844, 14.5: 0.508701765,
    15: 0.51739395, 15.5: 0.525942511, 16: 0.53435433, 16.5: 0.542635767,
    17: 0.55079269, 17.5: 0.558830576, 18: 0.56675452, 18.5: 0.574569153,
    19: 0.58227891, 19.5: 0.589887917, 20: 0.59740001, 20.5: 0.604818814,
    21: 0.61215729, 21.5: 0.619399365, 22: 0.62656713, 22.5: 0.633644533,
    23: 0.64065295, 23.5: 0.647576426, 24: 0.65443563, 24.5: 0.661214806,
    25: 0.667934, 25.5: 0.674577537, 26: 0.68116492, 26.5: 0.687680648,
    27: 0.69414365, 27.5: 0.700538673, 28: 0.70688421, 28.5: 0.713164996,
    29: 0.71939909, 29.5: 0.725571552, 30: 0.7317, 30.5: 0.734741009,
    31: 0.73776948, 31.5: 0.740785574, 32: 0.74378943, 32.5: 0.746781211,
    33: 0.74976104, 33.5: 0.752729087, 34: 0.75568551, 34.5: 0.758630378,
    35: 0.76156384, 35.5: 0.764486065, 36: 0.76739717, 36.5: 0.770297266,
    37: 0.7731865, 37.5: 0.776064962, 38: 0.77893275, 38.5: 0.781790055,
    39: 0.78463697, 39.5: 0.787473578, 40: 0.79030001, 40.5: 0.792803968,
    41: 0.79530001, 41.5: 0.797803921, 42: 0.80030001, 42.5: 0.802803814,
    43: 0.80530001, 43.5: 0.807803703, 44: 0.81030001, 44.5: 0.812803582,
    45: 0.81530001, 45.5: 0.817803451, 46: 0.82030001, 46.5: 0.822803312,
    47: 0.82530001, 47.5: 0.827803165, 48: 0.83030001, 48.5: 0.832803011,
    49: 0.83530001, 49.5: 0.837802851, 50: 0.84029999, 50.5: 0.842802879,
    51: 0.84529999,
  };
  Object.freeze(CPM);

  const LEVELS = Object.keys(CPM).map(Number).sort((a, b) => a - b);

  const MAX_LEVEL_WILD = 35;   // 야생 최대 (날씨부스트 포함)
  const MAX_LEVEL_TRADE = 40;  // 일반 파워업 상한
  const MAX_LEVEL_XL = 50;     // XL사탕 상한

  // ── 타입 상성 배율 ────────────────────────────────────────────
  const EFF = { DOUBLE_RESIST: 0.390625, RESIST: 0.625, NEUTRAL: 1, SUPER: 1.6 };
  const STAB = 1.2;

  // ── 랭킹 계산 상수 ────────────────────────────────────────────
  const RANK_LEVEL = 40;        // 랭킹 산출 기준 레벨 (개체값 15/15/15)
  const TARGET_DEF = 180;       // 가상 레이드 보스 방어 종족값
  const ENEMY_DPS_K = 900;      // 피격 DPS 근사 상수 (적DPS ≈ K / 방어력)

  const TYPE_COLOR = {
    1: '#9fa19f', 2: '#ff8000', 3: '#81b9ef', 4: '#9141cb', 5: '#915121',
    6: '#afa981', 7: '#91a119', 8: '#704170', 9: '#60a1b8', 10: '#e62829',
    11: '#2980ef', 12: '#3fa129', 13: '#fac000', 14: '#ef4179', 15: '#3dcef3',
    16: '#5060e1', 17: '#624d4e', 18: '#ef70ef',
  };

  /** 등급(계열) 정의 — godex.json 의 c 필드 */
  const CLASSES = [
    { id: 0, ko: '일반', color: '#8c98b4' },
    { id: 1, ko: '전설', color: '#ffcb05' },
    { id: 2, ko: '환상', color: '#ff7ad9' },
    { id: 3, ko: '울트라비스트', color: '#59e0c5' },
    { id: 4, ko: '메가', color: '#ff8f5f' },
  ];
  const CLASS_BY_ID = {};
  CLASSES.forEach(c => { CLASS_BY_ID[c.id] = c; });

  /**
   * 보유 판정 등급 — 화면에서 가장 먼저 보이는 값.
   * 진화 전 포켓몬은 최종진화(및 메가) 기준으로 판정하므로,
   * 미뇽처럼 지금은 약해도 망나뇽이 되면 강한 종은 상위 등급을 받는다.
   * cut 은 잠재력 순위 백분위 상한.
   */
  const TIERS = [
    { id: 0, ko: '필수 보유', short: 'S', cut: 0.03, color: '#ffcb05', desc: '최상위권. 무조건 키운다' },
    { id: 1, ko: '보유',      short: 'A', cut: 0.15, color: '#3fcf8e', desc: '실전에서 제 몫을 한다' },
    { id: 2, ko: '보통',      short: 'B', cut: 0.45, color: '#6fc9ff', desc: '아쉬우면 쓸 만한 수준' },
    { id: 3, ko: '버림',      short: 'C', cut: 1.00, color: '#ee6b6b', desc: '사탕용. 키울 가치 없음' },
  ];
  const TIER_BY_ID = {};
  TIERS.forEach(t => { TIER_BY_ID[t.id] = t; });

  // ── 상태 ──────────────────────────────────────────────────────
  let DB = null;
  const typeById = {};

  /** CP = floor( (공+IV) * sqrt(방+IV) * sqrt(체+IV) * CPM^2 / 10 ), 최소 10 */
  function cp(go, iv, level) {
    const m = CPM[level];
    if (!m) return null;
    const v = (go.atk + iv.a) * Math.sqrt(go.def + iv.d) * Math.sqrt(go.sta + iv.s) * m * m / 10;
    return Math.max(10, Math.floor(v));
  }

  /** 표시 HP = floor((체력 + IV) * CPM), 최소 10 */
  function hp(go, iv, level) {
    const m = CPM[level];
    if (!m) return null;
    return Math.max(10, Math.floor((go.sta + iv.s) * m));
  }

  const IV_PERFECT = { a: 15, d: 15, s: 15 };

  function maxCp(go, level) {
    return cp(go, IV_PERFECT, level || MAX_LEVEL_XL);
  }

  // ── 개체값 역산 ──────────────────────────────────────────────
  /**
   * 표시 CP(+HP)로 가능한 (레벨, 개체값) 조합을 모두 찾는다.
   * @param levels 검사할 레벨 배열
   * @param targetHp null 이면 CP만으로 판정
   * @param ivMin 최소 개체값 (레이드·알 산출물은 10)
   */
  function solveIV(p, targetCp, targetHp, levels, ivMin) {
    const min = ivMin || 0;
    const out = [];
    for (const level of levels) {
      const m = CPM[level];
      if (!m) continue;

      // HP를 알면 체력 개체값을 먼저 좁힌다
      let sMin = min, sMax = 15;
      if (targetHp != null) {
        let lo = null, hi = null;
        for (let s = min; s <= 15; s++) {
          if (Math.max(10, Math.floor((p.go.sta + s) * m)) === targetHp) {
            if (lo === null) lo = s;
            hi = s;
          }
        }
        if (lo === null) continue;
        sMin = lo; sMax = hi;
      }

      for (let a = min; a <= 15; a++) {
        for (let d = min; d <= 15; d++) {
          for (let s = sMin; s <= sMax; s++) {
            if (cp(p.go, { a, d, s }, level) !== targetCp) continue;
            out.push({ level, a, d, s, total: a + d + s });
          }
        }
      }
    }
    out.sort((x, y) => y.total - x.total || x.level - y.level);
    return out;
  }

  /** 해당 레벨에서 개체값 만렙(15/15/15)일 때의 CP */
  const perfectCp = (p, level) => cp(p.go, IV_PERFECT, level);

  // ── 타입 계산 ────────────────────────────────────────────────
  function effectiveness(attackTypeId, defenderTypeIds) {
    return defenderTypeIds.reduce((m, t) => m * (DB.chart[attackTypeId]?.[t] ?? 1), 1);
  }

  function defenseProfile(defenderTypeIds) {
    const out = {};
    DB.types.forEach(t => { out[t.id] = effectiveness(t.id, defenderTypeIds); });
    return out;
  }

  function bestStab(attackerTypeIds, defenderTypeIds) {
    return attackerTypeIds.reduce((best, t) => Math.max(best, effectiveness(t, defenderTypeIds)), 0);
  }

  // ── 전투력 계산 (레이드 기준) ─────────────────────────────────
  /** GO 피해 공식: floor(0.5 * 위력 * 공/방 * 자속 * 상성) + 1 */
  function moveDamage(move, atkEff, targetDef, typeIds, targetTypes) {
    const stab = typeIds.includes(move.t) ? STAB : 1;
    const eff = targetTypes ? effectiveness(move.t, targetTypes) : 1;
    return Math.floor(0.5 * move.p * (atkEff / targetDef) * stab * eff) + 1;
  }

  /**
   * 속공 1개 + 차지 1개 조합의 사이클 DPS.
   * 차지기 1회를 쓰기 위해 필요한 속공 횟수 n = ceil(소모에너지 / 획득에너지)
   */
  function pairDps(fast, charged, atkEff, typeIds, targetTypes, targetDef) {
    if (!fast || !charged || !fast.e) return 0;
    const def = targetDef || TARGET_DEF;
    const n = Math.ceil(charged.e / fast.e);
    const cycleTime = (n * fast.d + charged.d) / 1000;
    if (cycleTime <= 0) return 0;
    const dmg = n * moveDamage(fast, atkEff, def, typeIds, targetTypes)
      + moveDamage(charged, atkEff, def, typeIds, targetTypes);
    return dmg / cycleTime;
  }

  /** 레벨 40 · 개체값 15/15/15 기준 실효 능력치 */
  function effStats(p) {
    const m = CPM[RANK_LEVEL];
    return {
      atk: (p.s[0] + 15) * m,
      def: (p.s[1] + 15) * m,
      hp: Math.floor((p.s[2] + 15) * m),
    };
  }

  /** 한쪽이 상대에게 낼 수 있는 최고 DPS 조합 (상대의 실제 방어력·타입 반영) */
  function bestAgainst(p, target) {
    const me = effStats(p);
    const t = effStats(target);
    let best = { dps: 0, fast: null, charged: null };
    for (const fi of p.fm) {
      const fast = DB.moves[fi];
      for (const ci of p.cm) {
        const charged = DB.moves[ci];
        const dps = pairDps(fast, charged, me.atk, p.t, target.t, t.def);
        if (dps > best.dps) best = { dps, fast, charged };
      }
    }
    return Object.assign(best, {
      eff: best.fast ? effectiveness(best.fast.t, target.t) : 1,
      effCharged: best.charged ? effectiveness(best.charged.t, target.t) : 1,
      stab: best.fast ? p.t.includes(best.fast.t) : false,
    });
  }

  /**
   * 1:1 대결 판정 — 서로 최선의 기술로 동시에 때린다고 보고,
   * 상대를 먼저 쓰러뜨리는 쪽이 이긴다. (레벨 40 · 개체값 15/15/15 동일 조건)
   */
  function duel(a, b) {
    const sa = effStats(a), sb = effStats(b);
    const atkA = bestAgainst(a, b);
    const atkB = bestAgainst(b, a);

    // 상대를 쓰러뜨리는 데 걸리는 시간 (초). DPS 가 0이면 영원히 못 이긴다.
    const ttkA = atkA.dps > 0 ? sb.hp / atkA.dps : Infinity;
    const ttkB = atkB.dps > 0 ? sa.hp / atkB.dps : Infinity;

    let winner = null;
    if (ttkA < ttkB) winner = a;
    else if (ttkB < ttkA) winner = b;

    // 승패 여유 — 시간 차가 클수록 일방적이다
    const margin = (ttkA === Infinity || ttkB === Infinity) ? 1
      : Math.abs(ttkA - ttkB) / Math.max(ttkA, ttkB);

    return { a, b, sa, sb, atkA, atkB, ttkA, ttkB, winner, margin };
  }

  /**
   * 최적 기술 조합의 DPS / TDO / ER 계산.
   * targetTypes 를 주면 그 상대 기준, 없으면 상성 중립(범용) 기준.
   */
  function combatRating(p, targetTypes) {
    const m = CPM[RANK_LEVEL];
    const atkEff = (p.s[0] + 15) * m;
    const defEff = (p.s[1] + 15) * m;
    const hpEff = Math.floor((p.s[2] + 15) * m);

    let best = { dps: 0, fast: null, charged: null };
    for (const fi of p.fm) {
      const fast = DB.moves[fi];
      for (const ci of p.cm) {
        const charged = DB.moves[ci];
        const dps = pairDps(fast, charged, atkEff, p.t, targetTypes);
        if (dps > best.dps) best = { dps, fast, charged };
      }
    }

    // 피격 DPS 근사 -> 생존 시간 -> 총 피해량
    const enemyDps = ENEMY_DPS_K / defEff;
    const survival = hpEff / enemyDps;
    const tdo = best.dps * survival;
    // 공격 성능에 가중치를 둔 종합 지표 (DPS^3 x TDO 의 4제곱근)
    const er = Math.pow(Math.pow(best.dps, 3) * tdo, 0.25);

    return {
      dps: best.dps, tdo, er, survival,
      fast: best.fast, charged: best.charged,
      atkEff, defEff, hpEff,
      bulk: defEff * hpEff / 1000,
    };
  }

  // ── 랭킹 부여 ────────────────────────────────────────────────
  /** list 를 metric 내림차순으로 정렬해 1위부터 순번을 매긴다 */
  function assignRanks(list, metric, writeKey) {
    [...list].sort((a, b) => b.rating[metric] - a.rating[metric])
      .forEach((p, i) => { p.rank[writeKey] = i + 1; });
  }

  /**
   * 진화 체인 잠재력 — 자신 · 진화 후손 · 각자의 메가 중 가장 높은 ER.
   * 진화 전 포켓몬이 최종진화 기준으로 평가되도록 한다.
   */
  function buildPotential() {
    const byKey = new Map(DB.pokemon.map(p => [p.k, p]));
    const memo = new Map();
    const visiting = new Set();

    function best(p) {
      if (memo.has(p.k)) return memo.get(p.k);
      if (visiting.has(p.k)) return { er: p.rating.er, src: p };   // 순환 방어
      visiting.add(p.k);

      let out = { er: p.rating.er, src: p };
      const take = c => { if (c && c.er > out.er) out = c; };

      (p.mg || []).forEach(k => {
        const m = byKey.get(k);
        if (m && m.r) take({ er: m.rating.er, src: m });
      });
      (p.ev || []).forEach(k => {
        const child = byKey.get(k);
        if (child) take(best(child));
      });

      visiting.delete(p.k);
      memo.set(p.k, out);
      return out;
    }

    DB.pokemon.forEach(p => {
      const b = best(p);
      p.potential = {
        er: b.er,
        src: b.src,
        inherited: b.src.k !== p.k,        // 자기 자신이 아니라 진화형에서 온 값인지
      };
    });
  }

  /**
   * 잠재력 순위 백분위로 보유/버림 등급을 매긴다.
   * 잠재력이 같으면(같은 진화 체인이라 값이 동일한 경우가 많다) 반드시 같은 등급이
   * 되도록, 등급·순위 모두 동점 그룹의 첫 번째 위치를 기준으로 계산한다.
   */
  function assignTiers(all) {
    const sorted = [...all].sort((a, b) => b.potential.er - a.potential.er);
    const tierAt = pct => (TIERS.find(t => pct <= t.cut) || TIERS[TIERS.length - 1]).id;

    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j < sorted.length && sorted[j].potential.er === sorted[i].potential.er) j++;
      const tierId = tierAt((i + 1) / sorted.length);
      for (let k = i; k < j; k++) {
        sorted[k].tier = tierId;
        sorted[k].potentialRank = i + 1;      // 동점은 같은 순위
      }
      i = j;
    }
    DB.totals.potential = sorted.length;
    // 미출시 폼은 순위 대상이 아니므로 최하위 등급으로 둔다
    DB.pokemon.filter(p => !p.r).forEach(p => {
      p.tier = TIERS[TIERS.length - 1].id;
      p.potentialRank = null;
    });
  }

  function buildRankings() {
    DB.pokemon.forEach(p => {
      p.rating = combatRating(p);
      p.rank = {};
    });

    buildPotential();

    // 미출시 폼(게임 파일에만 있는 데이터)은 순위 산정에서 제외한다
    const all = DB.pokemon.filter(p => p.r);

    // 전체 랭킹
    assignRanks(all, 'er', 'overall');
    assignRanks(all, 'dps', 'dps');
    assignRanks(all, 'bulk', 'bulk');
    // 리뷰에서 '상위 몇 %' 근거로 쓰려고 종족값 순위도 따로 매긴다
    [['atk', 0], ['def', 1], ['sta', 2]].forEach(([key, i]) => {
      [...all].sort((a, b) => b.s[i] - a.s[i])
        .forEach((p, n) => { p.rank[key] = n + 1; });
    });
    DB.totals = { overall: all.length };

    // 계열별 랭킹 — 등급 / 타입 / 세대
    const groupRank = (keyFn, rankKey, totalKey) => {
      const groups = new Map();
      all.forEach(p => {
        for (const g of keyFn(p)) {
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(p);
        }
      });
      const totals = {};
      groups.forEach((list, g) => {
        totals[g] = list.length;
        [...list].sort((a, b) => b.rating.er - a.rating.er)
          .forEach((p, i) => { p.rank[rankKey] = p.rank[rankKey] || {}; p.rank[rankKey][g] = i + 1; });
      });
      DB.totals[totalKey] = totals;
    };

    assignTiers(all);

    groupRank(p => [p.c], 'byClass', 'byClass');
    groupRank(p => p.t, 'byType', 'byType');
    groupRank(p => [p.g], 'byGen', 'byGen');

    // 카드/검색에 바로 쓰는 대표 순위: 자기 등급 안에서의 순위
    all.forEach(p => {
      p.rank.classRank = p.rank.byClass[p.c];
      p.rank.classTotal = DB.totals.byClass[p.c];
    });
  }

  // ── 조회 헬퍼 ────────────────────────────────────────────────
  function typeName(id) { return typeById[id]?.ko || String(id); }
  function typeColor(id) { return TYPE_COLOR[id] || '#888'; }
  function className(c) { return CLASS_BY_ID[c]?.ko || '일반'; }
  function classColor(c) { return CLASS_BY_ID[c]?.color || '#8c98b4'; }
  function tier(p) { return TIER_BY_ID[p.tier] || TIERS[TIERS.length - 1]; }

  /** godex.json 의 n 은 폼까지 포함한 완전한 한국어명이라 그대로 쓴다 (예: '메가이상해꽃') */
  function displayName(p) { return p.n; }

  /** 스프라이트는 tools/fetch-pgo-sprites.js 로 저장소에 번들되어 있다 (외부 CDN 미사용) */
  function spriteUrl(p) {
    return `/pgo/assets/sprites/${p.i}.png`;
  }

  function matches(p, q) {
    if (!q) return true;
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return p.n.toLowerCase().includes(s)
      || p.k.toLowerCase().replace(/_/g, ' ').includes(s)
      || String(p.d) === s
      || (p.f && p.f.toLowerCase().includes(s));
  }

  // ── 초기화 ───────────────────────────────────────────────────
  let loadPromise = null;
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = fetch('/pgo/assets/data/godex.json')
      .then(res => {
        if (!res.ok) throw new Error(`도감 데이터를 불러오지 못했습니다 (HTTP ${res.status})`);
        return res.json();
      })
      .then(json => {
        DB = json;
        DB.types.forEach(t => { typeById[t.id] = t; });

        DB.pokemon.forEach((p, idx) => {
          p.idx = idx;                                  // 화면에서 쓰는 고유 인덱스
          p.go = { atk: p.s[0], def: p.s[1], sta: p.s[2] };
          p.maxCp = maxCp(p.go, MAX_LEVEL_XL);
          p.cp40 = maxCp(p.go, MAX_LEVEL_TRADE);
          p.bulk = Math.round(p.go.def * p.go.sta / 100);
        });

        buildRankings();
        return DB;
      });
    return loadPromise;
  }

  global.PGO = {
    CPM, LEVELS, EFF, STAB, MAX_LEVEL_WILD, MAX_LEVEL_TRADE, MAX_LEVEL_XL, IV_PERFECT,
    RANK_LEVEL, TARGET_DEF, CLASSES, TIERS,
    load,
    get db() { return DB; },
    get pokemon() { return DB ? DB.pokemon : []; },
    get types() { return DB ? DB.types : []; },
    get moves() { return DB ? DB.moves : []; },
    get totals() { return DB ? DB.totals : {}; },
    cp, hp, maxCp, solveIV, perfectCp,
    effectiveness, defenseProfile, bestStab,
    combatRating, pairDps, moveDamage, duel, bestAgainst, effStats,
    typeName, typeColor, className, classColor, tier,
    displayName, spriteUrl, matches,
  };
})(window);
