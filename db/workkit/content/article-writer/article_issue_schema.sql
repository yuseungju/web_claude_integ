-- ============================================================
-- [Work Kit / 컨텐츠작성 / 기사작성] 이슈·협업·댓글 스키마
--
-- 운영 RDS 에 이미 존재하던 정의를 그대로 옮긴 것이다.
-- lambda/index.js 가 사용하므로 새 DB 를 만들 때도 반드시 함께 생성돼야 한다.
-- ============================================================

CREATE TABLE IF NOT EXISTS issues (
  id              SERIAL,
  user_id         INTEGER NOT NULL,
  title           CHARACTER VARYING(200) NOT NULL,
  category        CHARACTER VARYING(50) DEFAULT '문화'::character varying,
  is_draft        BOOLEAN DEFAULT true,
  article_content TEXT DEFAULT ''::text,
  view_count      INTEGER DEFAULT 0,
  reference_links JSONB DEFAULT '[]'::jsonb,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_issues_created_at ON issues USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_user_id ON issues USING btree (user_id);

CREATE TABLE IF NOT EXISTS issue_sections (
  issue_id   INTEGER NOT NULL,
  section_no SMALLINT NOT NULL,
  content    TEXT DEFAULT ''::text,
  guide      TEXT DEFAULT ''::text,
  ai_content TEXT DEFAULT ''::text,
  label      TEXT DEFAULT ''::text,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (issue_id, section_no),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  CHECK (((section_no >= 1) AND (section_no <= 5)))
);
CREATE INDEX IF NOT EXISTS idx_issue_sections_issue ON issue_sections USING btree (issue_id);

CREATE TABLE IF NOT EXISTS issue_section_editors (
  issue_id   INTEGER NOT NULL,
  section_no SMALLINT NOT NULL,
  user_id    INTEGER NOT NULL,
  PRIMARY KEY (issue_id, section_no),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_issue_editors_user ON issue_section_editors USING btree (user_id);

CREATE TABLE IF NOT EXISTS issue_views (
  issue_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  PRIMARY KEY (issue_id, user_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_reactions (
  issue_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  reaction CHARACTER VARYING(10) NOT NULL,
  PRIMARY KEY (issue_id, user_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (((reaction)::text = ANY ((ARRAY['like'::character varying, 'dislike'::character varying])::text[])))
);

CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL,
  issue_id   INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments USING btree (issue_id);

CREATE TABLE IF NOT EXISTS comment_reactions (
  comment_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  reaction   CHARACTER VARYING(10) NOT NULL,
  PRIMARY KEY (comment_id, user_id),
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (((reaction)::text = ANY ((ARRAY['like'::character varying, 'dislike'::character varying])::text[])))
);
