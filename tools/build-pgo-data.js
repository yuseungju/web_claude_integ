/**
 * PokeAPI GraphQL -> public/pgo/assets/data/pokedex.json 생성 (빌드 타임 1회 실행)
 *
 * 런타임에는 외부 API를 호출하지 않는다. 데이터 갱신이 필요할 때만
 *   node tools/build-pgo-data.js
 * 를 돌려서 JSON을 다시 만든다.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://beta.pokeapi.co/graphql/v1beta';
const OUT = path.join(__dirname, '..', 'public', 'pgo', 'assets', 'data', 'pokedex.json');

// GO에서 의미 있는 폼만 추린다 (코스튬/모양만 다른 폼 제외)
const FORM_KEEP = /-(mega|mega-x|mega-y|primal|alola|galar|hisui|paldea|origin|therian|altered|sky|attack|defense|speed|zen|black|white|resolute|pirouette|blade|dusk-mane|dawn-wings|ultra|crowned|ice|shadow-rider|10|complete|dusk|midnight)$/;

const FORM_LABEL = {
  mega: '메가', 'mega-x': '메가 X', 'mega-y': '메가 Y', primal: '원시',
  alola: '알로라', galar: '가라르', hisui: '히스이', paldea: '팔데아',
  origin: '오리진', therian: '영물', altered: '어나더', sky: '스카이',
  attack: '어택', defense: '디펜스', speed: '스피드', zen: '달마모드',
  black: '블랙', white: '화이트', resolute: '각오', pirouette: '스텝',
  blade: '블레이드', 'dusk-mane': '황혼의갈기', 'dawn-wings': '새벽의날개',
  ultra: '울트라', crowned: '검왕', ice: '아이스', 'shadow-rider': '백마',
  10: '10%', complete: '퍼펙트', dusk: '황혼', midnight: '한밤중',
};

function gql(query) {
  const body = JSON.stringify({ query });
  return new Promise((resolve, reject) => {
    const req = https.request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          resolve(json.data);
        } catch (e) { reject(new Error(`파싱 실패 (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 메인시리즈 damage_factor(0/50/100/200) -> 포켓몬GO 배율 */
function goMultiplier(factor) {
  if (factor === 200) return 1.6;
  if (factor === 100) return 1;
  if (factor === 50) return 0.625;
  return 0.390625; // 메인시리즈 무효 = GO에서는 2중 반감
}

async function main() {
  console.log('[1/3] 타입 정보 조회...');
  const typeData = await gql(`{
    pokemon_v2_type(where: {id: {_lte: 18}}, order_by: {id: asc}) {
      id name pokemon_v2_typenames(where: {language_id: {_eq: 3}}) { name }
    }
    pokemon_v2_typeefficacy { damage_type_id target_type_id damage_factor }
  }`);

  const types = typeData.pokemon_v2_type.map(t => ({
    id: t.id,
    en: t.name,
    ko: t.pokemon_v2_typenames[0]?.name || t.name,
  }));

  // chart[공격타입][방어타입] = 배율
  const chart = {};
  types.forEach(t => { chart[t.id] = {}; });
  typeData.pokemon_v2_typeefficacy.forEach(e => {
    if (e.damage_type_id <= 18 && e.target_type_id <= 18) {
      chart[e.damage_type_id][e.target_type_id] = goMultiplier(e.damage_factor);
    }
  });
  // 누락된 조합은 등배로 채운다
  types.forEach(a => types.forEach(d => {
    if (chart[a.id][d.id] === undefined) chart[a.id][d.id] = 1;
  }));

  console.log('[2/3] 포켓몬 조회 (페이지 단위)...');
  const rows = [];
  const PAGE = 300;
  for (let offset = 0; ; offset += PAGE) {
    const data = await gql(`{
      pokemon_v2_pokemon(limit: ${PAGE}, offset: ${offset}, order_by: {id: asc}) {
        id name is_default
        pokemon_v2_pokemonstats(order_by: {stat_id: asc}) { stat_id base_stat }
        pokemon_v2_pokemontypes(order_by: {slot: asc}) { type_id }
        pokemon_v2_pokemonspecy {
          id generation_id
          pokemon_v2_pokemonspeciesnames(where: {language_id: {_eq: 3}}) { name }
        }
      }
    }`);
    const page = data.pokemon_v2_pokemon;
    rows.push(...page);
    process.stdout.write(`  ${rows.length}건\r`);
    if (page.length < PAGE) break;
  }
  console.log(`  ${rows.length}건 수신 완료`);

  console.log('[3/3] 가공 및 저장...');
  const pokemon = [];
  for (const p of rows) {
    const species = p.pokemon_v2_pokemonspecy;
    if (!species) continue;

    let formLabel = '';
    if (!p.is_default) {
      const m = p.name.match(FORM_KEEP);
      if (!m) continue;                       // 코스튬/모양 전용 폼은 제외
      formLabel = FORM_LABEL[m[1]] || m[1];
    }

    const stat = {};
    p.pokemon_v2_pokemonstats.forEach(s => { stat[s.stat_id] = s.base_stat; });

    pokemon.push({
      i: p.id,                                 // 스프라이트용 고유 id
      d: species.id,                           // 전국도감 번호
      n: species.pokemon_v2_pokemonspeciesnames[0]?.name || p.name,
      e: p.name,
      f: formLabel,                            // 폼 라벨 (기본 폼은 '')
      g: species.generation_id,
      t: p.pokemon_v2_pokemontypes.map(t => t.type_id),
      // [HP, 공격, 방어, 특공, 특방, 스피드]
      s: [stat[1], stat[2], stat[3], stat[4], stat[5], stat[6]],
    });
  }

  pokemon.sort((a, b) => a.d - b.d || a.i - b.i);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    source: 'PokeAPI (https://pokeapi.co) — CC BY-NC-SA 3.0',
    generatedFrom: 'tools/build-pgo-data.js',
    types,
    chart,
    pokemon,
  }));

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`완료: ${pokemon.length}종 / ${types.length}타입 → ${path.relative(process.cwd(), OUT)} (${kb}KB)`);
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
