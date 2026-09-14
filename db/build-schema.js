/**
 * db/schema_all.sql 자동 생성
 *   node db/build-schema.js
 *
 * db/<앱>/ 아래 *.sql 을 정해진 순서로 합친다. 배포 때는 이 통합 파일 하나만 실행한다.
 * `_` 로 시작하는 디렉토리(_archive 등)는 건너뛴다 — 옛 스키마를 보관만 하고
 * 실행 경로에는 넣지 않기 위해서다.
 */
const fs = require('fs');
const path = require('path');

const DB_DIR = __dirname;
const OUTPUT_FILE = path.join(DB_DIR, 'schema_all.sql');

// common 을 먼저 깔고(users 등 공통), 그 다음 앱별 스키마
const APP_ORDER = ['common', 'nol', 'pgo', 'workkit', 'tennis'];

/** 배포 때 돌면 안 되는 구문 — 있으면 빌드를 멈춘다 */
const DESTRUCTIVE = /\b(DROP\s+(TABLE|SCHEMA|DATABASE|INDEX)|TRUNCATE|DELETE\s+FROM)\b/i;

function findSqlFiles(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;          // _archive 등 제외
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(findSqlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.sql')) out.push(full);
  }
  return out.sort();
}

const parts = [];
const problems = [];
const owner = new Map();   // 테이블명 -> 그 테이블을 정의한 파일
const dupes = [];

for (const app of APP_ORDER) {
  const dir = path.join(DB_DIR, app);
  if (!fs.existsSync(dir)) continue;
  for (const file of findSqlFiles(dir)) {
    const rel = path.relative(DB_DIR, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    // 주석을 걷어낸 뒤 검사해야 "DROP 없음" 같은 설명 문구에 오탐하지 않는다
    const code = content.replace(/--[^\n]*/g, '');
    const hit = code.match(DESTRUCTIVE);
    if (hit) problems.push(rel + ' — "' + hit[0] + '"');

    // 한 테이블은 한 파일만 정의한다. 앱이 늘어날수록 이름이 겹치기 쉬운데,
    // CREATE TABLE IF NOT EXISTS 는 조용히 넘어가므로 여기서 잡아야 한다.
    for (const m of code.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)) {
      const name = m[1].toLowerCase();
      if (owner.has(name)) dupes.push(name + ' — ' + owner.get(name) + ' / ' + rel);
      else owner.set(name, rel);
    }

    parts.push('-- ===== ' + rel + ' =====\n' + content.trimEnd() + '\n');
  }
}

if (problems.length) {
  console.error('배포 시 실행되는 스키마에 파괴적 구문이 있습니다. 중단합니다:');
  problems.forEach(p => console.error('  - ' + p));
  console.error('데이터를 지우는 구문은 db/_archive/ 로 옮기고 수동으로 실행하세요.');
  process.exit(1);
}

if (dupes.length) {
  console.error('같은 테이블을 두 곳에서 정의하고 있습니다. 중단합니다:');
  dupes.forEach(d => console.error('  - ' + d));
  console.error('여러 앱이 공유하는 테이블이면 db/common/ 한 곳에만 두고,');
  console.error('서로 다른 테이블인데 이름만 같은 것이면 앱 접두사로 이름을 나누세요.');
  process.exit(1);
}

const header = [
  '-- ============================================================',
  '-- 자동 생성 파일 — 직접 수정하지 마세요.',
  '-- db/<앱>/ 아래 *.sql 을 수정한 뒤 node db/build-schema.js 로 재생성합니다.',
  '--',
  '-- 배포할 때 db/migrate.js 가 이 파일을 RDS에 실행합니다.',
  '-- 모든 구문은 여러 번 실행해도 안전해야 합니다 (CREATE ... IF NOT EXISTS).',
  '-- 생성: ' + new Date().toISOString(),
  '-- ============================================================',
  '', '',
].join('\n');

fs.writeFileSync(OUTPUT_FILE, header + parts.join('\n'));
console.log('schema_all.sql 생성 완료 — ' + parts.length + '개 파일 병합');
