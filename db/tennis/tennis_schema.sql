-- ============================================================
-- [대치유수지 예약 자동화 / tennis] 계정 · 예약내역 스키마
--
-- 대치유수지 예약 사이트에 쓰는 자동로그인 계정을 여러 개 등록해 두고,
-- 계정마다 로그인해 "예약확인" 페이지(?act=info.page&pcode=check)를
-- 1~4쪽 훑어 예약완료 건만 모아 둔다.
--
-- 이 웹의 로그인(users)과는 아무 상관이 없다. device_key(화면에서는 "동기화 코드")
-- 하나로 목록을 묶는다. 처음 오면 브라우저가 무작위로 만들어 저장하고,
-- 다른 PC 에 같은 코드를 넣으면 같은 목록이 그대로 보인다.
--
-- 비밀번호는 우리가 대신 로그인해야 해서 되돌릴 수 있어야 한다.
-- lambda/tennis.js 가 AES-256-GCM 으로 암호화해 password_enc 에 넣고,
-- 로그인할 때만 복호화한다. (형식: iv:authTag:ciphertext, 전부 base64)
-- ============================================================

-- 예약 사이트 계정 — 한 동기화 코드(device_key)에 여러 개를 등록한다
CREATE TABLE IF NOT EXISTS tn_accounts (
  id           SERIAL       PRIMARY KEY,
  device_key   TEXT         NOT NULL,
  login_id     VARCHAR(100) NOT NULL,
  person       VARCHAR(60)  NOT NULL DEFAULT '',
  password_enc TEXT         NOT NULL,
  label        VARCHAR(100) NOT NULL DEFAULT '',
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_no      INTEGER      NOT NULL DEFAULT 0,
  last_sync_at     TIMESTAMPTZ,
  last_sync_status TEXT     NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (device_key, login_id)
);
CREATE INDEX IF NOT EXISTS idx_tn_accounts_device ON tn_accounts(device_key, id);

-- 수집한 예약완료 내역
--   reserve_no : 사이트가 부여한 접수번호(예: 20260914090010_5061).
--                못 읽으면 내용으로 만든 지문을 넣어 중복만 막는다.
CREATE TABLE IF NOT EXISTS tn_reservations (
  id           SERIAL       PRIMARY KEY,
  device_key   TEXT         NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_tn_reservations_device ON tn_reservations(device_key, use_date DESC);
CREATE INDEX IF NOT EXISTS idx_tn_reservations_acct   ON tn_reservations(account_id);

-- 행별 체크 (정산에 포함할지)
--
-- tn_reservations 는 수집할 때마다 통째로 지웠다 다시 넣는다. 체크를 거기
-- 두면 매번 사라지므로 따로 뺐다. 접수번호(reserve_no)로 묶어 두면
-- 다시 수집해도 같은 예약은 체크가 그대로 유지된다.
-- amount: 사용자가 직접 넣은 금액. 비어 있으면 tn_prices 의 시간대 단가를 쓴다.
-- 월마다 요금이 달라질 수 있어 행별로 덮어쓸 수 있게 뒀다.
CREATE TABLE IF NOT EXISTS tn_checks (
  device_key TEXT        NOT NULL,
  reserve_no VARCHAR(80) NOT NULL,
  checked    BOOLEAN     NOT NULL DEFAULT TRUE,
  amount     INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (device_key, reserve_no)
);

-- 시작 시간대별 단가 — "17시 얼마, 19시 얼마" 를 넣어 두면
-- 체크된 예약의 시작 시각을 보고 금액을 매긴다.
CREATE TABLE IF NOT EXISTS tn_prices (
  device_key TEXT     NOT NULL,
  start_hour SMALLINT NOT NULL CHECK (start_hour >= 0 AND start_hour <= 23),
  price      INTEGER  NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (device_key, start_hour)
);

-- 계정 주인 이름 — 한 사람이 계정을 여러 개 쓰므로 이름으로 묶어 정산한다.
-- 이미 만들어진 테이블에는 없는 컬럼이라 따로 붙인다
-- (CREATE TABLE IF NOT EXISTS 는 기존 테이블을 고치지 않는다).
ALTER TABLE tn_accounts ADD COLUMN IF NOT EXISTS person VARCHAR(60) NOT NULL DEFAULT '';

-- 화면 설정값 (정산 인원 등) — 키/값 한 줄씩
CREATE TABLE IF NOT EXISTS tn_settings (
  device_key TEXT        NOT NULL,
  name       VARCHAR(40) NOT NULL,
  value      TEXT        NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (device_key, name)
);

ALTER TABLE tn_checks ADD COLUMN IF NOT EXISTS amount INTEGER;
