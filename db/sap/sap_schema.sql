-- /sap — SAP 운영 문의 AI 응답. sap_ 접두사 테이블만 사용한다.
-- 대화 연속성: API 는 상태가 없으므로 메시지를 여기 쌓아두고 매 요청에 다시 실어 보낸다.

CREATE TABLE IF NOT EXISTS sap_conversations (
  id          BIGSERIAL PRIMARY KEY,
  user_key    TEXT NOT NULL,                 -- 로그인 연동 전까지 클라이언트 식별자
  source      TEXT NOT NULL DEFAULT 'web',   -- web | slack
  ext_key     TEXT,                          -- 슬랙 thread_ts (스레드 = 대화)
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- hermes proxy 가 보관하는 직전 응답 id. 이것만 넘기면 앞 대화가 이어진다.
  last_response_id TEXT
);

-- content 는 문자열이 아니라 JSONB 다. 도구 호출을 붙이면 assistant 턴에 tool_use,
-- user 턴에 tool_result 블록이 들어가므로 텍스트만 저장하면 대화를 복원할 수 없다.
CREATE TABLE IF NOT EXISTS sap_messages (
  id          BIGSERIAL PRIMARY KEY,
  conv_id     BIGINT NOT NULL REFERENCES sap_conversations(id),
  seq         INT NOT NULL,
  role        TEXT NOT NULL,                 -- user | assistant
  content     JSONB NOT NULL,
  dropped     BOOLEAN NOT NULL DEFAULT false,-- 컨텍스트에서만 제외, 이력은 보존
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 모델 비교의 근거. 토큰·지연을 남겨야 어떤 모델이 실제로 싼지 알 수 있다.
CREATE TABLE IF NOT EXISTS sap_ai_calls (
  id            BIGSERIAL PRIMARY KEY,
  conv_id       BIGINT,
  model         TEXT,
  input_tokens  INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  latency_ms    INT NOT NULL DEFAULT 0,
  -- 게이트웨이가 응답에 cost 를 실어준다. 모델 비교의 실측 근거.
  cost_usd      NUMERIC(12,8) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sap_msg_conv  ON sap_messages (conv_id, seq);
CREATE INDEX IF NOT EXISTS sap_conv_user ON sap_conversations (user_key, last_at DESC);
CREATE INDEX IF NOT EXISTS sap_calls_model ON sap_ai_calls (model, created_at DESC);
