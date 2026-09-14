-- ============================================================
-- [대치유수지 예약 자동화 / tennis] 계정 · 예약내역 스키마
--
-- 예약 사이트 계정을 여러 개 등록해 두고, 계정별로 로그인해
-- "예약확인" 페이지(?act=info.page&pcode=check)를 1~4페이지 훑어
-- 예약완료 건만 모아 둔다.
--
-- 비밀번호는 평문으로 두지 않는다. lambda/tennis.js 가 AES-256-GCM 으로
-- 암호화해 password_enc 에 넣고, 로그인할 때만 복호화한다.
-- (형식: iv:authTag:ciphertext, 전부 base64)
-- ============================================================

-- 예약 사이트 계정
CREATE TABLE IF NOT EXISTS tn_accounts (
  id           SERIAL       PRIMARY KEY,
  user_id      INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_id     VARCHAR(100) NOT NULL,
  password_enc TEXT         NOT NULL,
  label        VARCHAR(100) NOT NULL DEFAULT '',
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  last_sync_at     TIMESTAMPTZ,
  last_sync_status TEXT     NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (user_id, login_id)
);
CREATE INDEX IF NOT EXISTS idx_tn_accounts_user ON tn_accounts(user_id);

-- 수집한 예약완료 내역
--   reserve_no : 사이트가 부여한 예약번호. 같은 계정 안에서 유일하다고 보고
--                (account_id, reserve_no) 로 중복 수집을 막는다.
CREATE TABLE IF NOT EXISTS tn_reservations (
  id           SERIAL       PRIMARY KEY,
  user_id      INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id   INTEGER      NOT NULL REFERENCES tn_accounts(id) ON DELETE CASCADE,
  reserve_no   VARCHAR(80)  NOT NULL,
  facility     TEXT         NOT NULL DEFAULT '',
  use_date     DATE,
  use_time     TEXT         NOT NULL DEFAULT '',
  status       TEXT         NOT NULL DEFAULT '',
  amount       INTEGER,
  team         TEXT         NOT NULL DEFAULT '',
  people       SMALLINT,
  page_no      SMALLINT,
  raw          JSONB        NOT NULL DEFAULT '{}',
  collected_at TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (account_id, reserve_no)
);
CREATE INDEX IF NOT EXISTS idx_tn_reservations_user ON tn_reservations(user_id, use_date DESC);
CREATE INDEX IF NOT EXISTS idx_tn_reservations_acct ON tn_reservations(account_id);

-- 처음 만들 때는 위 CREATE TABLE 로 충분하지만, 이미 만들어진 DB 에는
-- 컬럼이 없다. CREATE TABLE IF NOT EXISTS 는 기존 테이블을 고치지 않으므로
-- 아래로 보강한다. (이 컬럼을 참조하는 인덱스는 없다)
ALTER TABLE tn_reservations ADD COLUMN IF NOT EXISTS team   TEXT NOT NULL DEFAULT '';
ALTER TABLE tn_reservations ADD COLUMN IF NOT EXISTS people SMALLINT;
