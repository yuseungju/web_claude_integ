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
