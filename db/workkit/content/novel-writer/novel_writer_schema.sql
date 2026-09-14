-- ============================================================
-- [컨텐츠작성 / 웹소설작성] 스키마
-- nw_projects: 소설 프로젝트
-- nw_nodes: 계층형 챕터/설정 노드
-- ============================================================

CREATE TABLE IF NOT EXISTS nw_projects (
  id           SERIAL       PRIMARY KEY,
  user_id      INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(200) NOT NULL,
  is_published BOOLEAN      DEFAULT FALSE,
  ref_info     JSONB        DEFAULT '{}',
  ref_summary  TEXT         DEFAULT '',
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nw_projects_user ON nw_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_nw_projects_pub  ON nw_projects(is_published) WHERE is_published = TRUE;

-- 계층형 노드 (챕터/설정 등)
-- novel_id: FK → nw_projects(id) (API 호환성을 위해 컬럼명 유지)
CREATE TABLE IF NOT EXISTS nw_nodes (
  id         SERIAL       PRIMARY KEY,
  novel_id   INTEGER      NOT NULL REFERENCES nw_projects(id) ON DELETE CASCADE,
  parent_id  INTEGER      REFERENCES nw_nodes(id) ON DELETE CASCADE,
  position   INTEGER      NOT NULL DEFAULT 0,
  title      VARCHAR(200) DEFAULT '새 메뉴',
  content    TEXT         DEFAULT '',
  ai_content TEXT         DEFAULT '',
  node_ref   JSONB        DEFAULT '{}',
  is_visible BOOLEAN      DEFAULT FALSE,
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nw_nodes_novel  ON nw_nodes(novel_id);
CREATE INDEX IF NOT EXISTS idx_nw_nodes_parent ON nw_nodes(parent_id);

-- ============================================================
-- 협업(반응 · 댓글)
--
-- 예전 novel_reactions / novel_comments / novel_comment_reactions 를
-- nw_ 접두사로 통일했다. 컬럼명(novel_id)은 API 호환을 위해 유지한다.
-- ============================================================

CREATE TABLE IF NOT EXISTS nw_reactions (
  novel_id INTEGER     NOT NULL REFERENCES nw_projects(id) ON DELETE CASCADE,
  user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  PRIMARY KEY (novel_id, user_id)
);

CREATE TABLE IF NOT EXISTS nw_comments (
  id         SERIAL      PRIMARY KEY,
  novel_id   INTEGER     NOT NULL REFERENCES nw_projects(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nw_comments_novel ON nw_comments(novel_id);

CREATE TABLE IF NOT EXISTS nw_comment_reactions (
  comment_id INTEGER     NOT NULL REFERENCES nw_comments(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction   VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  PRIMARY KEY (comment_id, user_id)
);
