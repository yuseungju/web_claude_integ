-- ============================================================
-- [컨텐츠작성 / 동영상 제작] 스키마
--
-- ★ 단독 실행 가능 (users 테이블이 없으면 아래 공통 블록이 먼저 생성)
-- ★ 재설치 시 DROP 쿼리를 먼저 실행하세요 (아래 주석 해제):
--   DROP TABLE IF EXISTS vm_nodes CASCADE;
--   DROP TABLE IF EXISTS vm_projects CASCADE;
--   DROP TABLE IF EXISTS video_maker_settings CASCADE;
--   DROP TABLE IF EXISTS users CASCADE;
--
-- S3 파일 경로 규칙:
--   vm-objects/{userId}/{nodeId}/{objId}-{filename}
--   노드(메뉴)별 디렉터리 — 저장 시 디렉터리 내 미참조 파일 자동 삭제
-- ============================================================

-- ============================================================
-- [공통 선행 조건] 로그인·인증 테이블 (없을 때만 생성)
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS section_guides JSONB DEFAULT '["","","","",""]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS section_labels JSONB DEFAULT '["","","","",""]';

CREATE TABLE IF NOT EXISTS access_logs (
  id           SERIAL      PRIMARY KEY,
  user_id      INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  email        VARCHAR(255),
  login_method VARCHAR(20),
  ip_address   INET,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- [동영상 제작] 전용 테이블
-- ============================================================

CREATE TABLE IF NOT EXISTS vm_projects (
  id           SERIAL       PRIMARY KEY,
  user_id      INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(200) NOT NULL DEFAULT '새 프로젝트',
  is_published BOOLEAN      NOT NULL DEFAULT FALSE,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vm_projects_user ON vm_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_vm_projects_pub  ON vm_projects(is_published) WHERE is_published = TRUE;

-- objects JSONB: [{id, type:'image'|'video', name, size, s3_key, imgDuration?, description, isMerged?}]
-- 파일 자체는 S3 버킷에 저장, s3_key로 참조
CREATE TABLE IF NOT EXISTS vm_nodes (
  id         SERIAL       PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER      NOT NULL REFERENCES vm_projects(id) ON DELETE CASCADE,
  parent_id  INTEGER      REFERENCES vm_nodes(id) ON DELETE CASCADE,
  position   INTEGER      NOT NULL DEFAULT 0,
  title      VARCHAR(200) NOT NULL DEFAULT '새 항목',
  objects    JSONB        NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vm_nodes_project ON vm_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_vm_nodes_parent  ON vm_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_vm_nodes_user    ON vm_nodes(user_id);

-- 동영상 제작 사용자 설정 (향후 확장용)
CREATE TABLE IF NOT EXISTS video_maker_settings (
  user_id       INTEGER      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  flow_settings JSONB        NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
