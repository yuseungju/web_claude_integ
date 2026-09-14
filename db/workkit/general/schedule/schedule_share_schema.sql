-- ============================================================
-- [일반업무 / 일정관리] 스키마
--
-- ★ 단독 실행 가능 (users/user_saves 테이블이 없으면 공통 블록이 먼저 생성)
-- ============================================================

-- ============================================================
-- [공통 선행 조건] 로그인·인증·버전저장 테이블 (없을 때만 생성)
-- ============================================================

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

CREATE TABLE IF NOT EXISTS access_logs (
  id           SERIAL      PRIMARY KEY,
  user_id      INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  email        VARCHAR(255),
  login_method VARCHAR(20),
  ip_address   INET,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

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
ALTER TABLE user_saves ADD COLUMN IF NOT EXISTS share_token VARCHAR(64);

CREATE TABLE IF NOT EXISTS user_current_shares (
  id          SERIAL      PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  menu_key    VARCHAR(50) NOT NULL,
  data        TEXT,
  share_token VARCHAR(64) UNIQUE,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, menu_key)
);

-- ============================================================
-- [일정관리] 협업공유 참조 테이블
-- ============================================================

-- 협업공유를 통해 저장한 사용자의 버전 참조
-- (원본 user_saves 삭제 시 CASCADE로 같이 제거됨)
CREATE TABLE IF NOT EXISTS schedule_collab_refs (
  id         SERIAL  PRIMARY KEY,
  save_id    INTEGER NOT NULL REFERENCES user_saves(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(save_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_schedule_collab_refs_user ON schedule_collab_refs(user_id);
