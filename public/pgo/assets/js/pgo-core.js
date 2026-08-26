/**
 * PGO 분석 엔진 — 데이터 로딩 + 포켓몬GO 스탯/CP/타입 계산
 *
 * 이 파일은 /pgo/ 앱 전용이다. 기존 SAP 사이트(/assets/*)와 어떤 것도 공유하지 않는다.
 * 전역 오염을 막기 위해 모든 것을 window.PGO 하나에만 노출한다.
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

  const TYPE_COLOR = {
    1: '#9fa19f', 2: '#ff8000', 3: '#81b9ef', 4: '#9141cb', 5: '#915121',
    6: '#afa981', 7: '#91a119', 8: '#704170', 9: '#60a1b8', 10: '#e62829',
    11: '#2980ef', 12: '#3fa129', 13: '#fac000', 14: '#ef4179', 15: '#3dcef3',
    16: '#5060e1', 17: '#624d4e', 18: '#ef70ef',
  };

  // ── 상태 ──────────────────────────────────────────────────────
  let DB = null;   // { types, chart, pokemon }
  const typeById = {};

  /**
   * 메인시리즈 종족값 -> 포켓몬GO 종족값(근사 환산).
   * Niantic이 개별 조정한 종이 일부 있어 실제 게임 수치와 1~2 차이가 날 수 있다.
   *   ScaledAtk = round(2 * (7/8*max(공,특공) + 1/8*min(공,특공)))
   *   ScaledDef = round(2 * (5/8*max(방,특방) + 3/8*min(방,특방)))
   *   SpeedMod  = 1 + (스피드 - 75) / 500
   *   체력      = floor(HP * 1.75 + 50)
   */
  function toGoStats(s) {
    const [hp, atk, def, spa, spd, spe] = s;
    const scaledAtk = Math.round(2 * ((7 / 8) * Math.max(atk, spa) + (1 / 8) * Math.min(atk, spa)));
    const scaledDef = Math.round(2 * ((5 / 8) * Math.max(def, spd) + (3 / 8) * Math.min(def, spd)));
    const speedMod = 1 + (spe - 75) / 500;
    return {
      atk: Math.round(scaledAtk * speedMod),
      def: Math.round(scaledDef * speedMod),
      sta: Math.floor(hp * 1.75 + 50),
    };
  }

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

  /** 개체값 만렙 기준 최대 CP */
  function maxCp(go, level) {
    return cp(go, IV_PERFECT, level || MAX_LEVEL_XL);
  }

  // ── 타입 계산 ────────────────────────────────────────────────
  /** 공격타입 -> 방어타입 조합에 대한 최종 배율 */
  function effectiveness(attackTypeId, defenderTypeIds) {
    return defenderTypeIds.reduce((m, t) => m * (DB.chart[attackTypeId]?.[t] ?? 1), 1);
  }

  /** 방어자 기준 18타입 전체 피해배율 { typeId: 배율 } */
  function defenseProfile(defenderTypeIds) {
    const out = {};
    DB.types.forEach(t => { out[t.id] = effectiveness(t.id, defenderTypeIds); });
    return out;
  }

  /** 공격자 타입 조합이 상대에게 낼 수 있는 최고 배율 (STAB 기준 최선의 자속기 가정) */
  function bestStab(attackerTypeIds, defenderTypeIds) {
    return attackerTypeIds.reduce((best, t) => Math.max(best, effectiveness(t, defenderTypeIds)), 0);
  }

  // ── 조회 헬퍼 ────────────────────────────────────────────────
  function typeName(id) { return typeById[id]?.ko || String(id); }
  function typeColor(id) { return TYPE_COLOR[id] || '#888'; }

  /** 표시용 이름: 폼이 있으면 "리자몽 (메가 X)" */
  function displayName(p) { return p.f ? `${p.n} (${p.f})` : p.n; }

  /** 스프라이트는 tools/fetch-pgo-sprites.js 로 저장소에 번들되어 있다 (외부 CDN 미사용) */
  function spriteUrl(p) {
    return `/pgo/assets/sprites/${p.i}.png`;
  }

  /** 검색어 매칭 (한글명/영문명/도감번호) */
  function matches(p, q) {
    if (!q) return true;
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return p.n.toLowerCase().includes(s)
      || p.e.toLowerCase().includes(s)
      || String(p.d) === s
      || (p.f && p.f.toLowerCase().includes(s));
  }

  // ── 초기화 ───────────────────────────────────────────────────
  function overrideKey(p) { return p.f ? `${p.d}:${p.f}` : String(p.d); }

  async function fetchJson(url, required) {
    const res = await fetch(url);
    if (!res.ok) {
      if (required) throw new Error(`${url} 를 불러오지 못했습니다 (HTTP ${res.status})`);
      return null;
    }
    return res.json();
  }

  let loadPromise = null;
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const [dex, overrides] = await Promise.all([
        fetchJson('/pgo/assets/data/pokedex.json', true),
        fetchJson('/pgo/assets/data/go-overrides.json', false).catch(() => null),
      ]);

      DB = dex;
      DB.types.forEach(t => { typeById[t.id] = t; });

      // 파생값을 미리 계산해 매 렌더마다 재계산하지 않게 한다
      DB.pokemon.forEach(p => {
        const ov = overrides && overrides[overrideKey(p)];
        if (Array.isArray(ov)) {
          p.go = { atk: ov[0], def: ov[1], sta: ov[2] };
          p.measured = true;            // 게임 내 실측값 (환산식 예외 종)
        } else {
          p.go = toGoStats(p.s);
          p.measured = false;           // 메인시리즈 종족값 환산
        }
        p.maxCp = maxCp(p.go, MAX_LEVEL_XL);
        p.cp40 = maxCp(p.go, MAX_LEVEL_TRADE);
        p.bulk = Math.round(p.go.def * p.go.sta / 100);
      });

      return DB;
    })();
    return loadPromise;
  }

  global.PGO = {
    CPM, LEVELS, EFF, MAX_LEVEL_WILD, MAX_LEVEL_TRADE, MAX_LEVEL_XL, IV_PERFECT,
    load,
    get db() { return DB; },
    get pokemon() { return DB ? DB.pokemon : []; },
    get types() { return DB ? DB.types : []; },
    toGoStats, cp, hp, maxCp,
    effectiveness, defenseProfile, bestStab,
    typeName, typeColor, displayName, spriteUrl, matches,
  };
})(window);
