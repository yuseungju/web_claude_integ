const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');

const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'article-writer-secret-2025';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

function resp(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

function getMethod(e) {
  return (e.requestContext?.http?.method || e.httpMethod || 'GET').toUpperCase();
}

function getPath(e) {
  return e.requestContext?.http?.path || e.path || '/';
}

function getBody(e) {
  if (!e.body) return {};
  try { return JSON.parse(e.body); } catch { return {}; }
}

function verifyToken(e) {
  const auth = e.headers?.authorization || e.headers?.Authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

exports.handler = async (event) => {
  const method = getMethod(event);
  const path = getPath(event);

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  if (path === '/auth/register'    && method === 'POST') return register(event);
  if (path === '/auth/login'       && method === 'POST') return login(event);
  if (path === '/auth/check-email' && method === 'POST') return checkEmail(event);

  if (path === '/issues' && method === 'GET')  return getIssues(event);
  if (path === '/issues' && method === 'POST') return createIssue(event);

  const issueMatch    = path.match(/^\/issues\/(\d+)$/);
  const sectionsMatch = path.match(/^\/issues\/(\d+)\/sections$/);

  if (issueMatch    && method === 'GET')  return getIssue(event, issueMatch[1]);
  if (issueMatch    && method === 'PUT')  return updateIssue(event, issueMatch[1]);
  if (sectionsMatch && method === 'POST') return saveSections(event, sectionsMatch[1]);

  if (path === '/topics/ai' && method === 'POST') return aiTopic(event);
  if (path === '/generate'  && method === 'POST') return generateArticle(event);

  return resp(404, { error: 'Not found' });
};

async function register(event) {
  const { email, password, name } = getBody(event);
  if (!email || !password || !name) return resp(400, { error: '필수 항목을 입력하세요.' });
  if (password.length < 8) return resp(400, { error: '비밀번호는 8자 이상이어야 합니다.' });
  try {
    const dup = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (dup.rows.length) return resp(409, { error: '이미 사용 중인 이메일입니다.' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (email,password_hash,name) VALUES($1,$2,$3) RETURNING id,email,name',
      [email, hash, name]
    );
    return resp(201, { user: r.rows[0] });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function login(event) {
  const { email, password } = getBody(event);
  if (!email || !password) return resp(400, { error: '이메일과 비밀번호를 입력하세요.' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!r.rows.length) return resp(401, { error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    const user = r.rows[0];
    if (!await bcrypt.compare(password, user.password_hash))
      return resp(401, { error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    return resp(200, { token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function checkEmail(event) {
  const { email } = getBody(event);
  if (!email) return resp(400, { error: '이메일을 입력하세요.' });
  try {
    const r = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    return resp(200, { available: r.rows.length === 0 });
  } catch (e) { return resp(500, { error: '서버 오류' }); }
}

async function getIssues(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query(
      `SELECT i.id, i.title, i.is_draft, i.created_at, i.updated_at, u.name AS author, i.user_id
       FROM issues i JOIN users u ON i.user_id = u.id
       ORDER BY i.created_at DESC`
    );
    return resp(200, { issues: r.rows });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function createIssue(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { title } = getBody(event);
  if (!title?.trim()) return resp(400, { error: '제목을 입력하세요.' });
  try {
    const r = await pool.query(
      'INSERT INTO issues (user_id,title,is_draft) VALUES($1,$2,TRUE) RETURNING id,title,created_at',
      [user.id, title.trim()]
    );
    return resp(201, { issue: { ...r.rows[0], author: user.name, user_id: user.id } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getIssue(event, id) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const ir = await pool.query(
      'SELECT i.*, u.name AS author FROM issues i JOIN users u ON i.user_id=u.id WHERE i.id=$1', [id]
    );
    if (!ir.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    const sr = await pool.query(
      'SELECT section_no, content FROM issue_sections WHERE issue_id=$1 ORDER BY section_no', [id]
    );
    const sections = [1,2,3,4,5].map(n => {
      const found = sr.rows.find(r => r.section_no === n);
      return found ? found.content : '';
    });
    return resp(200, { issue: ir.rows[0], sections });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function updateIssue(event, id) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { title } = getBody(event);
  if (!title?.trim()) return resp(400, { error: '제목을 입력하세요.' });
  try {
    const check = await pool.query('SELECT user_id FROM issues WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '수정 권한이 없습니다.' });
    await pool.query('UPDATE issues SET title=$1, updated_at=NOW() WHERE id=$2', [title.trim(), id]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function saveSections(event, id) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { sections, is_draft } = getBody(event);
  if (!Array.isArray(sections) || sections.length !== 5)
    return resp(400, { error: '섹션 데이터가 올바르지 않습니다.' });
  try {
    const check = await pool.query('SELECT user_id FROM issues WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '수정 권한이 없습니다.' });
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO issue_sections (issue_id, section_no, content, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, updated_at=NOW()`,
        [id, i + 1, sections[i] || '']
      );
    }
    const draft = is_draft !== undefined ? is_draft : false;
    await pool.query('UPDATE issues SET is_draft=$1, updated_at=NOW() WHERE id=$2', [draft, id]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function aiTopic(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const rss = await fetchUrl('https://news.google.com/rss/search?q=%EB%AC%B8%ED%99%94+%EC%98%88%EC%88%A0&hl=ko&gl=KR&ceid=KR:ko');
    const titles = [];
    const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g;
    let m;
    while ((m = re.exec(rss)) !== null && titles.length < 15) {
      const t = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();
      if (t && !t.toLowerCase().includes('google')) titles.push(t);
    }
    if (!titles.length) throw new Error('뉴스를 가져올 수 없습니다.');

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `아래 뉴스 제목 중 문화·예술·공연·전시 관련 기사 주제로 가장 적합한 것을 하나 골라, 한국어 기사 제목 형식으로 다듬어 제목만 출력하세요. 설명 없이 제목 텍스트만 출력하세요.\n\n${titles.slice(0, 12).join('\n')}`
      }]
    });

    const title = msg.content[0].text.trim();
    const r = await pool.query(
      'INSERT INTO issues (user_id,title,is_draft) VALUES($1,$2,TRUE) RETURNING id,title,created_at',
      [user.id, title]
    );
    return resp(201, { issue: { ...r.rows[0], author: user.name, user_id: user.id } });
  } catch (e) { console.error(e); return resp(500, { error: e.message || 'AI 주제 생성 실패' }); }
}

async function generateArticle(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { title, sections } = getBody(event);
  if (!title || !Array.isArray(sections)) return resp(400, { error: '제목과 섹션 내용을 입력하세요.' });
  try {
    const labels = ['배경/발단', '주요 내용', '인터뷰/현장', '관련 자료', '결론/전망'];
    const body = sections.map((s, i) => `[${labels[i]}]\n${s || '(내용 없음)'}`).join('\n\n');
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `아래 제목과 5개 섹션 내용을 바탕으로 완성도 높은 뉴스 기사를 작성해 주세요.\n육하원칙에 따라 자연스럽게 이어지는 기사 형식으로 작성하세요.\n\n제목: ${title}\n\n${body}`
      }]
    });
    return resp(200, { article: msg.content[0].text.trim() });
  } catch (e) { console.error(e); return resp(500, { error: e.message || '기사 생성 실패' }); }
}
