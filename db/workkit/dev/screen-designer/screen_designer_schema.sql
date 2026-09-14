-- ============================================================
-- [개발 업무 / 화면 설계서] 스키마
-- sd_projects: 화면 설계서 프로젝트
-- sd_nodes: 화면 노드 (컴포넌트 배치 포함)
-- ============================================================

CREATE TABLE IF NOT EXISTS sd_projects (
  id           SERIAL       PRIMARY KEY,
  user_id      INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(200) DEFAULT '새 화면 설계서',
  is_published BOOLEAN      DEFAULT FALSE,
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sd_projects_user ON sd_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_sd_projects_pub  ON sd_projects(is_published) WHERE is_published = TRUE;

-- components JSON: [{id, type, x, y, w, h, props:{label, link, variant, ...}}]
-- type: button | queryBtn | input | dropdown | table | list | label | panel
-- props.link: target node id (button/queryBtn 클릭 시 이동할 화면)
CREATE TABLE IF NOT EXISTS sd_nodes (
  id         SERIAL       PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER      NOT NULL REFERENCES sd_projects(id) ON DELETE CASCADE,
  parent_id  INTEGER      REFERENCES sd_nodes(id) ON DELETE CASCADE,
  position   INTEGER      NOT NULL DEFAULT 0,
  title      VARCHAR(200) DEFAULT '새 화면',
  components JSONB        DEFAULT '[]',
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sd_nodes_project ON sd_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_sd_nodes_parent  ON sd_nodes(parent_id);
