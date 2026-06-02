const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const S3_BUCKET = process.env.S3_BUCKET;

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
  const path   = getPath(event);

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // Auth
  if (path === '/auth/register'    && method === 'POST') return register(event);
  if (path === '/auth/login'       && method === 'POST') return login(event);
  if (path === '/auth/check-email' && method === 'POST') return checkEmail(event);

  // Issues (public GET)
  if (path === '/issues' && method === 'GET')  return getIssues(event);
  if (path === '/issues' && method === 'POST') return createIssue(event);

  const issueM    = path.match(/^\/issues\/(\d+)$/);
  const sectionsM = path.match(/^\/issues\/(\d+)\/sections$/);
  const sectionM  = path.match(/^\/issues\/(\d+)\/sections\/(\d+)$/);
  const editorsM  = path.match(/^\/issues\/(\d+)\/editors$/);
  const editorM   = path.match(/^\/issues\/(\d+)\/editors\/(\d+)$/);

  if (issueM    && method === 'GET')    return getIssue(event, issueM[1]);
  if (issueM    && method === 'PUT')    return updateIssue(event, issueM[1]);
  if (issueM    && method === 'DELETE') return deleteIssue(event, issueM[1]);
  if (sectionsM && method === 'POST')   return saveSections(event, sectionsM[1]);
  if (sectionM  && method === 'PUT')    return saveSection(event, sectionM[1], sectionM[2]);
  if (editorsM  && method === 'POST')   return setEditor(event, editorsM[1]);
  if (editorM   && method === 'DELETE') return removeEditor(event, editorM[1], editorM[2]);

  if (path === '/topics/ai' && method === 'POST') return aiTopic(event);
  if (path === '/generate'  && method === 'POST') return generateArticle(event);

  // Mypage
  const sampleM = path.match(/^\/mypage\/samples\/(\d+)$/);
  if (path === '/mypage'         && method === 'GET')    return getMypage(event);
  if (path === '/mypage/style'   && method === 'POST')   return saveStyle(event);
  if (path === '/mypage/upload'  && method === 'POST')   return uploadSample(event);
  if (sampleM                    && method === 'DELETE') return deleteSample(event, sampleM[1]);

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

// 비로그인: 완료된 이슈만 / 로그인: 완료 + 본인 작성 + 편집 권한 있는 초안
async function getIssues(event) {
  const user = verifyToken(event);
  try {
    let r;
    if (user) {
      r = await pool.query(
        `SELECT i.id, i.title, i.is_draft, i.created_at, u.name AS author, i.user_id
         FROM issues i JOIN users u ON i.user_id = u.id
         WHERE i.is_draft = false
            OR i.user_id = $1
            OR i.id IN (SELECT issue_id FROM issue_section_editors WHERE user_id = $1)
         ORDER BY i.created_at DESC`,
        [user.id]
      );
    } else {
      r = await pool.query(
        `SELECT i.id, i.title, i.is_draft, i.created_at, u.name AS author, i.user_id
         FROM issues i JOIN users u ON i.user_id = u.id
         WHERE i.is_draft = false
         ORDER BY i.created_at DESC`
      );
    }
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

// 완료 이슈: 비로그인 조회 가능 / 초안: 작성자·편집자만
async function getIssue(event, id) {
  const user = verifyToken(event);
  try {
    const ir = await pool.query(
      'SELECT i.*, u.name AS author FROM issues i JOIN users u ON i.user_id=u.id WHERE i.id=$1', [id]
    );
    if (!ir.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });

    if (ir.rows[0].is_draft) {
      if (!user) return resp(403, { error: '로그인이 필요합니다.' });
      if (ir.rows[0].user_id !== user.id) {
        const ed = await pool.query(
          'SELECT id FROM issue_section_editors WHERE issue_id=$1 AND user_id=$2', [id, user.id]
        );
        if (!ed.rows.length) return resp(403, { error: '조회 권한이 없습니다.' });
      }
    }

    const sr = await pool.query(
      'SELECT section_no, content FROM issue_sections WHERE issue_id=$1 ORDER BY section_no', [id]
    );
    const sections = [1,2,3,4,5].map(n => {
      const f = sr.rows.find(r => r.section_no === n);
      return f ? f.content : '';
    });

    const er = await pool.query(
      `SELECT ise.section_no, ise.user_id, u.email, u.name AS editor_name
       FROM issue_section_editors ise JOIN users u ON ise.user_id = u.id
       WHERE ise.issue_id = $1`, [id]
    );
    // editors: 5개 배열, null이면 미지정
    const editors = [1,2,3,4,5].map(n => {
      const f = er.rows.find(r => r.section_no === n);
      return f ? { user_id: f.user_id, email: f.email, name: f.editor_name } : null;
    });

    return resp(200, { issue: ir.rows[0], sections, editors });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function deleteIssue(event, id) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const check = await pool.query('SELECT user_id FROM issues WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '삭제 권한이 없습니다.' });
    await pool.query('DELETE FROM issues WHERE id=$1', [id]);
    return resp(200, { ok: true });
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

// 작성자: 전체 5개 섹션 + 기사 본문 저장
async function saveSections(event, id) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { sections, is_draft, article_content } = getBody(event);
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
    const draft = is_draft !== undefined ? is_draft : true;
    await pool.query(
      'UPDATE issues SET is_draft=$1, article_content=$2, updated_at=NOW() WHERE id=$3',
      [draft, article_content ?? '', id]
    );
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

// 편집자: 단일 섹션 저장
async function saveSection(event, id, sectionNo) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { content } = getBody(event);
  try {
    const issue = await pool.query('SELECT user_id FROM issues WHERE id=$1', [id]);
    if (!issue.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });

    const isAuthor = issue.rows[0].user_id === user.id;
    if (!isAuthor) {
      const edCheck = await pool.query(
        'SELECT id FROM issue_section_editors WHERE issue_id=$1 AND section_no=$2 AND user_id=$3',
        [id, sectionNo, user.id]
      );
      if (!edCheck.rows.length) return resp(403, { error: '편집 권한이 없습니다.' });
    }
    await pool.query(
      `INSERT INTO issue_sections (issue_id, section_no, content, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, updated_at=NOW()`,
      [id, sectionNo, content || '']
    );
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

// 작성자: 섹션 편집자 지정
async function setEditor(event, id) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { section_no, email } = getBody(event);
  if (!section_no || !email) return resp(400, { error: '섹션 번호와 이메일을 입력하세요.' });
  try {
    const check = await pool.query('SELECT user_id FROM issues WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '작성자만 편집자를 지정할 수 있습니다.' });

    const target = await pool.query('SELECT id, name FROM users WHERE email=$1', [email]);
    if (!target.rows.length) return resp(404, { error: '해당 이메일의 사용자가 없습니다.' });
    const editor = target.rows[0];

    await pool.query(
      `INSERT INTO issue_section_editors (issue_id, section_no, user_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (issue_id, section_no) DO UPDATE SET user_id=$3`,
      [id, section_no, editor.id]
    );
    return resp(200, { editor: { user_id: editor.id, name: editor.name, email } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

// 작성자: 섹션 편집자 해제
async function removeEditor(event, id, sectionNo) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const check = await pool.query('SELECT user_id FROM issues WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });
    await pool.query(
      'DELETE FROM issue_section_editors WHERE issue_id=$1 AND section_no=$2', [id, sectionNo]
    );
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
    const queries = [
      '%EB%AC%B8%ED%99%94+%EC%98%88%EC%88%A0',
      '%EA%B3%B5%EC%97%B0+%EC%A0%84%EC%8B%9C',
      '%EC%98%81%ED%99%94+%EC%9D%8C%EC%95%85',
    ];
    const q = queries[Math.floor(Math.random() * queries.length)];
    const rss = await fetchUrl(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`);

    const titles = [];
    const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g;
    let m;
    while ((m = re.exec(rss)) !== null && titles.length < 25) {
      const t = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();
      if (t && !t.toLowerCase().includes('google')) titles.push(t);
    }
    if (!titles.length) throw new Error('뉴스를 가져올 수 없습니다.');

    const shuffled = titles.sort(() => Math.random() - 0.5).slice(0, 12);
    const existing = await pool.query('SELECT title FROM issues ORDER BY created_at DESC LIMIT 20');
    const existingTitles = existing.rows.map(r => r.title).join('\n');

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `아래 최신 뉴스 제목 중 문화·예술·공연·전시·영화·음악 관련 기사 주제로 적합한 것을 하나 골라, 한국어 기사 제목 형식으로 다듬어 제목만 출력하세요.\n이미 존재하는 이슈와 중복되지 않게 선택하세요.\n설명 없이 제목 텍스트만 출력하세요.\n\n[이미 있는 이슈]\n${existingTitles || '없음'}\n\n[최신 뉴스]\n${shuffled.join('\n')}`
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
    const ur = await pool.query('SELECT writing_style FROM users WHERE id=$1', [user.id]);
    const writingStyle = ur.rows[0]?.writing_style || '';

    const sr = await pool.query('SELECT file_name, s3_key FROM user_samples WHERE user_id=$1 ORDER BY created_at ASC', [user.id]);
    const sampleTexts = [];
    for (const sample of sr.rows) {
      const ext = sample.file_name.split('.').pop().toLowerCase();
      if (['txt', 'md', 'text'].includes(ext)) {
        try {
          const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: sample.s3_key }));
          const chunks = [];
          for await (const chunk of obj.Body) chunks.push(chunk);
          const text = Buffer.concat(chunks).toString('utf-8').slice(0, 1500);
          sampleTexts.push(`[${sample.file_name}]\n${text}`);
        } catch {}
      }
    }

    const labels = ['배경/발단', '주요 내용', '인터뷰/현장', '관련 자료', '결론/전망'];
    const body = sections.map((s, i) => `[${labels[i]}]\n${s || '(내용 없음)'}`).join('\n\n');

    let personalSection = '';
    if (writingStyle) personalSection += `\n\n[작성자 스타일 가이드]\n${writingStyle}`;
    if (sampleTexts.length) personalSection += `\n\n[샘플 기사 참고]\n${sampleTexts.join('\n\n')}`;

    const styleNote = personalSection
      ? '\n위 스타일 가이드와 샘플 기사를 참고하여 작성자의 문체와 형식을 최대한 반영하세요.'
      : '';

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `아래 제목과 5개 섹션 내용을 바탕으로 완성도 높은 뉴스 기사를 작성해 주세요.\n육하원칙에 따라 자연스럽게 이어지는 기사 형식으로 작성하세요.${styleNote}\n\n제목: ${title}\n\n${body}${personalSection}`
      }]
    });
    return resp(200, { article: msg.content[0].text.trim() });
  } catch (e) { console.error(e); return resp(500, { error: e.message || '기사 생성 실패' }); }
}

async function getMypage(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const ur = await pool.query('SELECT name, email, writing_style FROM users WHERE id=$1', [user.id]);
    const sr = await pool.query(
      'SELECT id, file_name, s3_key, file_size, created_at FROM user_samples WHERE user_id=$1 ORDER BY created_at ASC',
      [user.id]
    );
    return resp(200, {
      profile: { name: ur.rows[0].name, email: ur.rows[0].email },
      writing_style: ur.rows[0]?.writing_style || '',
      samples: sr.rows,
    });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function saveStyle(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { writing_style } = getBody(event);
  try {
    await pool.query('UPDATE users SET writing_style=$1 WHERE id=$2', [writing_style || '', user.id]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function uploadSample(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { fileName, fileType, fileData, fileSize } = getBody(event);
  if (!fileName || !fileData) return resp(400, { error: '파일 데이터가 없습니다.' });
  try {
    const count = await pool.query('SELECT COUNT(*) FROM user_samples WHERE user_id=$1', [user.id]);
    if (parseInt(count.rows[0].count) >= 3) return resp(400, { error: '샘플은 최대 3개까지 업로드할 수 있습니다.' });

    const buf = Buffer.from(fileData, 'base64');
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._\-가-힣]/g, '_');
    const key = `samples/${user.id}/${Date.now()}_${safeFileName}`;
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buf,
      ContentType: fileType || 'application/octet-stream',
    }));
    const r = await pool.query(
      'INSERT INTO user_samples (user_id, file_name, s3_key, file_size) VALUES($1,$2,$3,$4) RETURNING id, file_name, s3_key, file_size, created_at',
      [user.id, fileName, key, fileSize || buf.length]
    );
    return resp(201, { sample: r.rows[0] });
  } catch (e) { console.error(e); return resp(500, { error: e.message || '업로드 실패' }); }
}

async function deleteSample(event, id) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query('SELECT s3_key, user_id FROM user_samples WHERE id=$1', [id]);
    if (!r.rows.length) return resp(404, { error: '파일을 찾을 수 없습니다.' });
    if (r.rows[0].user_id !== user.id) return resp(403, { error: '삭제 권한이 없습니다.' });
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: r.rows[0].s3_key }));
    await pool.query('DELETE FROM user_samples WHERE id=$1', [id]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: e.message || '삭제 실패' }); }
}
