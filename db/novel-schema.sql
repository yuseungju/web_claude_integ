-- ============================================================
-- 웹소설 DB 스키마 (기사작성 테이블과 완전 분리)
-- 적용 방법: AWS CloudShell → psql 접속 후 실행
--   psql "host=$RDSHOST dbname=postgres user=postgres sslmode=require"
--   \i novel-schema.sql
-- ============================================================

-- 웹소설 작품
CREATE TABLE IF NOT EXISTS novels (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(200) NOT NULL,
  genre        VARCHAR(50) DEFAULT '판타지',     -- 판타지/로맨스/무협/현대/SF/공포/기타
  synopsis     TEXT DEFAULT '',                  -- 줄거리·소개
  is_published BOOLEAN DEFAULT FALSE,            -- true=공개, false=비공개
  view_count   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 에피소드 (회차)
CREATE TABLE IF NOT EXISTS novel_episodes (
  id           SERIAL PRIMARY KEY,
  novel_id     INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  episode_no   INTEGER NOT NULL,                 -- 1화, 2화, ...
  title        VARCHAR(200) NOT NULL DEFAULT '',
  content      TEXT DEFAULT '',                  -- 본문
  ai_content   TEXT DEFAULT '',                  -- AI 생성 결과
  is_draft     BOOLEAN DEFAULT TRUE,
  view_count   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(novel_id, episode_no)
);

-- 에피소드 편집자 지정 (기사작성의 issue_section_editors 대응)
CREATE TABLE IF NOT EXISTS novel_episode_editors (
  novel_id     INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  episode_no   INTEGER NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (novel_id, episode_no)
);

-- 조회 기록 (계정당 1회)
CREATE TABLE IF NOT EXISTS novel_views (
  novel_id     INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (novel_id, user_id)
);

-- 반응 (좋아요/싫어요)
CREATE TABLE IF NOT EXISTS novel_reactions (
  novel_id     INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         VARCHAR(10) NOT NULL CHECK (type IN ('like', 'dislike')),
  PRIMARY KEY (novel_id, user_id)
);

-- 댓글
CREATE TABLE IF NOT EXISTS novel_comments (
  id           SERIAL PRIMARY KEY,
  novel_id     INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 댓글 반응
CREATE TABLE IF NOT EXISTS novel_comment_reactions (
  comment_id   INTEGER NOT NULL REFERENCES novel_comments(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         VARCHAR(10) NOT NULL CHECK (type IN ('like', 'dislike')),
  PRIMARY KEY (comment_id, user_id)
);

-- 사용자별 웹소설 작성 스타일 (mypage 확장)
ALTER TABLE users ADD COLUMN IF NOT EXISTS novel_style TEXT DEFAULT '';

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_novels_user    ON novels(user_id);
CREATE INDEX IF NOT EXISTS idx_episodes_novel ON novel_episodes(novel_id);
CREATE INDEX IF NOT EXISTS idx_novel_comments ON novel_comments(novel_id);
