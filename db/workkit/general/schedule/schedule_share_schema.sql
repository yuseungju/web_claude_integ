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
