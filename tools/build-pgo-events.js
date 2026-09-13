/**
 * 포켓몬GO 이벤트/레이드 일정 빌드
 *
 *   node tools/build-pgo-events.js
 *
 * 입력: ScrapedDuck (LeekDuck 공개 스크랩) events.json + raids.json
 * 출력: public/pgo/assets/data/events.json
 *
 * 일정은 매주 바뀌므로 저장소에 번들해 두되, 런타임에서 같은 원본을 다시 받아
 * 최신이면 갈아끼운다 (실패하면 번들본을 그대로 쓴다 — pgo-schedule.js 참고).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const SRC_EVENTS = 'https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/events.json';
const SRC_RAIDS = 'https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/raids.json';
const GODEX = path.join(__dirname, '..', 'public', 'pgo', 'assets', 'data', 'godex.json');
const OUT = path.join(__dirname, '..', 'public', 'pgo', 'assets', 'data', 'events.json');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => resolve(JSON.parse(raw)));
    }).on('error', reject);
  });
}

/**
 * 이벤트 분류 — cat(표시 카테고리) + rare(귀한 것인지)
 * 사용자가 보는 캘린더는 기본적으로 rare 만 띄운다.
 */
function classify(e) {
  const name = e.name || '';
  const type = e.eventType || '';
  const has = re => re.test(name);

  if (type === 'raid-battles') {
    if (/^Mega |Mega Raids/i.test(name)) return { cat: 'mega', rare: true };
    if (/Shadow/i.test(name)) return { cat: 'shadow', rare: true };
    if (/5-star|Elite Raids/i.test(name)) return { cat: 'legendary', rare: true };
    return { cat: 'raid', rare: true };
  }
  if (type === 'raid-hour') return { cat: 'raidhour', rare: true };
  if (type === 'raid-day') return { cat: 'raidday', rare: true };
  if (type === 'go-pass') return { cat: 'pass', rare: true };
  // 맥스 배틀 데이 · 기간틱스맥스는 단발성 큰 행사라 항상 챙긴다.
  // 매주 도는 맥스 먼데이는 등장 포켓몬이 전설급일 때만 의미가 있어, 등급 판단은
  // 도감 데이터를 가진 런타임(pgo-events.js)에서 한다.
  if (type === 'max-battles') return { cat: 'maxday', rare: true };
  if (type === 'max-mondays') return { cat: 'max', rare: false };
  if (type === 'wild-area') return { cat: 'wild', rare: false };
  if (type === 'community-day') return { cat: 'commday', rare: true };
  if (type === 'pokemon-go-fest') return { cat: 'fest', rare: true };
  if (type === 'pokemon-spotlight-hour') return { cat: 'spotlight', rare: false };
  if (type === 'go-battle-league') return { cat: 'gbl', rare: false };
  if (type === 'season') return { cat: 'season', rare: false };

  // 일반 이벤트는 이름으로 가려낸다 — 리서치/티켓/할인/레이드 관련만 귀한 것으로
  if (has(/Timed Research|Special Research|Masterwork|Research Day/i)) return { cat: 'research', rare: true };
  if (has(/ticket|Ticketed/i)) return { cat: 'ticket', rare: true };
  if (has(/discount|sale|bundle|Free /i)) return { cat: 'sale', rare: true };
  if (has(/Raid|Mega/i)) return { cat: 'event', rare: true };
  return { cat: 'event', rare: false };
}

function main() {
  const dex = JSON.parse(fs.readFileSync(GODEX, 'utf8'));

  // 영문명 -> 포켓몬 (긴 이름부터 매칭해야 'Mega Gyarados'가 'Gyarados'로 잘못 잡히지 않는다)
  const byEn = dex.pokemon
    .filter(p => p.en)
    .map(p => ({ en: p.en, k: p.k, n: p.n, c: p.c }))
    .sort((a, b) => b.en.length - a.en.length);

  /** 이벤트/레이드 이름에서 포켓몬을 뽑아낸다 */
  function extract(text) {
    if (!text) return [];
    const found = [];
    let rest = ` ${text} `;
    for (const p of byEn) {
      const re = new RegExp(`(^|[^A-Za-z])${p.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i');
      if (re.test(rest)) {
        found.push(p.k);
        rest = rest.replace(re, ' '); // 겹쳐 잡히지 않게 지운다
      }
      if (found.length >= 4) break;
    }
    return found;
  }

  return Promise.all([get(SRC_EVENTS), get(SRC_RAIDS)]).then(([rawEvents, rawRaids]) => {
    const events = rawEvents
      .filter(e => e.start)
      .map(e => {
        const c = classify(e);
        return {
          id: e.eventID,
          name: e.name,
          type: e.eventType,
          cat: c.cat,
          rare: c.rare,
          start: e.start,
          end: e.end || e.start,
          link: e.link,
          mons: extract(e.name),
        };
      })
      .sort((a, b) => a.start.localeCompare(b.start));

    const raids = rawRaids.map(r => ({
      name: r.name,
      tier: r.tier,
      shiny: !!r.canBeShiny,
      cp: r.combatPower && r.combatPower.normal ? [r.combatPower.normal.min, r.combatPower.normal.max] : null,
      cpBoost: r.combatPower && r.combatPower.boosted ? [r.combatPower.boosted.min, r.combatPower.boosted.max] : null,
      weather: (r.boostedWeather || []).map(w => w.name),
      mons: extract(r.name),
    }));

    fs.writeFileSync(OUT, JSON.stringify({
      source: 'ScrapedDuck (LeekDuck) — https://github.com/bigfoott/ScrapedDuck',
      generatedFrom: 'tools/build-pgo-events.js',
      fetchedAt: new Date().toISOString(),
      refreshUrl: SRC_EVENTS,
      raidsUrl: SRC_RAIDS,
      events,
      raids,
    }));

    const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
    const byCat = events.reduce((a, e) => (a[e.cat] = (a[e.cat] || 0) + 1, a), {});
    const matched = events.filter(e => e.mons.length).length;
    console.log(`완료: 이벤트 ${events.length}건 · 레이드보스 ${raids.length}종 → ${path.relative(process.cwd(), OUT)} (${kb}KB)`);
    console.log(`  귀한 것 ${events.filter(e => e.rare).length}건 · 포켓몬 매칭 ${matched}건`);
    console.log('  카테고리:', Object.entries(byCat).map(([k, v]) => `${k}=${v}`).join(' '));
  });
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
