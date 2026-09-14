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
