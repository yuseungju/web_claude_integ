/**
 * /pgo/* 라우트 — 포켓몬GO 분석기(/pgo/) 백엔드.
 *
 * 기존 기사/웹소설 라우트와 완전히 분리된 모듈이다. 같은 RDS 인스턴스를 쓰되
 * pgo_ 접두어 테이블만 다룬다 (db/pgo_schema.sql).
 *
 * 인증: 로그인 없이 브라우저가 발급한 device_key 로 보관함을 구분한다.
 *       키를 아는 사람은 해당 보관함을 읽을 수 있으므로 민감 정보는 저장하지 않는다.
 */

const KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const POKE_KEY_RE = /^[A-Z0-9_]{2,64}$/;

/** device_key -> trainer id (없으면 생성) */
async function trainerId(pool, key) {
  if (!KEY_RE.test(key || '')) return null;
  const { rows } = await pool.query(
    `INSERT INTO pgo_trainer (device_key) VALUES ($1)
       ON CONFLICT (device_key) DO UPDATE SET last_seen_at = NOW()
     RETURNING id`,
    [key],
  );
  return rows[0].id;
}

const int = (v, lo, hi) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

async function listBox(ctx, key) {
  const { pool, resp } = ctx;
  const id = await trainerId(pool, key);
  if (!id) return resp(400, { error: '기기 키가 올바르지 않습니다.' });

  const { rows } = await pool.query(
    `SELECT id, poke_key, nickname, cp, hp, level, iv_atk, iv_def, iv_sta, memo, created_at
       FROM pgo_box WHERE trainer_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [id],
  );
  return resp(200, { entries: rows });
}

async function addBox(ctx, body) {
  const { pool, resp } = ctx;
  const id = await trainerId(pool, body.key);
  if (!id) return resp(400, { error: '기기 키가 올바르지 않습니다.' });

  const e = body.entry || {};
  const pokeKey = String(e.poke_key || '');
  if (!POKE_KEY_RE.test(pokeKey)) return resp(400, { error: '포켓몬이 지정되지 않았습니다.' });

  const { rows: cnt } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM pgo_box WHERE trainer_id = $1', [id],
  );
  if (cnt[0].n >= 500) return resp(400, { error: '보관함이 가득 찼습니다 (최대 500마리).' });

  const level = e.level == null || e.level === '' ? null
    : Math.min(51, Math.max(1, Number(e.level)));

  const { rows } = await pool.query(
    `INSERT INTO pgo_box
       (trainer_id, poke_key, nickname, cp, hp, level, iv_atk, iv_def, iv_sta, memo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, poke_key, nickname, cp, hp, level, iv_atk, iv_def, iv_sta, memo, created_at`,
    [
      id, pokeKey, str(e.nickname, 50),
      int(e.cp, 10, 99999), int(e.hp, 1, 9999),
      Number.isFinite(level) ? level : null,
      int(e.iv_atk, 0, 15), int(e.iv_def, 0, 15), int(e.iv_sta, 0, 15),
      str(e.memo, 500),
    ],
  );
  return resp(200, { entry: rows[0] });
}

async function deleteBox(ctx, entryId, key) {
  const { pool, resp } = ctx;
  const id = await trainerId(pool, key);
  if (!id) return resp(400, { error: '기기 키가 올바르지 않습니다.' });

  const { rowCount } = await pool.query(
    'DELETE FROM pgo_box WHERE id = $1 AND trainer_id = $2', [entryId, id],
  );
  if (!rowCount) return resp(404, { error: '해당 기록이 없습니다.' });
  return resp(200, { ok: true });
}

/**
 * @param ctx { pool, resp, getBody } — index.js 에서 주입
 * @returns 응답 객체, 처리할 라우트가 없으면 null
 */
async function route(ctx, event, method, path) {
  const qs = event.queryStringParameters || {};

  if (path === '/pgo/box' && method === 'GET') return listBox(ctx, qs.key);
  if (path === '/pgo/box' && method === 'POST') return addBox(ctx, ctx.getBody(event));

  const boxIdM = path.match(/^\/pgo\/box\/(\d+)$/);
  if (boxIdM && method === 'DELETE') return deleteBox(ctx, boxIdM[1], qs.key);

  return null;
}

module.exports = { route };
