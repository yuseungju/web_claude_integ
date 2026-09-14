/**
 * 배포 시 DB 스키마 반영
 *   node db/migrate.js            실제 실행
 *   node db/migrate.js --dry-run  실행할 내용만 출력
 *
 * db/schema_all.sql 을 RDS 에 한 트랜잭션으로 적용한다.
 * 스키마는 전부 CREATE ... IF NOT EXISTS 라 여러 번 돌려도 안전하다.
 *
 * 접속 정보는 환경변수로 받는다 (Amplify 콘솔의 환경 변수에 등록):
 *   DB_HOST  DB_NAME  DB_USER  DB_PASSWORD  [DB_PORT=5432]
 *
 * 환경변수가 없으면 **건너뛴다**. DB 자격증명이 없는 환경(예: PR 미리보기 빌드)에서
 * 프론트엔드 배포까지 실패하게 만들지 않기 위해서다.
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const SCHEMA = path.join(__dirname, 'schema_all.sql');

const cfg = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};

function skip(reason) {
  console.warn('[migrate] 건너뜁니다 — ' + reason);
  process.exit(0);
}

if (!fs.existsSync(SCHEMA)) skip('db/schema_all.sql 이 없습니다. node db/build-schema.js 를 먼저 실행하세요.');

const sql = fs.readFileSync(SCHEMA, 'utf8');

// 안전장치: 통합 파일에 파괴적 구문이 있으면 실행하지 않는다 (주석은 제외하고 검사)
const code = sql.replace(/--[^\n]*/g, '');
const hit = code.match(/\b(DROP\s+(TABLE|SCHEMA|DATABASE|INDEX)|TRUNCATE|DELETE\s+FROM)\b/i);
if (hit) {
  console.error('[migrate] 통합 스키마에 파괴적 구문("' + hit[0] + '")이 있어 실행하지 않습니다.');
  process.exit(1);
}

const statements = code.split(';').filter(s => s.trim()).length;

if (DRY) {
  console.log('[migrate] dry-run — 구문 약 ' + statements + '개');
  console.log('[migrate] 접속 대상: ' + (cfg.host || '(DB_HOST 미설정)') + ' / ' + (cfg.database || '(DB_NAME 미설정)'));
  process.exit(0);
}

if (!cfg.host || !cfg.database || !cfg.user || !cfg.password) {
  skip('DB 접속 환경변수(DB_HOST/DB_NAME/DB_USER/DB_PASSWORD)가 없습니다.');
}

let Client;
try {
  ({ Client } = require('pg'));
} catch (e) {
  skip('pg 모듈이 없습니다. npm install pg 후 다시 시도하세요.');
}

const client = new Client({
  host: cfg.host,
  port: cfg.port,
  database: cfg.database,
  user: cfg.user,
  password: cfg.password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
  statement_timeout: 120000,
});

(async () => {
  const started = Date.now();
  await client.connect();
  console.log('[migrate] 접속: ' + cfg.host.split('.')[0] + ' / db=' + cfg.database);

  const before = await client.query(
    "SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  const after = await client.query(
    "SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");

  console.log('[migrate] 완료 — 테이블 ' + before.rows[0].n + '개 → ' + after.rows[0].n + '개'
    + ' (신규 ' + (after.rows[0].n - before.rows[0].n) + '개, ' + ((Date.now() - started) / 1000).toFixed(1) + '초)');
  await client.end();
})().catch(async (e) => {
  console.error('[migrate] 실패: ' + e.message);
  try { await client.end(); } catch (_) { /* 이미 끊긴 경우 무시 */ }
  process.exit(1);
});
