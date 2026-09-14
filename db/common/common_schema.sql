-- ============================================================
-- [공통] 인증 / 데이터저장 / 공유 기반 스키마
-- ============================================================

-- 사용자
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL       PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  password_hash TEXT,
  name          VARCHAR(100) NOT NULL DEFAULT '',
  provider      VARCHAR(20)  NOT NULL DEFAULT 'email',
  provider_id   VARCHAR(255),
  save_limit    INTEGER      NOT NULL DEFAULT 5,
  writing_style   TEXT         DEFAULT '',
  article_style   TEXT         DEFAULT '',
  section_guides  JSONB        DEFAULT '["","","","",""]',
  section_labels  JSONB        DEFAULT '["","","","",""]',
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id) WHERE provider_id IS NOT NULL;

-- 로그인 이력
CREATE TABLE IF NOT EXISTS access_logs (
  id           SERIAL      PRIMARY KEY,
  user_id      INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  email        VARCHAR(255),
  login_method VARCHAR(20),
  ip_address   INET,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 버전 저장 (메뉴 공통 — 일정관리 등)
CREATE TABLE IF NOT EXISTS user_saves (
  id                 SERIAL       PRIMARY KEY,
  user_id            INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  menu_key           VARCHAR(50)  NOT NULL,
  title              VARCHAR(200) DEFAULT '',
  data               TEXT,
  created_at         TIMESTAMPTZ  DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  DEFAULT NOW(),
  collab_share_token VARCHAR(64),
  share_token        VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_user_saves_user_menu ON user_saves(user_id, menu_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_saves_share_token ON user_saves(share_token) WHERE share_token IS NOT NULL;

-- 현재 상태 즉시 공유
CREATE TABLE IF NOT EXISTS user_current_shares (
  id          SERIAL      PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  menu_key    VARCHAR(50) NOT NULL,
  data        TEXT,
  share_token VARCHAR(64) UNIQUE,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, menu_key)
);
