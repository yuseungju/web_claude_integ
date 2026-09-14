-- ============================================================
-- 자동 생성 파일 — 직접 수정하지 마세요.
-- db/<앱>/ 아래 *.sql 을 수정한 뒤 node db/build-schema.js 로 재생성합니다.
--
-- 배포할 때 db/migrate.js 가 이 파일을 RDS에 실행합니다.
-- 모든 구문은 여러 번 실행해도 안전해야 합니다 (CREATE ... IF NOT EXISTS).
-- 생성: 2026-09-14T06:26:51.697Z
-- ============================================================

-- ===== common/common_schema.sql =====
-- ============================================================
-- [공통] 인증 / 데이터저장 / 공유 기반 스키마
-- ============================================================

-- 사용자
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
-- 이미 users 테이블이 있는 DB(예전 기사작성 스키마로 만든 것)에는 아래 컬럼이 없다.
-- CREATE TABLE IF NOT EXISTS 는 기존 테이블을 고치지 않으므로 컬럼을 따로 보강해야 하고,
-- 이 보강은 반드시 인덱스 생성보다 **먼저** 와야 한다 (없는 컬럼에 인덱스를 걸면 실패).
ALTER TABLE users ADD COLUMN IF NOT EXISTS provider       VARCHAR(20) NOT NULL DEFAULT 'email';
ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_id    VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS save_limit     INTEGER     NOT NULL DEFAULT 5;
ALTER TABLE users ADD COLUMN IF NOT EXISTS writing_style  TEXT        DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS article_style  TEXT        DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS section_guides JSONB       DEFAULT '["","","","",""]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS section_labels JSONB       DEFAULT '["","","","",""]';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id) WHERE provider_id IS NOT NULL;

-- 로그인 이력
CREATE TABLE IF NOT EXISTS access_logs (
  id           SERIAL      PRIMARY KEY,
  user_id      INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  email        VARCHAR(255),
  login_method VARCHAR(20),
  ip_address   INET,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 버전 저장 (메뉴 공통 — 일정관리 등)
CREATE TABLE IF NOT EXISTS user_saves (
  id                 SERIAL       PRIMARY KEY,
  user_id            INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  menu_key           VARCHAR(50)  NOT NULL,
  title              VARCHAR(200) DEFAULT '',
  data               TEXT,
  created_at         TIMESTAMPTZ  DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  DEFAULT NOW(),
  collab_share_token VARCHAR(64),
  share_token        VARCHAR(64)
);
-- users 와 같은 이유로 컬럼 보강을 인덱스보다 먼저 둔다
ALTER TABLE user_saves ADD COLUMN IF NOT EXISTS collab_share_token VARCHAR(64);
ALTER TABLE user_saves ADD COLUMN IF NOT EXISTS share_token        VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_user_saves_user_menu ON user_saves(user_id, menu_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_saves_share_token ON user_saves(share_token) WHERE share_token IS NOT NULL;

-- 현재 상태 즉시 공유
CREATE TABLE IF NOT EXISTS user_current_shares (
  id          SERIAL      PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  menu_key    VARCHAR(50) NOT NULL,
  data        TEXT,
  share_token VARCHAR(64) UNIQUE,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, menu_key)
);

-- ===== common/user_section_schema.sql =====
-- ============================================================
-- [공통] 사용자별 섹션 가이드·라벨 (mypage)
--
-- 운영 RDS 에 이미 존재하던 정의를 그대로 옮긴 것이다.
-- lambda/index.js 가 사용하므로 새 DB 를 만들 때도 반드시 함께 생성돼야 한다.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_section_guides (
  user_id    INTEGER NOT NULL,
  section_no SMALLINT NOT NULL,
  guide      TEXT DEFAULT ''::text,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (user_id, section_no),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (((section_no >= 1) AND (section_no <= 5)))
);

CREATE TABLE IF NOT EXISTS user_section_labels (
  user_id    INTEGER NOT NULL,
  section_no SMALLINT NOT NULL,
  label      TEXT DEFAULT ''::text,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (user_id, section_no),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (((section_no >= 1) AND (section_no <= 5)))
);

-- ===== pgo/pgo_schema.sql =====
-- ============================================================
-- PGO 분석기(/pgo/) 전용 테이블
--
-- 기존 article-writer 스키마와 같은 RDS 인스턴스를 쓰되,
-- pgo_ 접두어로 네임스페이스를 분리한다.
-- 기존 테이블(users, issues, novels 등)은 이 스크립트에서 건드리지 않는다.
--
-- 실행:
--   psql "host=$RDSHOST dbname=postgres user=... sslmode=require" -f db/pgo_schema.sql
--
-- 모두 IF NOT EXISTS 라 여러 번 실행해도 안전하다 (DROP 없음).
-- ============================================================

-- ────────────────────────────────────────────
-- 트레이너 — 로그인 없이 브라우저가 발급한 device_key 로 보관함을 구분한다.
-- 기존 users 테이블과는 무관하게 독립적으로 관리한다.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pgo_trainer (
  id          SERIAL      PRIMARY KEY,
  device_key  TEXT        UNIQUE NOT NULL,
  nickname    TEXT        DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────
-- 보관함 — CP·IV 계산기에서 저장한 개체 기록
--   poke_key : godex.json 의 k (예: 'MACHAMP', 'CHARIZARD_MEGA_X').
--              배열 인덱스가 아니라 포켓몬GO 고유 키라 데이터 재빌드에도 안 깨진다.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pgo_box (
  id         SERIAL      PRIMARY KEY,
  trainer_id INTEGER     NOT NULL REFERENCES pgo_trainer(id) ON DELETE CASCADE,
  poke_key   TEXT        NOT NULL,
  nickname   TEXT        DEFAULT '',
  cp         INTEGER,
  hp         INTEGER,
  level      NUMERIC(4,1),
  iv_atk     SMALLINT    CHECK (iv_atk IS NULL OR iv_atk BETWEEN 0 AND 15),
  iv_def     SMALLINT    CHECK (iv_def IS NULL OR iv_def BETWEEN 0 AND 15),
  iv_sta     SMALLINT    CHECK (iv_sta IS NULL OR iv_sta BETWEEN 0 AND 15),
  memo       TEXT        DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pgo_box_trainer ON pgo_box(trainer_id, created_at DESC);

-- ────────────────────────────────────────────
-- 즐겨찾기 — 도감에서 관심 포켓몬 표시
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pgo_favorite (
  trainer_id INTEGER     NOT NULL REFERENCES pgo_trainer(id) ON DELETE CASCADE,
  poke_key   TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (trainer_id, poke_key)
);

-- ────────────────────────────────────────────
-- 카운터 분석 조회 로그 — 어떤 보스를 많이 찾는지 집계용 (개인정보 없음)
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pgo_lookup_log (
  id         SERIAL      PRIMARY KEY,
  poke_key   TEXT        NOT NULL,
  kind       VARCHAR(20) NOT NULL,          -- 'counter' | 'detail' | 'iv'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pgo_lookup_poke ON pgo_lookup_log(poke_key, created_at DESC);

-- ===== workkit/content/article-writer/article_issue_schema.sql =====
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

-- ===== workkit/content/article-writer/article_writer_schema.sql =====
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

-- ===== workkit/content/novel-writer/novel_collab_schema.sql =====
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

-- ===== workkit/content/novel-writer/novel_writer_schema.sql =====
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

-- ===== workkit/content/video-maker/video_maker_schema.sql =====
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

-- ===== workkit/dev/screen-designer/screen_designer_schema.sql =====
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

-- ===== workkit/general/bookmark/bookmark_schema.sql =====
-- ============================================================
-- [Work Kit / 일반업무 / 링크 보관함] 폴더·북마크 스키마
--
-- 운영 RDS 에 이미 존재하던 정의를 그대로 옮긴 것이다.
-- lambda/index.js 가 사용하므로 새 DB 를 만들 때도 반드시 함께 생성돼야 한다.
-- ============================================================

CREATE TABLE IF NOT EXISTS link_folders (
  id         SERIAL,
  user_id    INTEGER NOT NULL,
  name       CHARACTER VARYING(100) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS link_bookmarks (
  id         SERIAL,
  folder_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  title      TEXT DEFAULT ''::text,
  url        TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (folder_id) REFERENCES link_folders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_link_bookmarks_folder ON link_bookmarks USING btree (folder_id);

-- ===== workkit/general/schedule/schedule_share_schema.sql =====
-- ============================================================
-- [Work Kit / 일반업무 / 일정관리] 스키마
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
-- [일정관리] 협업공유 참조 테이블
-- ============================================================

-- 협업공유를 통해 저장한 사용자의 버전 참조
-- (원본 user_saves 삭제 시 CASCADE로 같이 제거됨)
CREATE TABLE IF NOT EXISTS schedule_collab_refs (
  id         SERIAL  PRIMARY KEY,
  save_id    INTEGER NOT NULL REFERENCES user_saves(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(save_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_schedule_collab_refs_user ON schedule_collab_refs(user_id);

-- ===== workkit/other/claude-chat/claude_chat_schema.sql =====
-- ============================================================
-- [기타 / AI 대화] 스키마
-- ai_summaries: AI 대화 요약 저장
-- ai_summary_files: 요약 첨부 파일
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_summaries (
  id             SERIAL       PRIMARY KEY,
  user_id        INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_email     VARCHAR(255),
  title          VARCHAR(200) DEFAULT '',
  content        TEXT         DEFAULT '',
  share_token    VARCHAR(64)  UNIQUE,
  is_edit_locked BOOLEAN      DEFAULT FALSE,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_summaries_user  ON ai_summaries(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_summaries_token ON ai_summaries(share_token) WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_summary_files (
  id           SERIAL       PRIMARY KEY,
  summary_id   INTEGER      NOT NULL REFERENCES ai_summaries(id) ON DELETE CASCADE,
  filename     TEXT         NOT NULL,
  content_type VARCHAR(100),
  file_data    TEXT,
  file_size    INTEGER      DEFAULT 0,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_summary_files_summary ON ai_summary_files(summary_id);
