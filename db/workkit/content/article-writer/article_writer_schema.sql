-- ============================================================
-- [컨텐츠작성 / 기사작성] 스키마
-- aw_projects: 기사 프로젝트 (이슈)
-- aw_sections: 기사 섹션 5개 (1~5번)
-- ============================================================

CREATE TABLE IF NOT EXISTS aw_projects (
  id               SERIAL       PRIMARY KEY,
  user_id          INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            VARCHAR(200) NOT NULL,
  category         VARCHAR(50)  DEFAULT '문화',
  is_draft         BOOLEAN      DEFAULT TRUE,
  article_content  TEXT         DEFAULT '',
  reference_links  JSONB        DEFAULT '[]',
  created_at       TIMESTAMPTZ  DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aw_projects_user    ON aw_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_aw_projects_created ON aw_projects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aw_projects_pub     ON aw_projects(is_draft) WHERE is_draft = FALSE;

-- 섹션별 내용 (section_no: 1~5)
CREATE TABLE IF NOT EXISTS aw_sections (
  issue_id   INTEGER  NOT NULL REFERENCES aw_projects(id) ON DELETE CASCADE,
  section_no SMALLINT NOT NULL CHECK (section_no BETWEEN 1 AND 5),
  content    TEXT     DEFAULT '',
  guide      TEXT     DEFAULT '',
  ai_content TEXT     DEFAULT '',
  label      TEXT     DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (issue_id, section_no)
);
CREATE INDEX IF NOT EXISTS idx_aw_sections_issue ON aw_sections(issue_id);
