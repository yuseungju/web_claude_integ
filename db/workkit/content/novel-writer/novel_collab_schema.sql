-- ============================================================
-- [Work Kit / 컨텐츠작성 / 웹소설] 작품·회차·협업·댓글 스키마
--
-- 운영 RDS 에 이미 존재하던 정의를 그대로 옮긴 것이다.
-- lambda/index.js 가 사용하므로 새 DB 를 만들 때도 반드시 함께 생성돼야 한다.
-- ============================================================

CREATE TABLE IF NOT EXISTS novels (
  id           SERIAL,
  user_id      INTEGER NOT NULL,
  title        CHARACTER VARYING(200) NOT NULL,
  genre        CHARACTER VARYING(50) DEFAULT '판타지'::character varying,
  synopsis     TEXT DEFAULT ''::text,
  is_published BOOLEAN DEFAULT false,
  view_count   INTEGER DEFAULT 0,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT now(),
  ref_info     JSONB DEFAULT '{}'::jsonb,
  ref_summary  TEXT DEFAULT ''::text,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_novels_user_id ON novels USING btree (user_id);

CREATE TABLE IF NOT EXISTS novel_nodes (
  id         SERIAL,
  novel_id   INTEGER NOT NULL,
  parent_id  INTEGER,
  position   INTEGER NOT NULL DEFAULT 0,
  title      CHARACTER VARYING(200) DEFAULT '새 메뉴'::character varying,
  content    TEXT DEFAULT ''::text,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  is_visible BOOLEAN DEFAULT false,
  ai_content TEXT DEFAULT ''::text,
  node_ref   JSONB DEFAULT '{}'::jsonb,
  PRIMARY KEY (id),
  FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES novel_nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_novel_nodes_novel ON novel_nodes USING btree (novel_id);
CREATE INDEX IF NOT EXISTS idx_novel_nodes_parent ON novel_nodes USING btree (parent_id);

CREATE TABLE IF NOT EXISTS novel_episodes (
  id         SERIAL,
  novel_id   INTEGER NOT NULL,
  episode_no INTEGER NOT NULL,
  title      CHARACTER VARYING(200) DEFAULT ''::character varying,
  content    TEXT DEFAULT ''::text,
  ai_content TEXT DEFAULT ''::text,
  is_draft   BOOLEAN DEFAULT true,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (novel_id, episode_no),
  FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_novel_episodes_novel ON novel_episodes USING btree (novel_id);

CREATE TABLE IF NOT EXISTS novel_episode_editors (
  novel_id   INTEGER NOT NULL,
  episode_no INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  PRIMARY KEY (novel_id, episode_no),
  FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS novel_comments (
  id         SERIAL,
  novel_id   INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS novel_comment_reactions (
  comment_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  reaction   CHARACTER VARYING(10) NOT NULL,
  PRIMARY KEY (comment_id, user_id),
  FOREIGN KEY (comment_id) REFERENCES novel_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (((reaction)::text = ANY ((ARRAY['like'::character varying, 'dislike'::character varying])::text[])))
);

CREATE TABLE IF NOT EXISTS novel_reactions (
  novel_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  reaction CHARACTER VARYING(10) NOT NULL,
  PRIMARY KEY (novel_id, user_id),
  FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (((reaction)::text = ANY ((ARRAY['like'::character varying, 'dislike'::character varying])::text[])))
);

CREATE TABLE IF NOT EXISTS novel_views (
  novel_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  PRIMARY KEY (novel_id, user_id),
  FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
