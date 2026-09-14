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
