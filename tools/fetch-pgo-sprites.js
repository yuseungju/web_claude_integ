/**
 * 포켓몬 스프라이트를 public/pgo/assets/sprites/ 에 내려받는다 (빌드 타임 1회).
 * 개당 ~600B라 전량 번들해도 1MB 수준이고, 런타임 외부 CDN 의존이 사라진다.
 *
 *   node tools/fetch-pgo-sprites.js
 *
 * 이미 받은 파일은 건너뛰므로 중단 후 재실행해도 안전하다.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DEX = path.join(__dirname, '..', 'apps', 'pgo', 'public', 'assets', 'data', 'pokedex.json');
const OUT_DIR = path.join(__dirname, '..', 'apps', 'pgo', 'public', 'assets', 'sprites');
const BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const CONCURRENCY = 12;

function download(id) {
  const dest = path.join(OUT_DIR, `${id}.png`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return Promise.resolve('skip');

  return new Promise(resolve => {
    https.get(`${BASE}/${id}.png`, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(`http${res.statusCode}`); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { fs.writeFileSync(dest, Buffer.concat(chunks)); resolve('ok'); });
    }).on('error', () => resolve('err'));
  });
}

async function main() {
  const dex = JSON.parse(fs.readFileSync(DEX, 'utf8'));
  const ids = dex.pokemon.map(p => p.i);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tally = { ok: 0, skip: 0, missing: 0 };
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const r = await download(id);
      if (r === 'ok') tally.ok++;
      else if (r === 'skip') tally.skip++;
      else { tally.missing++; console.warn(`  누락 ${id}: ${r}`); }
      if ((tally.ok + tally.skip) % 100 === 0) {
        process.stdout.write(`  ${tally.ok + tally.skip}/${ids.length}\r`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const total = fs.readdirSync(OUT_DIR).reduce((n, f) => n + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  console.log(`\n완료: 신규 ${tally.ok} · 기존 ${tally.skip} · 누락 ${tally.missing} — 총 ${(total / 1024 / 1024).toFixed(2)}MB`);
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
