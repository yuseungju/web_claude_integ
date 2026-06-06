-- ============================================================
-- 전체 테이블 DROP & RECREATE
-- 실행: AWS CloudShell → psql 접속 후 아래 SQL 전체 복붙 실행
--   psql "host=$RDSHOST dbname=postgres user=postgres sslmode=require"
-- ============================================================

-- ────────────────────────────────────────────
-- DROP (자식 → 부모 순서)
-- ────────────────────────────────────────────
DROP TABLE IF EXISTS comment_reactions       CASCADE;
DROP TABLE IF EXISTS comments                CASCADE;
DROP TABLE IF EXISTS issue_reactions         CASCADE;
DROP TABLE IF EXISTS issue_views             CASCADE;
DROP TABLE IF EXISTS issue_section_editors   CASCADE;
DROP TABLE IF EXISTS issue_sections          CASCADE;
DROP TABLE IF EXISTS link_bookmarks          CASCADE;
DROP TABLE IF EXISTS link_folders            CASCADE;
DROP TABLE IF EXISTS user_section_guides     CASCADE;
DROP TABLE IF EXISTS user_section_labels     CASCADE;
DROP TABLE IF EXISTS issues                  CASCADE;
DROP TABLE IF EXISTS novel_comment_reactions CASCADE;
DROP TABLE IF EXISTS novel_comments          CASCADE;
DROP TABLE IF EXISTS novel_reactions         CASCADE;
DROP TABLE IF EXISTS novel_views             CASCADE;
DROP TABLE IF EXISTS novel_episode_editors   CASCADE;
DROP TABLE IF EXISTS novel_episodes          CASCADE;
DROP TABLE IF EXISTS novels                  CASCADE;
DROP TABLE IF EXISTS users                   CASCADE;

-- ============================================================
-- [공통] users
-- 실제 사용 컬럼: id, email, password_hash, name,
--                writing_style (aiWriteSection·generateArticle),
--                article_style (getMypage·saveArticleStyle·generateArticle)
-- 제거: updated_at (어떤 쿼리에서도 SET/SELECT 없음)
-- ============================================================
CREATE TABLE users (
  id            SERIAL       PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT         NOT NULL,
  name          VARCHAR(100) NOT NULL,
  writing_style TEXT         DEFAULT '',
  article_style TEXT         DEFAULT '',
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- ============================================================
-- [기사 작성] issues
-- 실제 사용 컬럼: id, user_id, title, category, is_draft,
--                article_content (saveSections·getIssue),
--                view_count (getIssues·getIssue·view count +1),
--                reference_links JSONB (aiTopic·autoFillSections·getIssue),
--                created_at (getIssues ORDER BY),
--                updated_at (updateIssue·saveSections SET)
-- ============================================================
CREATE TABLE issues (
  id              SERIAL       PRIMARY KEY,
  user_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           VARCHAR(200) NOT NULL,
  category        VARCHAR(50)  DEFAULT '문화',
  is_draft        BOOLEAN      DEFAULT TRUE,
  article_content TEXT         DEFAULT '',
  view_count      INTEGER      DEFAULT 0,
  reference_links JSONB        DEFAULT '[]',
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ============================================================
-- [기사 작성] issue_sections
-- 실제 사용 컬럼: issue_id, section_no (PK),
--                content (saveSections·saveSection·autoFillSections),
--                guide (saveSections·aiWriteSection·getIssue),
--                ai_content (saveSections·aiWriteSection·getIssue),
--                label (autoFillSections·getIssue),
--                updated_at (모든 upsert에 SET)
-- ============================================================
CREATE TABLE issue_sections (
  issue_id   INTEGER  NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  section_no SMALLINT NOT NULL CHECK (section_no BETWEEN 1 AND 5),
  content    TEXT     DEFAULT '',
  guide      TEXT     DEFAULT '',
  ai_content TEXT     DEFAULT '',
  label      TEXT     DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (issue_id, section_no)
);

-- ============================================================
-- [기사 작성] issue_section_editors
-- 실제 사용 컬럼: issue_id, section_no (PK), user_id
-- ============================================================
CREATE TABLE issue_section_editors (
  issue_id   INTEGER  NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  section_no SMALLINT NOT NULL,
  user_id    INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, section_no)
);

-- ============================================================
-- [기사 작성] issue_views
-- 실제 사용 컬럼: issue_id, user_id (PK + ON CONFLICT DO NOTHING)
-- ============================================================
CREATE TABLE issue_views (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, user_id)
);

-- ============================================================
-- [기사 작성] issue_reactions
-- 실제 사용 컬럼: issue_id, user_id (PK), reaction
-- ============================================================
CREATE TABLE issue_reactions (
  issue_id INTEGER     NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  PRIMARY KEY (issue_id, user_id)
);

-- ============================================================
-- [기사 작성] comments
-- 실제 사용 컬럼: id, issue_id, user_id, content, created_at
-- ============================================================
CREATE TABLE comments (
  id         SERIAL  PRIMARY KEY,
  issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- [기사 작성] comment_reactions
-- 실제 사용 컬럼: comment_id, user_id (PK), reaction
-- ============================================================
CREATE TABLE comment_reactions (
  comment_id INTEGER     NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction   VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  PRIMARY KEY (comment_id, user_id)
);

-- ============================================================
-- [기사 작성] user_section_guides
-- 실제 사용 컬럼: user_id, section_no (PK), guide, updated_at
--   getSectionGuides, saveSectionGuide, aiWriteSection (fallback)
-- ============================================================
CREATE TABLE user_section_guides (
  user_id    INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_no SMALLINT NOT NULL CHECK (section_no BETWEEN 1 AND 5),
  guide      TEXT     DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, section_no)
);

-- ============================================================
-- [기사 작성] user_section_labels
-- 실제 사용 컬럼: user_id, section_no (PK), label, updated_at
--   getSectionLabels, saveSectionLabelOne, autoFillSections, saveSections(완료시)
-- ============================================================
CREATE TABLE user_section_labels (
  user_id    INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_no SMALLINT NOT NULL CHECK (section_no BETWEEN 1 AND 5),
  label      TEXT     DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, section_no)
);

-- ============================================================
-- [기사 작성] link_folders / link_bookmarks
-- 실제 사용 컬럼 folders: id, user_id, name, created_at
-- 실제 사용 컬럼 bookmarks: id, folder_id, user_id, title, url, created_at
-- ============================================================
CREATE TABLE link_folders (
  id         SERIAL       PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE link_bookmarks (
  id         SERIAL  PRIMARY KEY,
  folder_id  INTEGER NOT NULL REFERENCES link_folders(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT    DEFAULT '',
  url        TEXT    NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- [웹소설] novels / episodes / 반응 / 댓글
-- 기사작성 구조와 동일 패턴으로 설계 (추후 Lambda 구현)
-- ============================================================
CREATE TABLE novels (
  id           SERIAL       PRIMARY KEY,
  user_id      INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(200) NOT NULL,
  genre        VARCHAR(50)  DEFAULT '판타지',
  synopsis     TEXT         DEFAULT '',
  is_published BOOLEAN      DEFAULT FALSE,
  view_count   INTEGER      DEFAULT 0,
  ref_info     JSONB        DEFAULT '{}',
  ref_summary  TEXT         DEFAULT '',
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE novel_episodes (
  id         SERIAL       PRIMARY KEY,
  novel_id   INTEGER      NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  episode_no INTEGER      NOT NULL,
  title      VARCHAR(200) DEFAULT '',
  content    TEXT         DEFAULT '',
  ai_content TEXT         DEFAULT '',
  is_draft   BOOLEAN      DEFAULT TRUE,
  view_count INTEGER      DEFAULT 0,
  created_at TIMESTAMPTZ  DEFAULT NOW(),
  updated_at TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (novel_id, episode_no)
);

CREATE TABLE novel_nodes (
  id         SERIAL       PRIMARY KEY,
  novel_id   INTEGER      NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  parent_id  INTEGER      REFERENCES novel_nodes(id) ON DELETE CASCADE,
  position   INTEGER      NOT NULL DEFAULT 0,
  title      VARCHAR(200) DEFAULT '새 메뉴',
  content    TEXT         DEFAULT '',
  created_at TIMESTAMPTZ  DEFAULT NOW(),
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE novel_episode_editors (
  novel_id   INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  episode_no INTEGER NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (novel_id, episode_no)
);

CREATE TABLE novel_views (
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (novel_id, user_id)
);

CREATE TABLE novel_reactions (
  novel_id INTEGER     NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  PRIMARY KEY (novel_id, user_id)
);

CREATE TABLE novel_comments (
  id         SERIAL  PRIMARY KEY,
  novel_id   INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE novel_comment_reactions (
  comment_id INTEGER     NOT NULL REFERENCES novel_comments(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction   VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  PRIMARY KEY (comment_id, user_id)
);

-- ============================================================
-- 인덱스 (자주 조회되는 컬럼)
-- ============================================================
CREATE INDEX idx_issues_user_id        ON issues(user_id);
CREATE INDEX idx_issues_created_at     ON issues(created_at DESC);
CREATE INDEX idx_issue_sections_issue  ON issue_sections(issue_id);
CREATE INDEX idx_issue_editors_user    ON issue_section_editors(user_id);
CREATE INDEX idx_comments_issue        ON comments(issue_id);
CREATE INDEX idx_link_bookmarks_folder ON link_bookmarks(folder_id);
CREATE INDEX idx_novels_user_id        ON novels(user_id);
CREATE INDEX idx_novel_episodes_novel  ON novel_episodes(novel_id);
CREATE INDEX idx_novel_nodes_novel     ON novel_nodes(novel_id);
CREATE INDEX idx_novel_nodes_parent    ON novel_nodes(parent_id);
