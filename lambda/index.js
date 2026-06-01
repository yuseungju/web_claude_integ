const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
});

const JWT_SECRET = process.env.JWT_SECRET;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function ok(body)           { return { statusCode: 200, headers: CORS, body: JSON.stringify(body) }; }
function created(body)      { return { statusCode: 201, headers: CORS, body: JSON.stringify(body) }; }
function fail(code, message){ return { statusCode: code, headers: CORS, body: JSON.stringify({ error: message }) }; }

function getPath(e)   { return e.requestContext?.http?.path || e.path || '/'; }
function getMethod(e) { return (e.requestContext?.http?.method || e.httpMethod || 'GET').toUpperCase(); }
function parseBody(e) { try { return JSON.parse(e.body || '{}'); } catch { return {}; } }

function authUser(event) {
  const h = event.headers?.authorization || event.headers?.Authorization || '';
  if (!h.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  try { return jwt.verify(h.slice(7), JWT_SECRET); }
  catch { throw Object.assign(new Error('Unauthorized'), { status: 401 }); }
}

// 회원가입
async function register(event) {
  const { email, password, name } = parseBody(event);
  if (!email || !password || !name) return fail(400, '모든 항목을 입력해주세요.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, '이메일 형식이 올바르지 않습니다.');
  if (password.length < 8) return fail(400, '비밀번호는 8자 이상이어야 합니다.');

  const dup = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (dup.rows.length) return fail(409, '이미 사용 중인 이메일입니다.');

  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3)', [email, hash, name]);
  return created({ message: '회원가입 성공' });
}

// 로그인
async function login(event) {
  const { email, password } = parseBody(event);
  if (!email || !password) return fail(400, '이메일과 비밀번호를 입력해주세요.');

  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  if (!r.rows.length) return fail(401, '이메일 또는 비밀번호가 올바르지 않습니다.');

  const user = r.rows[0];
  if (!(await bcrypt.compare(password, user.password_hash)))
    return fail(401, '이메일 또는 비밀번호가 올바르지 않습니다.');

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  return ok({ token, user: { id: user.id, email: user.email, name: user.name } });
}

// 이메일 중복확인
async function checkEmail(event) {
  const { email } = parseBody(event);
  if (!email) return fail(400, '이메일을 입력해주세요.');
  const r = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  return ok({ available: r.rows.length === 0 });
}

// 기사 목록
async function getArticles(event) {
  const user = authUser(event);
  const r = await pool.query(
    `SELECT a.id, a.title, a.is_draft, a.created_at, u.name AS author
     FROM articles a JOIN users u ON a.user_id = u.id
     WHERE a.user_id=$1 ORDER BY a.created_at DESC`,
    [user.id]
  );
  return ok({ articles: r.rows });
}

// 기사 상세
async function getArticle(event, path) {
  const user = authUser(event);
  const id = path.split('/').pop();
  const r = await pool.query(
    'SELECT * FROM articles WHERE id=$1 AND user_id=$2',
    [id, user.id]
  );
  if (!r.rows.length) return fail(404, '기사를 찾을 수 없습니다.');
  return ok({ article: r.rows[0] });
}

// 기사 저장
async function saveArticle(event) {
  const user = authUser(event);
  const { id, title, investigation, image_data, additional_info, generated_article } = parseBody(event);
  const charCount = (generated_article || '').length;

  if (id) {
    await pool.query(
      `UPDATE articles SET title=$1, investigation=$2, image_data=$3,
       additional_info=$4, generated_article=$5, char_count=$6,
       is_draft=FALSE, updated_at=NOW()
       WHERE id=$7 AND user_id=$8`,
      [title, investigation, image_data, additional_info, generated_article, charCount, id, user.id]
    );
    return ok({ message: '저장됨', id: Number(id) });
  }

  const r = await pool.query(
    `INSERT INTO articles (user_id, title, investigation, image_data, additional_info,
     generated_article, char_count, is_draft)
     VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE) RETURNING id`,
    [user.id, title, investigation, image_data, additional_info, generated_article, charCount]
  );
  return created({ message: '저장됨', id: r.rows[0].id });
}

// 기사 생성 (Claude)
async function generate(event) {
  authUser(event);
  const { title, investigation, additional_info } = parseBody(event);
  if (!title) return fail(400, '제목을 입력해주세요.');

  const SYSTEM = `당신은 전문 기자입니다. 제공된 정보를 바탕으로 완성도 높은 기사를 작성합니다.
- 제공된 사실만 사용하고 없는 내용은 추가하지 않습니다
- 역피라미드 구조로 작성합니다 (중요한 내용 먼저)
- 헤드라인을 먼저 쓰고 본문을 작성합니다`;

  const prompt = `제목: ${title}${investigation ? `\n\n[취재 결과]\n${investigation}` : ''}${additional_info ? `\n\n[추가 자료]\n${additional_info}` : ''}\n\n위 정보를 바탕으로 기사를 작성해주세요.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  });

  return ok({ article: response.content[0].text });
}

// AI 주제 추가
async function aiTopic(event) {
  const user = authUser(event);

  const rssRes = await fetch('https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko');
  const rssText = await rssRes.text();

  let titles = [...rssText.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>/g)]
    .map(m => m[1].trim()).filter(Boolean).slice(0, 20);

  if (!titles.length) {
    titles = [...rssText.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>/g)]
      .map(m => m[1].replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim())
      .filter(Boolean).slice(0, 20);
  }

  if (!titles.length) return fail(500, '뉴스를 가져오지 못했습니다.');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `아래 오늘의 뉴스 제목 중 기사 작성 가치가 높은 주제 1개를 골라 매력적인 기사 제목으로 다듬어 제목만 반환하세요. 다른 설명 없이 제목 텍스트만:\n\n${titles.join('\n')}`,
    }],
  });

  const suggestedTitle = response.content[0].text.trim();
  const r = await pool.query(
    'INSERT INTO articles (user_id, title, is_draft) VALUES ($1,$2,TRUE) RETURNING id',
    [user.id, suggestedTitle]
  );

  return created({ title: suggestedTitle, id: r.rows[0].id });
}

// 메인 핸들러
exports.handler = async (event) => {
  const method = getMethod(event);
  const path   = getPath(event);

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  try {
    if (method === 'POST' && path === '/auth/register')       return await register(event);
    if (method === 'POST' && path === '/auth/login')          return await login(event);
    if (method === 'POST' && path === '/auth/check-email')    return await checkEmail(event);
    if (method === 'GET'  && path === '/articles')            return await getArticles(event);
    if (method === 'GET'  && /^\/articles\/\d+$/.test(path)) return await getArticle(event, path);
    if (method === 'POST' && path === '/articles/save')       return await saveArticle(event);
    if (method === 'POST' && path === '/generate')            return await generate(event);
    if (method === 'POST' && path === '/topics/ai')           return await aiTopic(event);

    return fail(404, 'Not found');
  } catch (e) {
    if (e.status === 401) return fail(401, '로그인이 필요합니다.');
    console.error(e);
    return fail(500, '서버 오류가 발생했습니다.');
  }
};
