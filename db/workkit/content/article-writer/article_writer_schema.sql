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

-- ============================================================
-- 협업(공동편집자 · 반응 · 댓글)
--
-- 예전에는 같은 기능이 issue_section_editors / issue_reactions /
-- comments / comment_reactions 라는 접두사 없는 이름으로 있었다.
-- 앱이 늘어나면 이름이 겹치기 쉬워 aw_ 접두사로 통일했다.
-- 컬럼명(issue_id)은 API 호환을 위해 그대로 둔다.
-- ============================================================

-- 섹션별 공동편집자 — 한 섹션은 한 사람이 잡는다
CREATE TABLE IF NOT EXISTS aw_section_editors (
  issue_id   INTEGER  NOT NULL REFERENCES aw_projects(id) ON DELETE CASCADE,
  section_no SMALLINT NOT NULL CHECK (section_no BETWEEN 1 AND 5),
  user_id    INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, section_no)
);
CREATE INDEX IF NOT EXISTS idx_aw_section_editors_user ON aw_section_editors(user_id);

-- 좋아요 / 싫어요 — 한 사람당 하나
CREATE TABLE IF NOT EXISTS aw_reactions (
  issue_id INTEGER     NOT NULL REFERENCES aw_projects(id) ON DELETE CASCADE,
  user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  PRIMARY KEY (issue_id, user_id)
);

CREATE TABLE IF NOT EXISTS aw_comments (
  id         SERIAL      PRIMARY KEY,
  issue_id   INTEGER     NOT NULL REFERENCES aw_projects(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aw_comments_issue ON aw_comments(issue_id);

CREATE TABLE IF NOT EXISTS aw_comment_reactions (
  comment_id INTEGER     NOT NULL REFERENCES aw_comments(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction   VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  PRIMARY KEY (comment_id, user_id)
);
