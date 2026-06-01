const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    news:        '뉴스 기사 (스트레이트 보도)',
    press:       '보도자료',
    interview:   '인터뷰 기사',
    feature:     '특집/기획 기사',
  };
  const toneMap = {
    formal:    '공식적이고 격식체',
    neutral:   '중립적이고 객관적',
    friendly:  '친근하고 부드러운',
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

app.post('/api/generate', async (req, res) => {
  const { text, style } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: '원문 내용을 입력해주세요.' });
  }

  try {
    // SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: buildPrompt(text, style) }],
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Claude API 호출 실패' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Claude API 오류' })}\n\n`);
      res.end();
    }
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '설정됨' : '미설정 (환경변수 필요)');
});
