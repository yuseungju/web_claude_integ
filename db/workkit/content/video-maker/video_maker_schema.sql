-- ============================================================
-- [Work Kit / 컨텐츠작성 / 동영상 제작] 스키마
--
-- S3 파일 경로 규칙:
--   vm-objects/{userId}/{nodeId}/{objId}-{filename}
--   노드(메뉴)별 디렉터리 — 저장 시 디렉터리 내 미참조 파일 자동 삭제
-- ============================================================

-- ============================================================
-- [공통 선행 조건] 로그인·인증 테이블
--
-- users / access_logs / user_saves / user_current_shares 는 여러 앱이 공유한다.
-- 정의는 db/common/common_schema.sql 이 단독으로 소유하며, 통합 스키마에서
-- common 이 항상 먼저 실행되므로(build-schema.js 의 APP_ORDER) 여기서는
-- 다시 만들지 않고 참조만 한다.
-- ============================================================

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
