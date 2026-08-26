-- ============================================================
-- PGO 분석기(/pgo/) 전용 테이블
--
-- 기존 article-writer 스키마와 같은 RDS 인스턴스를 쓰되,
-- pgo_ 접두어로 네임스페이스를 분리한다.
-- 기존 테이블(users, issues, novels 등)은 이 스크립트에서 건드리지 않는다.
--
-- 실행:
--   psql "host=$RDSHOST dbname=postgres user=... sslmode=require" -f db/pgo_schema.sql
--
-- 모두 IF NOT EXISTS 라 여러 번 실행해도 안전하다 (DROP 없음).
-- ============================================================

-- ────────────────────────────────────────────
-- 트레이너 — 로그인 없이 브라우저가 발급한 device_key 로 보관함을 구분한다.
-- 기존 users 테이블과는 무관하게 독립적으로 관리한다.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pgo_trainer (
  id          SERIAL      PRIMARY KEY,
  device_key  TEXT        UNIQUE NOT NULL,
  nickname    TEXT        DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────
-- 보관함 — CP·IV 계산기에서 저장한 개체 기록
--   poke_key : godex.json 의 k (예: 'MACHAMP', 'CHARIZARD_MEGA_X').
--              배열 인덱스가 아니라 포켓몬GO 고유 키라 데이터 재빌드에도 안 깨진다.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pgo_box (
  id         SERIAL      PRIMARY KEY,
  trainer_id INTEGER     NOT NULL REFERENCES pgo_trainer(id) ON DELETE CASCADE,
  poke_key   TEXT        NOT NULL,
  nickname   TEXT        DEFAULT '',
  cp         INTEGER,
  hp         INTEGER,
  level      NUMERIC(4,1),
  iv_atk     SMALLINT    CHECK (iv_atk IS NULL OR iv_atk BETWEEN 0 AND 15),
  iv_def     SMALLINT    CHECK (iv_def IS NULL OR iv_def BETWEEN 0 AND 15),
  iv_sta     SMALLINT    CHECK (iv_sta IS NULL OR iv_sta BETWEEN 0 AND 15),
  memo       TEXT        DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pgo_box_trainer ON pgo_box(trainer_id, created_at DESC);

-- ────────────────────────────────────────────
-- 즐겨찾기 — 도감에서 관심 포켓몬 표시
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pgo_favorite (
  trainer_id INTEGER     NOT NULL REFERENCES pgo_trainer(id) ON DELETE CASCADE,
  poke_key   TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (trainer_id, poke_key)
);

-- ────────────────────────────────────────────
-- 카운터 분석 조회 로그 — 어떤 보스를 많이 찾는지 집계용 (개인정보 없음)
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pgo_lookup_log (
  id         SERIAL      PRIMARY KEY,
  poke_key   TEXT        NOT NULL,
  kind       VARCHAR(20) NOT NULL,          -- 'counter' | 'detail' | 'iv'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pgo_lookup_poke ON pgo_lookup_log(poke_key, created_at DESC);
