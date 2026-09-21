/**
 * 포켓몬GO 실측 데이터 빌드 (빌드 타임 1회 실행)
 *
 *   node tools/build-pgo-godata.js
 *
 * 입력
 *   - pokemon-go-api pokedex.json (원격) : 실제 GO 종족값 · 한국어명 · PvE 기술 수치 · 전설/환상 분류
 *   - public/pgo/assets/data/pokedex.json (로컬, build-pgo-data.js 산출물) : 타입 상성표 + 스프라이트 id 매핑
 *
 * 출력
 *   - public/pgo/assets/data/godex.json : 런타임이 읽는 유일한 데이터 파일
 *
 * 종족값이 환산치가 아닌 게임 실측값이므로 go-overrides.json 같은 보정 테이블이 필요 없다.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = 'https://pokemon-go-api.github.io/pokemon-go-api/api/pokedex.json';
const SRC_PVPOKE = 'https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/gamemaster.json';
const DEX = path.join(__dirname, '..', 'apps', 'pgo', 'public', 'assets', 'data', 'pokedex.json');
const OUT = path.join(__dirname, '..', 'apps', 'pgo', 'public', 'assets', 'data', 'godex.json');
const SPRITE_DIR = path.join(__dirname, '..', 'apps', 'pgo', 'public', 'assets', 'sprites');

/** 등급 코드 */
const CLASS = { LEGENDARY: 1, MYTHIC: 2, ULTRA_BEAST: 3 };
const CLASS_MEGA = 4;

/** GO 폼 키 -> PokeAPI 이름 조각 (스프라이트 매칭용) */
const FORM_ALIAS = { galarian: 'galar', hisuian: 'hisui', paldean: 'paldea', alolan: 'alola' };

/**
 * GO 폼 키 -> 필터용 폼 태그.
 * pokemon-go-api 의 names.Korean 이 이미 폼까지 포함한 완전한 표시명이므로
 * (예: '메가이상해꽃', '알로라 꼬렛', '화이트큐레무') 이 태그는 표시가 아니라
 * "메가만 보기" 같은 분류 필터에만 쓴다.
 */
const FORM_TAG = [
  [/_MEGA(_X|_Y)?$/, '메가'], [/_PRIMAL$/, '원시'],
  [/_ALOLA$/, '알로라'], [/_GALARIAN$/, '가라르'],
  [/_HISUIAN$/, '히스이'], [/_PALDEA/, '팔데아'],
];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }).on('error', reject);
  });
}

function main() {
  const local = JSON.parse(fs.readFileSync(DEX, 'utf8'));

  // 타입 영문명 -> 내부 타입 id
  const typeIdByEn = {};
  local.types.forEach(t => { typeIdByEn[t.en] = t.id; });
  const goType = s => typeIdByEn[String(s || '').replace('POKEMON_TYPE_', '').toLowerCase()] || null;

  // 스프라이트 id 매핑 준비
  const spriteByEn = new Map(local.pokemon.map(p => [p.e, p.i]));
  const spriteByDex = new Map(local.pokemon.filter(p => !p.f).map(p => [p.d, p.i]));
  const hasSprite = id => fs.existsSync(path.join(SPRITE_DIR, `${id}.png`));

  /** GO 키(RATTATA_ALOLA / CHARIZARD_MEGA_X) -> 번들된 스프라이트 id, 없으면 기본 폼으로 폴백 */
  function spriteId(goKey, dexNr) {
    let name = String(goKey).toLowerCase().replace(/_/g, '-');
    for (const [from, to] of Object.entries(FORM_ALIAS)) name = name.replace(from, to);
    const hit = spriteByEn.get(name);
    if (hit && hasSprite(hit)) return hit;
    const base = spriteByDex.get(dexNr);
    return base && hasSprite(base) ? base : null;
  }

  function formTag(goKey, baseKey) {
    const suffix = String(goKey).replace(new RegExp(`^${baseKey}_?`), '');
    if (!suffix) return '';
    for (const [re, tag] of FORM_TAG) if (re.test(goKey)) return tag;
    return '기타폼';
  }

  /** 폼 키에서 사람이 읽을 수 있는 접미사만 뽑는다 (PLANT -> plant) */
  function formSuffix(goKey, baseKey) {
    return String(goKey).replace(new RegExp(`^${baseKey}_?`), '').replace(/_/g, ' ').toLowerCase();
  }

  // ── 기술 사전 ────────────────────────────────────────────
  const moveIndex = new Map();   // moveId -> 배열 인덱스
  const moves = [];

  function addMove(m, isFast) {
    if (!m || !m.id) return null;
    if (moveIndex.has(m.id)) return moveIndex.get(m.id);
    const idx = moves.length;
    moves.push({
      k: m.id,
      n: m.names?.Korean || m.names?.English || m.id,
      t: goType(m.type?.type),
      p: m.power || 0,
      e: Math.abs(m.energy || 0),          // 속공=획득, 차지=소모 (부호 제거)
      d: m.durationMs || 1000,
      f: isFast ? 1 : 0,
    });
    moveIndex.set(m.id, idx);
    return idx;
  }

  const moveList = (obj, elite, isFast) => {
    const out = [];
    for (const src of [obj, elite]) {
      for (const m of Object.values(src || {})) {
        const i = addMove(m, isFast);
        if (i !== null && !out.includes(i)) out.push(i);
      }
    }
    return out;
  };

  // ── 포켓몬 목록 ──────────────────────────────────────────
  const pokemon = [];
  let noSprite = 0, noMoves = 0;

  function push(entry, opts) {
    const { key, dexNr, gen, cls, inheritMoves } = opts;
    const st = entry.stats;
    if (!st) return;

    const types = [goType(entry.primaryType?.type), goType(entry.secondaryType?.type)].filter(Boolean);
    const sprite = spriteId(key, dexNr);
    if (!sprite) noSprite++;

    const fm = inheritMoves ? inheritMoves.fm : moveList(entry.quickMoves, entry.eliteQuickMoves, true);
    const cm = inheritMoves ? inheritMoves.cm : moveList(entry.cinematicMoves, entry.eliteCinematicMoves, false);
    if (!fm.length || !cm.length) noMoves++;

    pokemon.push({
      k: key,
      r: opts.released ? 1 : 0,     // 게임에 실제 출시된 폼인지
      i: sprite,
      d: dexNr,
      n: entry.names?.Korean || entry.names?.English || key,
      en: entry.names?.English || key,   // 이벤트 데이터(영문)와 매칭용
      f: opts.form || '',
      suffix: opts.suffix || '',
      g: gen,
      c: cls,
      t: types,
      s: [st.attack, st.defense, st.stamina],
      fm, cm,
      ev: opts.evolutions || [],   // 진화 대상 키 (원본 표기, 아래에서 실제 키로 정규화)
      mg: opts.megas || [],        // 메가진화 키
    });
  }

  return Promise.all([get(SRC), get(SRC_PVPOKE)]).then(([raw, rawPv]) => {
    const go = JSON.parse(raw);

    // pvpoke gamemaster 의 released 플래그로 미출시 폼(예: 무한다이맥스)을 걸러낸다.
    const pv = JSON.parse(rawPv);
    const releasedIds = new Set(
      pv.pokemon.filter(x => x.released !== false).map(x => x.speciesId),
    );
    const pvKnown = new Set(pv.pokemon.map(x => x.speciesId));
    /** GO 키 -> pvpoke speciesId 표기 차이 보정 */
    const pvId = goKey => String(goKey).toLowerCase()
      .replace(/_alola$/, '_alolan').replace(/_paldea$/, '_paldean');
    /** pvpoke 에 없는 항목은 판단 불가이므로 출시된 것으로 본다 */
    const isReleased = goKey => {
      const id = pvId(goKey);
      return pvKnown.has(id) ? releasedIds.has(id) : true;
    };

    for (const p of go) {
      const cls = CLASS[String(p.pokemonClass || '').replace('POKEMON_CLASS_', '')] || 0;
      push(p, {
        key: p.id, dexNr: p.dexNr, gen: p.generation, cls, form: '',
        released: isReleased(p.id),
        evolutions: (p.evolutions || []).map(e => [e.formId, e.id]),
        megas: Object.keys(p.megaEvolutions || {}),
      });
      const base = pokemon[pokemon.length - 1];

      for (const [key, f] of Object.entries(p.regionForms || {})) {
        const fCls = CLASS[String(f.pokemonClass || '').replace('POKEMON_CLASS_', '')] || cls;
        push(f, {
          key, dexNr: p.dexNr, gen: p.generation, cls: fCls,
          form: formTag(key, p.id), suffix: formSuffix(key, p.id), released: isReleased(key),
          evolutions: (f.evolutions || []).map(e => [e.formId, e.id]),
          megas: Object.keys(f.megaEvolutions || {}),
        });
      }

      // 메가는 자체 기술이 없다 — 기본 폼의 기술 풀을 그대로 쓴다 (게임 동작과 동일)
      for (const [key, m] of Object.entries(p.megaEvolutions || {})) {
        push(m, {
          key, dexNr: p.dexNr, gen: p.generation, cls: CLASS_MEGA,
          form: formTag(key, p.id), suffix: formSuffix(key, p.id), released: isReleased(key),
          inheritMoves: base ? { fm: base.fm, cm: base.cm } : null,
        });
      }
    }

    // ── 후처리 1: 외형만 다른 폼 제거 ──────────────────────
    // 안농 A~Z 처럼 종족값·타입·기술이 기본 폼과 완전히 같은 폼은 순위를 오염시키므로 버린다.
    const baseByDex = new Map();
    pokemon.forEach(p => { if (!p.f && !baseByDex.has(p.d)) baseByDex.set(p.d, p); });
    const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

    const kept = pokemon.filter(p => {
      if (!p.f || p.c === 4) return true;          // 기본 폼과 메가는 항상 유지
      const base = baseByDex.get(p.d);
      if (!base) return true;
      const cosmetic = sameList(p.s, base.s) && sameList(p.t, base.t)
        && sameList(p.fm, base.fm) && sameList(p.cm, base.cm);
      return !cosmetic;
    });
    const dropped = pokemon.length - kept.length;
    pokemon.length = 0;
    pokemon.push(...kept);

    // ── 후처리 2: 같은 표시명 구분 ─────────────────────────
    // pokemon-go-api 의 한국어명이 히스이/가라르 폼을 원종과 똑같이 주는 경우가 있어
    // 이름이 겹치면 폼 태그를 덧붙여 화면에서 구분되게 한다.
    const countNames = () => {
      const c = {};
      pokemon.forEach(p => { c[p.n] = (c[p.n] || 0) + 1; });
      return c;
    };

    let nameCount = countNames();
    pokemon.forEach(p => {
      if (p.f && nameCount[p.n] > 1) p.n = `${p.n} (${p.f})`;
    });

    // 폼 태그를 붙여도 여전히 겹치면(도롱마담 초목/모래/쓰레기 등) 원본 폼 키로 구분한다
    nameCount = countNames();
    pokemon.forEach(p => {
      if (nameCount[p.n] > 1 && p.suffix) {
        p.n = p.n.replace(/\s*\(기타폼\)$/, '') + ` (${p.suffix})`;
      }
    });
    pokemon.forEach(p => { delete p.suffix; });

    // ── 후처리 3: 진화/메가 키 정규화 ─────────────────────
    // 진화 정보의 formId 는 'DRAGONAIR_NORMAL' 처럼 우리 키와 다를 수 있어
    // [formId, id] 후보 중 실제로 존재하는 키만 남긴다. 지역폼은 formId 가 맞고
    // (ARCANINE_HISUIAN), 일반 폼은 id 가 맞다 (DRAGONAIR).
    const keySet = new Set(pokemon.map(p => p.k));
    let evLinks = 0, evDropped = 0;
    pokemon.forEach(p => {
      const out = [];
      for (const cands of p.ev) {
        const hit = cands.find(c => c && keySet.has(c));
        if (hit) { if (!out.includes(hit)) out.push(hit); }
        else evDropped++;
      }
      p.ev = out;
      p.mg = p.mg.filter(k => keySet.has(k));
      evLinks += p.ev.length;
    });

    pokemon.sort((a, b) => a.d - b.d || a.c - b.c || a.k.localeCompare(b.k));

    fs.writeFileSync(OUT, JSON.stringify({
      source: 'pokemon-go-api (https://pokemon-go-api.github.io) + PokeAPI 타입 상성',
      generatedFrom: 'tools/build-pgo-godata.js',
      note: '종족값은 포켓몬GO 게임 내 실측값. 기술 수치는 PvE(레이드) 기준.',
      types: local.types,
      chart: local.chart,
      moves,
      pokemon,
    }));

    const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
    const byClass = pokemon.reduce((a, p) => (a[p.c] = (a[p.c] || 0) + 1, a), {});
    console.log(`완료: ${pokemon.length}종 · 기술 ${moves.length}개 → ${path.relative(process.cwd(), OUT)} (${kb}KB)`);
    console.log(`  등급별: 일반 ${byClass[0] || 0} · 전설 ${byClass[1] || 0} · 환상 ${byClass[2] || 0} · 울트라비스트 ${byClass[3] || 0} · 메가 ${byClass[4] || 0}`);
    console.log(`  진화 링크 ${evLinks}개 (미해결 ${evDropped}개) · 외형전용 폼 제거 ${dropped}종 · 미출시 ${pokemon.filter(p => !p.r).length}종 · 스프라이트 없음 ${noSprite} · 기술 없음 ${noMoves}`);
  });
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
