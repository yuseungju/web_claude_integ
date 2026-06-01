const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
});

const SYSTEM_PROMPT = `당신은 전문 기자입니다. 사용자가 제공하는 원문 정보와 스타일 지침을 바탕으로 완성도 높은 기사를 작성합니다.

기사 작성 원칙:
- 사실에 기반하여 작성하되, 원문에 없는 내용은 추가하지 않습니다
- 역피라미드 구조 (중요한 내용 → 부가 내용 순서)를 기본으로 합니다
- 육하원칙(누가, 언제, 어디서, 무엇을, 어떻게, 왜)을 충족시킵니다
- 헤드라인 요청 시 임팩트 있고 간결한 제목을 먼저 작성합니다
- 요청한 길이와 톤을 정확히 준수합니다`;

function buildPrompt(text, style) {
  const { format, tone, length, includeHeadline } = style;
  const formatMap = {
    news:      '뉴스 기사 (스트레이트 보도)',
    press:     '보도자료',
    interview: '인터뷰 기사',
    feature:   '특집/기획 기사',
  };
  const toneMap = {
    formal:   '공식적이고 격식체',
    neutral:  '중립적이고 객관적',
    friendly: '친근하고 부드러운',
  };
  const lengthMap = {
    short:  '300자 내외 (간결하게)',
    medium: '700자 내외 (표준 분량)',
    long:   '1200자 이상 (상세하게)',
  };
  return `[기사 형식] ${formatMap[format] || '뉴스 기사'}
[톤] ${toneMap[tone] || '중립적이고 객관적'}
[길이] ${lengthMap[length] || '700자 내외'}
[헤드라인 포함] ${includeHeadline ? '예 - 제목을 맨 위에 작성하세요' : '아니오 - 본문만 작성하세요'}

[원문 정보]
${text}

위 정보를 바탕으로 기사를 작성해주세요.`;
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  let text, style;
  try {
    ({ text, style } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: '요청 형식 오류' }) };
  }

  if (!text || !text.trim()) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: '원문 내용을 입력해주세요.' }) };
  }

  const startTime = Date.now();

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildPrompt(text, style) }],
    });

    const article    = response.content[0].text;
    const elapsedMs  = Date.now() - startTime;
    const charCount  = article.length;

    // DB 저장
    await pool.query(
      `INSERT INTO articles (input_text, style, article, char_count, elapsed_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [text, JSON.stringify(style), article, charCount, elapsedMs]
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ article }),
    };
  } catch (err) {
    console.error('오류:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: '기사 생성 실패' }),
    };
  }
};
