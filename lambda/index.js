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

// Lambda 재시작 시 누락 컬럼 자동 추가 (idempotent)
let _migrated = false;
async function ensureColumns() {
  if (_migrated) return;
  try {
    await pool.query(`
      ALTER TABLE novel_nodes ADD COLUMN IF NOT EXISTS is_visible BOOLEAN DEFAULT FALSE;
      ALTER TABLE novel_nodes ADD COLUMN IF NOT EXISTS ai_content TEXT    DEFAULT '';
      ALTER TABLE novel_nodes ADD COLUMN IF NOT EXISTS node_ref   JSONB   DEFAULT '{}';
    `);
    _migrated = true;
  } catch (e) { console.error('migration error:', e.message); }
}

exports.handler = async (event) => {
  await ensureColumns();
  const method = getMethod(event);
  const path   = getPath(event);

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // ────────────────────────────────────────────
  // [공통] 인증
  // ────────────────────────────────────────────
  if (path === '/auth/register'    && method === 'POST') return register(event);
  if (path === '/auth/login'       && method === 'POST') return login(event);
  if (path === '/auth/check-email' && method === 'POST') return checkEmail(event);

  // ────────────────────────────────────────────
  // [공통] 마이페이지
  // ────────────────────────────────────────────
  if (path === '/mypage'                && method === 'GET')  return getMypage(event);
  if (path === '/mypage/article-style'  && method === 'POST') return saveArticleStyle(event);
  if (path === '/mypage/section-guides' && method === 'GET')  return getSectionGuides(event);
  if (path === '/mypage/section-guides' && method === 'POST') return saveSectionGuide(event);
  if (path === '/mypage/section-labels' && method === 'GET')  return getSectionLabels(event);
  if (path === '/mypage/section-labels' && method === 'POST') return saveSectionLabelOne(event);

  // ────────────────────────────────────────────
  // [기사 작성] Issues / Sections / AI / Comments / Bookmarks
  // ────────────────────────────────────────────
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

  const issueReactM    = path.match(/^\/issues\/(\d+)\/react$/);
  const searchRelatedM = path.match(/^\/issues\/(\d+)\/search-related$/);
  const aiWriteSecM    = path.match(/^\/issues\/(\d+)\/sections\/(\d+)\/ai-write$/);
  if (issueReactM    && method === 'POST') return reactIssue(event, issueReactM[1]);
  if (searchRelatedM && method === 'POST') return searchRelated(event, searchRelatedM[1]);
  if (aiWriteSecM    && method === 'POST') return aiWriteSection(event, aiWriteSecM[1], aiWriteSecM[2]);

  const autoSectionsM = path.match(/^\/issues\/(\d+)\/auto-sections$/);
  if (autoSectionsM && method === 'POST') return autoFillSections(event, autoSectionsM[1]);

  const commentM      = path.match(/^\/issues\/(\d+)\/comments$/);
  const commentIdM    = path.match(/^\/comments\/(\d+)$/);
  const commentReactM = path.match(/^\/comments\/(\d+)\/react$/);
  if (commentM      && method === 'GET')    return getComments(event, commentM[1]);
  if (commentM      && method === 'POST')   return createComment(event, commentM[1]);
  if (commentIdM    && method === 'DELETE') return deleteComment(event, commentIdM[1]);
  if (commentReactM && method === 'POST')   return reactComment(event, commentReactM[1]);

  const folderM      = path.match(/^\/bookmarks\/folders\/(\d+)$/);
  const folderLinksM = path.match(/^\/bookmarks\/folders\/(\d+)\/links$/);
  const linkM        = path.match(/^\/bookmarks\/links\/(\d+)$/);
  if (path === '/bookmarks'          && method === 'GET')    return getBookmarks(event);
  if (path === '/bookmarks/folders'  && method === 'POST')   return createFolder(event);
  if (folderM       && method === 'DELETE') return deleteFolder(event, folderM[1]);
  if (folderLinksM  && method === 'POST')   return addLink(event, folderLinksM[1]);
  if (linkM         && method === 'DELETE') return deleteLink(event, linkM[1]);

  // ────────────────────────────────────────────
  // [웹소설] Novels / Episodes / Comments
  // ────────────────────────────────────────────
  if (path === '/novel/novels' && method === 'GET')  return getNovels(event);
  if (path === '/novel/novels' && method === 'POST') return createNovel(event);

  const novelM         = path.match(/^\/novel\/novels\/(\d+)$/);
  const novelEpsM      = path.match(/^\/novel\/novels\/(\d+)\/episodes$/);
  const novelReactM    = path.match(/^\/novel\/novels\/(\d+)\/react$/);
  const novelComM      = path.match(/^\/novel\/novels\/(\d+)\/comments$/);
  const novelComIdM    = path.match(/^\/novel\/comments\/(\d+)$/);
  const novelComReactM = path.match(/^\/novel\/comments\/(\d+)\/react$/);

  if (novelM        && method === 'GET')    return getNovel(event, novelM[1]);
  if (novelM        && method === 'PUT')    return updateNovel(event, novelM[1]);
  if (novelM        && method === 'DELETE') return deleteNovel(event, novelM[1]);
  if (novelEpsM     && method === 'POST')   return saveEpisodes(event, novelEpsM[1]);
  if (novelReactM   && method === 'POST')   return reactNovel(event, novelReactM[1]);
  if (novelComM     && method === 'GET')    return getNovelComments(event, novelComM[1]);
  if (novelComM     && method === 'POST')   return createNovelComment(event, novelComM[1]);
  if (novelComIdM   && method === 'DELETE') return deleteNovelComment(event, novelComIdM[1]);
  if (novelComReactM && method === 'POST')  return reactNovelComment(event, novelComReactM[1]);

  // ────────────────────────────────────────────
  // [웹소설] 메뉴 노드 / 기준정보 / AI 다듬기
  // ────────────────────────────────────────────
  const novelNodesM  = path.match(/^\/novel\/novels\/(\d+)\/nodes$/);
  const novelNodeIdM = path.match(/^\/novel\/nodes\/(\d+)$/);
  const novelRefM    = path.match(/^\/novel\/novels\/(\d+)\/refinfo$/);
  const novelPolishM = path.match(/^\/novel\/nodes\/(\d+)\/polish$/);

  if (novelNodesM  && method === 'GET')    return getNovelNodes(event, novelNodesM[1]);
  if (novelNodesM  && method === 'POST')   return createNovelNode(event, novelNodesM[1]);
  if (novelNodeIdM && method === 'PUT')    return updateNovelNode(event, novelNodeIdM[1]);
  if (novelNodeIdM && method === 'DELETE') return deleteNovelNode(event, novelNodeIdM[1]);
  if (novelRefM    && method === 'GET')    return getRefInfo(event, novelRefM[1]);
  if (novelRefM    && method === 'PUT')    return saveRefInfo(event, novelRefM[1]);
  if (novelPolishM && method === 'POST')   return polishNodeContent(event, novelPolishM[1]);

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

// 비로그인: 완료된 이슈만 / 로그인: 완료 + 본인 + 편집권한 초안 / 검색·필터·페이징 지원
async function getIssues(event) {
  const user = verifyToken(event);
  const qs     = event.queryStringParameters || {};
  const q      = (qs.q     || '').trim();
  const author = (qs.author || '').trim();
  const date   = (qs.date  || '').trim();
  const mine   = qs.mine  === '1' && !!user;
  const draft  = qs.draft === '1' && !!user;
  const edit   = qs.edit  === '1' && !!user;
  const page   = Math.max(1, parseInt(qs.page) || 1);
  const limit  = 30;
  const offset = (page - 1) * limit;

  try {
    const conds = [];
    const params = [];
    let idx = 1;

    // 가시성 조건
    if (edit) {
      // 내 편집: 편집자로 지정된 이슈만
      conds.push(`i.id IN (SELECT issue_id FROM issue_section_editors WHERE user_id = $${idx})`);
      params.push(user.id); idx++;
    } else if (mine) {
      conds.push(`i.user_id = $${idx}`); params.push(user.id); idx++;
    } else if (user) {
      conds.push(`(i.is_draft = false OR i.user_id = $${idx} OR i.id IN (SELECT issue_id FROM issue_section_editors WHERE user_id = $${idx}))`);
      params.push(user.id); idx++;
    } else {
      conds.push('i.is_draft = false');
    }

    if (draft && user) conds.push('i.is_draft = true');

    if (q)            { conds.push(`i.title ILIKE $${idx++}`);        params.push(`%${q}%`); }
    if (author)       { conds.push(`u.name  ILIKE $${idx++}`);        params.push(`%${author}%`); }
    if (date)         { conds.push(`DATE(i.created_at) = $${idx++}`); params.push(date); }
    if (qs.category)  { conds.push(`i.category = $${idx++}`);         params.push(qs.category); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const base  = `FROM issues i JOIN users u ON i.user_id = u.id ${where}`;

    const countR = await pool.query(`SELECT COUNT(*) ${base}`, params);
    const total  = parseInt(countR.rows[0].count);

    let dataR;
    try {
      dataR = await pool.query(
        `SELECT i.id, i.title, i.is_draft, i.category, i.view_count, i.created_at, u.name AS author, i.user_id,
          COALESCE((SELECT SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END) FROM issue_reactions WHERE issue_id=i.id),0)::int AS likes,
          COALESCE((SELECT SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END) FROM issue_reactions WHERE issue_id=i.id),0)::int AS dislikes,
          COALESCE((SELECT COUNT(*) FROM comments WHERE issue_id=i.id),0)::int AS comment_count
         ${base} ORDER BY i.created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
        [...params, limit, offset]
      );
    } catch {
      dataR = await pool.query(
        `SELECT i.id, i.title, i.is_draft, i.category, i.view_count, i.created_at, u.name AS author, i.user_id,
          0 AS likes, 0 AS dislikes
         ${base} ORDER BY i.created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
        [...params, limit, offset]
      );
    }

    return resp(200, { issues: dataR.rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function createIssue(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { title, category } = getBody(event);
  if (!title?.trim()) return resp(400, { error: '제목을 입력하세요.' });
  const cat = category || '문화';
  try {
    const r = await pool.query(
      'INSERT INTO issues (user_id,title,category,is_draft) VALUES($1,$2,$3,TRUE) RETURNING id,title,category,created_at',
      [user.id, title.trim(), cat]
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

    // 조회수: 로그인 사용자만, 계정당 1회 카운트
    if (user) {
      const dup = await pool.query(
        'INSERT INTO issue_views (issue_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [id, user.id]
      );
      if (dup.rowCount > 0) {
        await pool.query('UPDATE issues SET view_count = view_count + 1 WHERE id=$1', [id]);
      }
    }

    let sr;
    try {
      sr = await pool.query(
        `SELECT section_no, content,
                COALESCE(guide,'')      AS guide,
                COALESCE(ai_content,'') AS ai_content,
                COALESCE(label,'')      AS label
         FROM issue_sections WHERE issue_id=$1 ORDER BY section_no`, [id]
      );
    } catch {
      sr = await pool.query(
        `SELECT section_no, content, '' AS guide, '' AS ai_content, '' AS label
         FROM issue_sections WHERE issue_id=$1 ORDER BY section_no`, [id]
      );
    }
    const sections = [1,2,3,4,5].map(n => {
      const f = sr.rows.find(r => r.section_no === n);
      return f ? f.content : '';
    });
    const sectionGuides = [1,2,3,4,5].map(n => {
      const f = sr.rows.find(r => r.section_no === n);
      return f ? f.guide : '';
    });
    const sectionAiContents = [1,2,3,4,5].map(n => {
      const f = sr.rows.find(r => r.section_no === n);
      return f ? f.ai_content : '';
    });
    const sectionLabels = [1,2,3,4,5].map(n => {
      const f = sr.rows.find(r => r.section_no === n);
      return f ? f.label : '';
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

    // 좋아요/싫어요 집계 (테이블 없을 시 방어)
    let reactions = { likes: 0, dislikes: 0, my_reaction: null };
    try {
      const rr = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
          COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
          MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
        FROM issue_reactions WHERE issue_id=$2
      `, [user?.id || -1, id]);
      reactions = rr.rows[0];
    } catch {}

    return resp(200, { issue: { ...ir.rows[0], ...reactions }, sections, sectionGuides, sectionAiContents, sectionLabels, editors });
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
  const { sections, guides, labels, aiContents, is_draft, article_content } = getBody(event);
  if (!Array.isArray(sections) || sections.length !== 5)
    return resp(400, { error: '섹션 데이터가 올바르지 않습니다.' });
  try {
    const check = await pool.query('SELECT user_id FROM issues WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '수정 권한이 없습니다.' });
    for (let i = 0; i < 5; i++) {
      try {
        await pool.query(
          `INSERT INTO issue_sections (issue_id, section_no, content, guide, ai_content, updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, guide=$4, ai_content=$5, updated_at=NOW()`,
          [id, i + 1, sections[i] || '', (guides && guides[i]) || '', (aiContents && aiContents[i]) || '']
        );
      } catch {
        await pool.query(
          `INSERT INTO issue_sections (issue_id, section_no, content, updated_at)
           VALUES ($1,$2,$3,NOW())
           ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, updated_at=NOW()`,
          [id, i + 1, sections[i] || '']
        );
      }
    }
    const draft = is_draft !== undefined ? is_draft : true;
    await pool.query(
      'UPDATE issues SET is_draft=$1, article_content=$2, updated_at=NOW() WHERE id=$3',
      [draft, article_content ?? '', id]
    );

    // 작성완료 시 비어있지 않은 라벨만 user_section_labels에 영구저장
    if (!draft && labels) {
      for (let i = 0; i < 5; i++) {
        const lbl = (labels[i] || '').trim();
        if (!lbl) continue;
        try {
          await pool.query(
            `INSERT INTO user_section_labels (user_id, section_no, label, updated_at)
             VALUES ($1,$2,$3,NOW())
             ON CONFLICT (user_id, section_no) DO UPDATE SET label=$3, updated_at=NOW()`,
            [user.id, i + 1, lbl]
          );
        } catch {}
      }
    }

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

function extractPageLinks(html, baseUrl) {
  const links = [];
  const re = /<a[^>]+href=["']([^"'#][^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && links.length < 30) {
    let href = m[1].trim();
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    if (!href.startsWith('http')) {
      try { href = new URL(href, baseUrl).href; } catch { continue; }
    }
    if (text.length >= 5 && text.length <= 150 && /[가-힣a-zA-Z]/.test(text)) {
      links.push({ title: text, url: href });
    }
  }
  const seen = new Set();
  return links.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
}

function extractPageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

async function aiTopic(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const body = getBody(event);
    const userTitle = (body.userTitle || '').trim();
    const category  = body.category || '문화';
    if (!userTitle) return resp(400, { error: '제목을 입력하세요.' });

    // URL 입력 감지 → 링크 분석 흐름
    if (/^https?:\/\//i.test(userTitle)) {
      return await aiTopicFromUrl(event, user, userTitle, category);
    }

    // 1. Haiku로 핵심 키워드 추출
    let keywords = userTitle.split(/\s+/).slice(0, 4).join(' ');
    try {
      const kwMsg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 40,
        messages: [{ role: 'user', content: `기사 제목에서 검색에 유용한 핵심 명사 4개만 추출. 구체적 고유명사·전문용어 위주. 띄어쓰기로만 구분해서 단어들만 출력.\n제목: ${userTitle}` }]
      });
      keywords = kwMsg.content[0].text.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
    } catch {}

    // 2. RSS 검색 (최신순)
    const q = encodeURIComponent(keywords);
    const rss = await fetchUrl(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`);
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let im;
    while ((im = itemRe.exec(rss)) !== null && items.length < 25) {
      const xml = im[1];
      const tM  = xml.match(/<title>([\s\S]*?)<\/title>/);
      const lM  = xml.match(/<link>([\s\S]*?)<\/link>/) || xml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      const dM  = xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (!tM) continue;
      const t = tM[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();
      const l = lM ? lM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      const d = dM ? dM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      if (t && l && /^https?:\/\//i.test(l) && !t.toLowerCase().includes('google')) items.push({ title: t, link: l, pubDate: d });
    }
    items.sort((a, b) => (b.pubDate ? new Date(b.pubDate) : 0) - (a.pubDate ? new Date(a.pubDate) : 0));

    if (!items.length) return resp(422, { error: '입력한 제목으로 관련 최신 기사를 찾지 못했습니다. 다른 제목으로 시도해보세요.' });

    // 3. Haiku로 제목 다듬기
    let finalTitle = userTitle;
    try {
      const refContext = items.slice(0, 5).map(i => i.title).join('\n');
      const titleMsg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 80,
        messages: [{ role: 'user', content: `기사 제목을 최신 뉴스 참고해서 더 구체적으로 다듬어 한 줄로 출력하세요.\n규칙: 반드시 완성된 기사 제목 텍스트만 출력. 설명·이유·실패메시지·부연 문장 절대 금지.\n적합한 제목을 못 찾으면 원본 제목을 그대로 출력.\n\n원본 제목: ${userTitle}\n최신 뉴스:\n${refContext}` }]
      });
      const refined = titleMsg.content[0].text.trim().split('\n')[0]; // 첫 줄만
      // 실패·설명 메시지로 보이면 원본 유지
      const isFailMsg = /완전하지|부족|실패|없습니다|찾지 못|불가능|어렵습니다|적합하지|모르겠|죄송/.test(refined);
      if (refined && refined.length > 3 && refined.length < 120 && !isFailMsg) finalTitle = refined;
    } catch {}

    const refLinks = items.map(i => ({ title: i.title, url: i.link, pubDate: i.pubDate || '' }));

    let r;
    try {
      r = await pool.query(
        'INSERT INTO issues (user_id,title,category,is_draft,reference_links) VALUES($1,$2,$3,TRUE,$4) RETURNING id,title,category,created_at',
        [user.id, finalTitle, category, JSON.stringify(refLinks)]
      );
    } catch {
      r = await pool.query(
        'INSERT INTO issues (user_id,title,category,is_draft) VALUES($1,$2,$3,TRUE) RETURNING id,title,category,created_at',
        [user.id, finalTitle, category]
      );
    }
    return resp(201, { issue: { ...r.rows[0], author: user.name, user_id: user.id } });
  } catch (e) { console.error(e); return resp(500, { error: e.message || 'AI 주제 생성 실패' }); }
}

async function generateArticle(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { title, sections, content } = getBody(event);
  if (!title) return resp(400, { error: '제목을 입력하세요.' });
  try {
    let writingStyle = '', articleStyle = '';
    try {
      const ur = await pool.query(
        `SELECT writing_style, COALESCE(article_style,'') AS article_style FROM users WHERE id=$1`, [user.id]
      );
      writingStyle = ur.rows[0]?.writing_style || '';
      articleStyle = ur.rows[0]?.article_style  || '';
    } catch {
      const ur = await pool.query('SELECT writing_style FROM users WHERE id=$1', [user.id]);
      writingStyle = ur.rows[0]?.writing_style || '';
    }


    let promptContent;

    if (content?.trim()) {
      // 다듬기 모드: 원고 내용 그대로 유지하면서 스타일·맞춤법만 교정
      let styleBlock = '';
      if (articleStyle) styleBlock += `\n\n[기사 완성본 스타일 예시 — 이 문체와 형식을 참고]\n${articleStyle}`;
      if (writingStyle) styleBlock += `\n\n[작성자 스타일 가이드]\n${writingStyle}`;
      const styleNote = styleBlock ? '\n위 스타일 가이드의 문체와 형식을 반영하되, 원고의 모든 내용은 반드시 유지하세요.' : '';
      const hasStyle = !!(articleStyle?.trim());
      const styleRef = hasStyle
        ? `\n\n[기사 스타일 참고]\n${articleStyle}`
        : '';
      promptContent = `아래 기사 원고를 하나의 완성된 뉴스 기사로 다듬어주세요.

주의사항:
- ###, **, -- 같은 섹션 구분자나 소제목을 제거하고 하나의 흐름으로 이어지게 작성하세요
- 각 문단이 자연스럽게 연결되도록 하고, 별개 기사처럼 끊기지 않게 해주세요
- ${hasStyle ? '위 스타일 참고해 문체·구조를 맞춰주세요.' : '전문 뉴스 기자처럼 서론·본론·결론이 자연스럽게 이어지는 한 편의 기사로 작성하세요.'}

기사 제목: ${title}

[원고]
${content}${styleRef}`;
    } else {
      // 섹션 기반 생성 모드 (기존)
      if (!Array.isArray(sections)) return resp(400, { error: '섹션 내용을 입력하세요.' });
      const labels = ['배경/발단', '주요 내용', '인터뷰/현장', '관련 자료', '결론/전망'];
      const body = sections.map((s, i) => `[${labels[i]}]\n${s || '(내용 없음)'}`).join('\n\n');
      let personalSection = '';
      if (articleStyle) personalSection += `\n\n[기사 완성본 스타일 예시]\n${articleStyle}`;
      if (writingStyle)  personalSection += `\n\n[작성자 스타일 가이드]\n${writingStyle}`;
      const styleNote = personalSection ? '\n위 스타일 예시와 가이드를 최대한 반영하세요.' : '';
      promptContent = `아래 제목과 5개 섹션 내용을 바탕으로 완성도 높은 뉴스 기사를 작성해 주세요.\n육하원칙에 따라 자연스럽게 이어지는 기사 형식으로 작성하세요.${styleNote}\n\n제목: ${title}\n\n${body}${personalSection}`;
    }

    // 다듬기(content 전달) → Haiku(빠름), 섹션 기반 생성 → Sonnet
    const useHaiku = !!(content?.trim());
    const msg = await anthropic.messages.create({
      model:      useHaiku ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6',
      max_tokens: useHaiku ? 6000 : 3000,
      messages: [{ role: 'user', content: promptContent }]
    });
    return resp(200, { article: msg.content[0].text.trim() });
  } catch (e) { console.error(e); return resp(500, { error: e.message || '기사 생성 실패' }); }
}

async function getMypage(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const ur = await pool.query(
      `SELECT name, email, COALESCE(article_style,'') AS article_style FROM users WHERE id=$1`, [user.id]
    );
    return resp(200, {
      profile: { name: ur.rows[0].name, email: ur.rows[0].email },
      article_style: ur.rows[0]?.article_style || '',
    });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}


async function reactIssue(event, issueId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { reaction } = getBody(event);
  if (!['like', 'dislike'].includes(reaction)) return resp(400, { error: '잘못된 요청' });
  try {
    const cur = await pool.query(
      'SELECT reaction FROM issue_reactions WHERE issue_id=$1 AND user_id=$2', [issueId, user.id]
    );
    if (cur.rows.length && cur.rows[0].reaction === reaction) {
      await pool.query('DELETE FROM issue_reactions WHERE issue_id=$1 AND user_id=$2', [issueId, user.id]);
    } else {
      await pool.query(
        `INSERT INTO issue_reactions (issue_id, user_id, reaction) VALUES($1,$2,$3)
         ON CONFLICT (issue_id, user_id) DO UPDATE SET reaction=$3`,
        [issueId, user.id, reaction]
      );
    }
    const c = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
      FROM issue_reactions WHERE issue_id=$2
    `, [user.id, issueId]);
    return resp(200, c.rows[0]);
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getComments(event, issueId) {
  const user = verifyToken(event);
  const uid  = user?.id || -1;
  try {
    const r = await pool.query(`
      SELECT c.id, c.content, c.created_at, u.name AS author, c.user_id,
        COALESCE(SUM(CASE WHEN cr.reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN cr.reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN cr.user_id=$1 THEN cr.reaction END) AS my_reaction
      FROM comments c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN comment_reactions cr ON cr.comment_id = c.id
      WHERE c.issue_id = $2
      GROUP BY c.id, u.name, c.user_id
      ORDER BY c.created_at ASC
    `, [uid, issueId]);
    return resp(200, { comments: r.rows });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function createComment(event, issueId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { content } = getBody(event);
  if (!content?.trim()) return resp(400, { error: '내용을 입력하세요.' });
  try {
    const r = await pool.query(
      'INSERT INTO comments (issue_id, user_id, content) VALUES($1,$2,$3) RETURNING id, content, created_at',
      [issueId, user.id, content.trim()]
    );
    return resp(201, { comment: { ...r.rows[0], author: user.name, user_id: user.id, likes: 0, dislikes: 0, my_reaction: null } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function deleteComment(event, commentId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query('SELECT user_id FROM comments WHERE id=$1', [commentId]);
    if (!r.rows.length) return resp(404, { error: '댓글을 찾을 수 없습니다.' });
    if (r.rows[0].user_id !== user.id) return resp(403, { error: '삭제 권한이 없습니다.' });
    await pool.query('DELETE FROM comments WHERE id=$1', [commentId]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function reactComment(event, commentId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { reaction } = getBody(event);
  if (!['like', 'dislike'].includes(reaction)) return resp(400, { error: '잘못된 요청' });
  try {
    const cur = await pool.query(
      'SELECT reaction FROM comment_reactions WHERE comment_id=$1 AND user_id=$2', [commentId, user.id]
    );
    if (cur.rows.length && cur.rows[0].reaction === reaction) {
      await pool.query('DELETE FROM comment_reactions WHERE comment_id=$1 AND user_id=$2', [commentId, user.id]);
    } else {
      await pool.query(
        `INSERT INTO comment_reactions (comment_id, user_id, reaction) VALUES($1,$2,$3)
         ON CONFLICT (comment_id, user_id) DO UPDATE SET reaction=$3`,
        [commentId, user.id, reaction]
      );
    }
    const c = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
      FROM comment_reactions WHERE comment_id=$2
    `, [user.id, commentId]);
    return resp(200, c.rows[0]);
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function searchRelated(event, issueId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const ir = await pool.query('SELECT title, category FROM issues WHERE id=$1', [issueId]);
    if (!ir.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    const { title, category } = ir.rows[0];

    const catExtra = {
      '문화': '예술 공연 전시',   '정치': '국회 정책 정부',
      '경제': '산업 금융 주식',   '사회': '사건 복지 환경',
      '스포츠': '축구 야구 올림픽','연예': '드라마 K팝 영화',
      'IT/과학': '인공지능 기술', '국제': '외교 세계 해외',
      '교육': '학교 입시 대학',   '건강': '의료 병원 질병',
    };

    // Haiku로 핵심 키워드 4개 추출 (흔하지 않고 구체적인 단어)
    let keywords;
    try {
      const kwMsg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 40,
        messages: [{
          role: 'user',
          content: `기사 제목에서 검색에 유용한 핵심 명사 4개만 추출하세요. 흔하지 않고 구체적인 고유명사·전문용어 위주. 쉼표 없이 띄어쓰기로만 구분해서 단어들만 출력.\n제목: ${title}`
        }]
      });
      keywords = kwMsg.content[0].text.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
    } catch {
      keywords = title.split(/\s+/).slice(0, 4).join(' ');
    }

    const extra = catExtra[category] || '';
    const q = encodeURIComponent(`${keywords} ${extra}`.trim());

    const rss = await fetchUrl(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`);
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let im;
    while ((im = itemRe.exec(rss)) !== null && items.length < 25) {
      const xml = im[1];
      const tM  = xml.match(/<title>([\s\S]*?)<\/title>/);
      const lM  = xml.match(/<link>([\s\S]*?)<\/link>/) || xml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      const dM  = xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (!tM) continue;
      const t = tM[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();
      const l = lM ? lM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      const d = dM ? dM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      if (t && l && /^https?:\/\//i.test(l) && !t.toLowerCase().includes('google')) {
        items.push({ title: t, url: l, pubDate: d });
      }
    }

    // 날짜순 정렬 (최신 상단)
    items.sort((a, b) => {
      const da = a.pubDate ? new Date(a.pubDate) : 0;
      const db = b.pubDate ? new Date(b.pubDate) : 0;
      return db - da;
    });

    return resp(200, { items });
  } catch (e) { console.error(e); return resp(500, { error: '검색 실패' }); }
}

async function aiWriteSection(event, issueId, sectionNo) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { content, guide, label } = getBody(event);
  try {
    const ir = await pool.query('SELECT title FROM issues WHERE id=$1', [issueId]);
    if (!ir.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    const issueTitle = ir.rows[0].title;
    const DEFAULT_LABELS = ['배경/발단', '주요 내용', '인터뷰/현장', '관련 자료', '결론/전망'];
    const sectionLabel = label?.trim() || DEFAULT_LABELS[parseInt(sectionNo) - 1] || `섹션 ${sectionNo}`;
    // 전달된 가이드 없으면 영구저장 가이드 사용
    let finalGuide = guide?.trim() || '';
    if (!finalGuide) {
      try {
        const gr = await pool.query(
          'SELECT guide FROM user_section_guides WHERE user_id=$1 AND section_no=$2',
          [user.id, sectionNo]
        );
        finalGuide = gr.rows[0]?.guide || '';
      } catch {}
    }
    const guideNote   = finalGuide   ? `\n\n[작성 가이드]\n${finalGuide}`   : '';
    const contentNote = content?.trim() ? `\n\n[작성자 메모]\n${content}` : '';
    const ur = await pool.query('SELECT writing_style FROM users WHERE id=$1', [user.id]);
    const writingStyle = ur.rows[0]?.writing_style || '';
    const styleNote = writingStyle ? `\n\n[작성 스타일]\n${writingStyle}` : '';

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      messages: [{
        role: 'user',
        content: `다음 기사의 "${sectionLabel}" 섹션을 전문 기자 스타일로 작성해주세요.\n기사 제목: ${issueTitle}${guideNote}${contentNote}${styleNote}\n\n규칙:\n- 작성자 메모를 바탕으로 사실·내용·수치를 빠짐없이 담아 가능한 한 길고 상세하게 작성하세요.\n- 짧게 쓰지 마세요. 전문 기사 수준으로 풍부하게 작성하세요.\n- 가이드가 있으면 그 방향에 맞게 작성하세요.\n- 섹션 제목·번호를 본문에 포함하지 마세요.\n- 본문 내용만 출력하세요. 제목, 설명, 머리말 없이 바로 시작.`
      }]
    });
    const aiContent = msg.content[0].text.trim();
    await pool.query(
      `INSERT INTO issue_sections (issue_id, section_no, guide, ai_content, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (issue_id, section_no) DO UPDATE SET guide=$3, ai_content=$4, updated_at=NOW()`,
      [issueId, sectionNo, guide || '', aiContent]
    );
    return resp(200, { ai_content: aiContent });
  } catch (e) { console.error(e); return resp(500, { error: e.message || 'AI 작성 실패' }); }
}

async function saveArticleStyle(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { article_style } = getBody(event);
  try {
    await pool.query('UPDATE users SET article_style=$1 WHERE id=$2', [article_style || '', user.id]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function autoFillSections(event, issueId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const body = getBody(event);
  const { relatedItems } = body;
  try {
    const [ir, labelR, guideR] = await Promise.all([
      pool.query('SELECT title, category, reference_links FROM issues WHERE id=$1', [issueId]),
      pool.query('SELECT section_no, label FROM user_section_labels WHERE user_id=$1 ORDER BY section_no', [user.id]),
      pool.query('SELECT section_no, guide FROM user_section_guides WHERE user_id=$1 ORDER BY section_no', [user.id]),
    ]);
    if (!ir.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    const { title, category, reference_links } = ir.rows[0];

    const DEFAULT_LABELS = ['배경 / 발단', '주요 내용', '인터뷰 / 현장', '관련 자료', '결론 / 전망'];
    const userLabels = [1,2,3,4,5].map(n => {
      const f = labelR.rows.find(r => r.section_no === n);
      return f?.label?.trim() || '';
    });
    const userGuides = [1,2,3,4,5].map(n => {
      const f = guideR.rows.find(r => r.section_no === n);
      return f?.guide?.trim() || '';
    });

    const hasAnyLabel = userLabels.some(l => l);
    const effectiveLabels = userLabels.map((l, i) => l || (hasAnyLabel ? '' : DEFAULT_LABELS[i]));
    const toGenerate = effectiveLabels.map((l, i) => ({ no: i + 1, label: l, guide: userGuides[i] }))
                                      .filter(s => s.label);

    if (!toGenerate.length) return resp(200, { results: [], message: '섹션 제목이 설정되지 않았습니다.' });

    const refs = Array.isArray(reference_links) ? reference_links : [];

    // 참고링크 URL 실제 내용 조회 (병렬, URL당 3초 타임아웃)
    const links     = Array.isArray(body.links) ? body.links : [];
    const linkUrls  = links.map(l => l.url).filter(Boolean);
    const usedLinks = []; // 실제 내용을 가져온 링크만 출처로 기록
    let fetchedContent = '';
    if (linkUrls.length) {
      const withTimeout = url => Promise.race([
        fetchUrl(url),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))
      ]).catch(() => '');
      const fetched = await Promise.allSettled(linkUrls.slice(0, 4).map(withTimeout));
      const parts = [];
      for (let i = 0; i < fetched.length; i++) {
        const f = fetched[i];
        if (f.status === 'fulfilled' && f.value?.length > 200) {
          const text = f.value
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ').trim().slice(0, 1200);
          if (text.length > 100) {
            parts.push(text);
            usedLinks.push({ url: linkUrls[i], title: links[i]?.title || linkUrls[i] });
          }
        }
      }
      fetchedContent = parts.join('\n\n---\n\n');
    }
    // URL 조회 실패했거나 없으면 링크 제목만이라도 출처로 기록
    if (!usedLinks.length && links.length) {
      links.slice(0, 4).forEach(l => usedLinks.push({ url: l.url, title: l.title || l.url }));
    }

    // 현재 참고링크 목록 제목 (URL 조회 실패 시 보조 컨텍스트)
    const linkTitles = links.slice(0, 10).map((l, idx) => `${idx + 1}. ${l.title}`).join('\n');
    if (!fetchedContent && !linkTitles.trim()) {
      return resp(200, { results: [], message: '참고할 내용이 없습니다. 참고링크를 먼저 추가하세요.' });
    }
    // 참고자료 본문 + 제목 목록 합산
    const fullContext = fetchedContent
      ? `${fetchedContent}\n\n[참고 기사 목록]\n${linkTitles}`
      : linkTitles;

    const sectionSpecs = toGenerate.map(s =>
      `[${s.no}]${s.guide ? ` (${s.guide})` : ''}`
    ).join('\n');

    const batchMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 6000,
      messages: [{
        role: 'user',
        content: `기사 제목: ${title}

[참고자료 — 아래 내용을 최우선으로 활용해 각 섹션을 채워주세요]
${fullContext}

규칙:
- 위 참고자료에 있는 사실·내용·수치·인용·배경 등을 빠짐없이 최대한 담아서 작성하세요
- 참고자료에 없는 내용은 추가하지 마세요
- 섹션 번호·제목은 본문에 포함하지 마세요
- 각 섹션을 가능한 한 길고 상세하게, 전문 기사 수준으로 작성하세요 (짧게 쓰지 마세요)

${sectionSpecs}

출력:
[1]
내용

[2]
내용`
      }]
    });

    const batchText = batchMsg.content[0].text;
    const results = [];
    for (const s of toGenerate) {
      const m = batchText.match(new RegExp(`\\[${s.no}\\]([\\s\\S]*?)(?=\\[\\d+\\]|$)`));
      const content = m ? m[1].trim() : '';
      try {
        await pool.query(
          `INSERT INTO issue_sections (issue_id, section_no, content, label, updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, label=$4, updated_at=NOW()`,
          [issueId, s.no, content, s.label]
        );
      } catch {}
      results.push({ no: s.no, content, label: s.label, sources: usedLinks });
    }
    return resp(200, { results });
  } catch (e) { console.error(e); return resp(500, { error: e.message || '섹션 자동작성 실패' }); }
}

async function saveSectionLabelOne(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { section_no, label } = getBody(event);
  if (!section_no || section_no < 1 || section_no > 5) return resp(400, { error: '잘못된 섹션 번호' });
  try {
    await pool.query(
      `INSERT INTO user_section_labels (user_id, section_no, label, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id, section_no) DO UPDATE SET label=$3, updated_at=NOW()`,
      [user.id, section_no, label || '']
    );
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getSectionLabels(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query(
      'SELECT section_no, label FROM user_section_labels WHERE user_id=$1 ORDER BY section_no',
      [user.id]
    );
    const labels = [1,2,3,4,5].map(n => {
      const f = r.rows.find(row => row.section_no === n);
      return f ? f.label : '';
    });
    return resp(200, { labels });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getSectionGuides(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query(
      'SELECT section_no, guide FROM user_section_guides WHERE user_id=$1 ORDER BY section_no',
      [user.id]
    );
    const guides = [1,2,3,4,5].map(n => {
      const f = r.rows.find(row => row.section_no === n);
      return f ? f.guide : '';
    });
    return resp(200, { guides });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function saveSectionGuide(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { section_no, guide } = getBody(event);
  if (!section_no || section_no < 1 || section_no > 5) return resp(400, { error: '잘못된 섹션 번호' });
  try {
    await pool.query(
      `INSERT INTO user_section_guides (user_id, section_no, guide, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id, section_no) DO UPDATE SET guide=$3, updated_at=NOW()`,
      [user.id, section_no, guide || '']
    );
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getBookmarks(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const folders = await pool.query(
      'SELECT id, name, created_at FROM link_folders WHERE user_id=$1 ORDER BY created_at ASC', [user.id]
    );
    const links = await pool.query(
      'SELECT id, folder_id, title, url, created_at FROM link_bookmarks WHERE user_id=$1 ORDER BY created_at ASC', [user.id]
    );
    const result = folders.rows.map(f => ({
      ...f,
      links: links.rows.filter(l => l.folder_id === f.id),
    }));
    return resp(200, { folders: result });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function createFolder(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { name } = getBody(event);
  if (!name?.trim()) return resp(400, { error: '폴더 이름을 입력하세요.' });
  try {
    const r = await pool.query(
      'INSERT INTO link_folders (user_id, name) VALUES($1,$2) RETURNING id, name, created_at',
      [user.id, name.trim()]
    );
    return resp(201, { folder: { ...r.rows[0], links: [] } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function deleteFolder(event, folderId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query('SELECT user_id FROM link_folders WHERE id=$1', [folderId]);
    if (!r.rows.length) return resp(404, { error: '폴더를 찾을 수 없습니다.' });
    if (r.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });
    await pool.query('DELETE FROM link_folders WHERE id=$1', [folderId]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function addLink(event, folderId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { url, title } = getBody(event);
  if (!url?.trim()) return resp(400, { error: 'URL을 입력하세요.' });
  try {
    const f = await pool.query('SELECT user_id FROM link_folders WHERE id=$1', [folderId]);
    if (!f.rows.length) return resp(404, { error: '폴더를 찾을 수 없습니다.' });
    if (f.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });
    const r = await pool.query(
      'INSERT INTO link_bookmarks (folder_id, user_id, title, url) VALUES($1,$2,$3,$4) RETURNING id, folder_id, title, url, created_at',
      [folderId, user.id, title?.trim() || '', url.trim()]
    );
    return resp(201, { link: r.rows[0] });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function deleteLink(event, linkId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query('SELECT user_id FROM link_bookmarks WHERE id=$1', [linkId]);
    if (!r.rows.length) return resp(404, { error: '링크를 찾을 수 없습니다.' });
    if (r.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });
    await pool.query('DELETE FROM link_bookmarks WHERE id=$1', [linkId]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function aiTopicFromUrl(event, user, pageUrl, category) {
  // 1. 페이지 내용 + 링크 추출
  let html = '';
  try { html = await Promise.race([fetchUrl(pageUrl), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))]); } catch {}

  const pageText  = html ? extractPageText(html) : '';
  const pageLinks = html ? extractPageLinks(html, pageUrl) : [];

  if (!pageText && !pageLinks.length) {
    return resp(422, { error: '해당 URL에서 내용을 가져오지 못했습니다. 다른 URL을 시도해보세요.' });
  }

  const contextSnippet = pageText || pageLinks.slice(0, 6).map(l => l.title).join('\n');

  // 2. Haiku로 분류에 맞는 기사 제목 생성
  let finalTitle = '';
  try {
    const titleMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 100,
      messages: [{ role: 'user', content: `아래 웹페이지 내용을 바탕으로 [${category}] 분야에 특징 있는 기사 제목을 한 줄로 작성하세요. 제목만 출력.\n\n내용:\n${contextSnippet}` }]
    });
    finalTitle = titleMsg.content[0].text.trim().split('\n')[0];
    const isFail = /완전하지|부족|실패|없습니다|찾지 못|불가능|어렵습니다|모르겠/.test(finalTitle);
    if (!finalTitle || isFail) return resp(422, { error: '제목을 생성하지 못했습니다. 다른 URL을 시도해보세요.' });
  } catch (e) { return resp(500, { error: '제목 생성 실패' }); }

  // 3. 제목 키워드로 Google News RSS 최신글 추가 검색
  let googleLinks = [];
  try {
    const kwMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 40,
      messages: [{ role: 'user', content: `기사 제목에서 핵심 명사 4개만 추출. 띄어쓰기로만 구분.\n제목: ${finalTitle}` }]
    });
    const keywords = kwMsg.content[0].text.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
    const rss = await fetchUrl(`https://news.google.com/rss/search?q=${encodeURIComponent(keywords)}&hl=ko&gl=KR&ceid=KR:ko`);
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let im;
    while ((im = itemRe.exec(rss)) !== null && googleLinks.length < 15) {
      const xml = im[1];
      const tM  = xml.match(/<title>([\s\S]*?)<\/title>/);
      const lM  = xml.match(/<link>([\s\S]*?)<\/link>/) || xml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      const dM  = xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (!tM) continue;
      const t = tM[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();
      const l = lM ? lM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      const d = dM ? dM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      if (t && l && /^https?:\/\//i.test(l) && !t.toLowerCase().includes('google'))
        googleLinks.push({ title: t, url: l, pubDate: d });
    }
    googleLinks.sort((a, b) => (b.pubDate ? new Date(b.pubDate) : 0) - (a.pubDate ? new Date(a.pubDate) : 0));
  } catch {}

  // 4. 참고링크 = 구글뉴스 최신글만 (입력 페이지 링크와 별개 소스)
  //    입력 페이지 내용은 섹션 자동채우기에만 사용, 참고링크에는 포함 안 함
  const refLinks = googleLinks.slice(0, 25);

  // 5. 이슈 저장
  let r;
  try {
    r = await pool.query(
      'INSERT INTO issues (user_id,title,category,is_draft,reference_links) VALUES($1,$2,$3,TRUE,$4) RETURNING id,title,category,created_at',
      [user.id, finalTitle, category, JSON.stringify(refLinks)]
    );
  } catch {
    r = await pool.query(
      'INSERT INTO issues (user_id,title,category,is_draft) VALUES($1,$2,$3,TRUE) RETURNING id,title,category,created_at',
      [user.id, finalTitle, category]
    );
  }
  const issueId = r.rows[0].id;

  // 6. 섹션 자동채우기 (Haiku, 최대 3섹션)
  try {
    const [labelR, guideR] = await Promise.all([
      pool.query('SELECT section_no, label FROM user_section_labels WHERE user_id=$1 ORDER BY section_no', [user.id]),
      pool.query('SELECT section_no, guide FROM user_section_guides WHERE user_id=$1 ORDER BY section_no', [user.id]),
    ]);
    const DEFAULT_LABELS = ['배경 / 발단', '주요 내용', '인터뷰 / 현장', '관련 자료', '결론 / 전망'];
    const userLabels = [1,2,3,4,5].map(n => {
      const f = labelR.rows.find(row => row.section_no === n);
      return f?.label?.trim() || '';
    });
    const userGuides = [1,2,3,4,5].map(n => {
      const f = guideR.rows.find(row => row.section_no === n);
      return f?.guide?.trim() || '';
    });
    const hasAnyLabel = userLabels.some(l => l);
    const effectiveLabels = userLabels.map((l, i) => l || (hasAnyLabel ? '' : DEFAULT_LABELS[i]));
    const toGenerate = effectiveLabels
      .map((l, i) => ({ no: i + 1, label: l, guide: userGuides[i] }))
      .filter(s => s.label)
      .slice(0, 3);

    if (toGenerate.length) {
      const sectionSpecs = toGenerate.map(s => `[${s.no}]${s.guide ? ` (${s.guide})` : ''}`).join('\n');
      const batchMsg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 4000,
        messages: [{ role: 'user', content: `기사 제목: ${finalTitle}\n\n[참고자료 — 이 내용을 최우선으로 활용]\n${contextSnippet}\n\n규칙: 참고자료의 사실·내용·수치를 빠짐없이 담아 각 섹션을 가능한 한 길고 상세하게 작성. 짧게 쓰지 마세요. 섹션 번호·제목 포함하지 마세요.\n\n${sectionSpecs}\n\n출력:\n[1]\n내용\n\n[2]\n내용` }]
      });
      const batchText = batchMsg.content[0].text;
      for (const s of toGenerate) {
        const m = batchText.match(new RegExp(`\[${s.no}\]([\s\S]*?)(?=\[\d+\]|$)`));
        const content = m ? m[1].trim() : '';
        if (content) {
          try {
            await pool.query(
              `INSERT INTO issue_sections (issue_id, section_no, content, updated_at)
               VALUES ($1,$2,$3,NOW())
               ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, updated_at=NOW()`,
              [issueId, s.no, content]
            );
          } catch {}
        }
      }
    }
  } catch (e) { console.error('URL 섹션 자동채우기 오류:', e.message); }

  return resp(201, { issue: { ...r.rows[0], author: user.name, user_id: user.id } });
}

// ============================================================
// [웹소설] 함수들
// ============================================================

async function getNovels(event) {
  const user  = verifyToken(event);
  const qs    = event.queryStringParameters || {};
  const q     = (qs.q      || '').trim();
  const author = (qs.author || '').trim();
  const date  = (qs.date   || '').trim();
  const mine  = qs.mine  === '1' && !!user;
  const draft = qs.draft === '1' && !!user;
  const page  = Math.max(1, parseInt(qs.page) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;

  try {
    const conds = [];
    const params = [];
    let idx = 1;

    if (mine) {
      conds.push(`n.user_id = $${idx}`); params.push(user.id); idx++;
    } else if (user) {
      conds.push(`(n.is_published = true OR n.user_id = $${idx})`);
      params.push(user.id); idx++;
    } else {
      conds.push('n.is_published = true');
    }

    if (draft && user) conds.push('n.is_published = false');
    if (q)      { conds.push(`n.title ILIKE $${idx++}`); params.push(`%${q}%`); }
    if (author) { conds.push(`u.name  ILIKE $${idx++}`); params.push(`%${author}%`); }
    if (date)   { conds.push(`DATE(n.created_at) = $${idx++}`); params.push(date); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const base  = `FROM novels n JOIN users u ON n.user_id = u.id ${where}`;

    const countR = await pool.query(`SELECT COUNT(*) ${base}`, params);
    const total  = parseInt(countR.rows[0].count);

    const dataR = await pool.query(
      `SELECT n.id, n.title, n.is_published, n.view_count, n.created_at, u.name AS author, n.user_id,
        COALESCE((SELECT SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END) FROM novel_reactions WHERE novel_id=n.id),0)::int AS likes,
        COALESCE((SELECT SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END) FROM novel_reactions WHERE novel_id=n.id),0)::int AS dislikes,
        COALESCE((SELECT COUNT(*) FROM novel_comments WHERE novel_id=n.id),0)::int AS comment_count
       ${base} ORDER BY n.created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );

    return resp(200, { novels: dataR.rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function createNovel(event) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { title } = getBody(event);
  if (!title?.trim()) return resp(400, { error: '제목을 입력하세요.' });
  try {
    const r = await pool.query(
      'INSERT INTO novels (user_id,title,is_published) VALUES($1,$2,FALSE) RETURNING id,title,created_at',
      [user.id, title.trim()]
    );
    return resp(201, { novel: { ...r.rows[0], author: user.name, user_id: user.id } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getNovel(event, id) {
  const user = verifyToken(event);
  try {
    const nr = await pool.query(
      'SELECT n.*, u.name AS author FROM novels n JOIN users u ON n.user_id=u.id WHERE n.id=$1', [id]
    );
    if (!nr.rows.length) return resp(404, { error: '소설을 찾을 수 없습니다.' });
    const novel = nr.rows[0];

    if (!novel.is_published) {
      if (!user) return resp(403, { error: '로그인이 필요합니다.' });
      if (novel.user_id !== user.id) return resp(403, { error: '조회 권한이 없습니다.' });
    }

    if (user) {
      const dup = await pool.query(
        'INSERT INTO novel_views (novel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [id, user.id]
      );
      if (dup.rowCount > 0) {
        await pool.query('UPDATE novels SET view_count = view_count + 1 WHERE id=$1', [id]);
      }
    }

    const er = await pool.query(
      'SELECT episode_no, content FROM novel_episodes WHERE novel_id=$1 ORDER BY episode_no', [id]
    );

    let reactions = { likes: 0, dislikes: 0, my_reaction: null };
    try {
      const rr = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
          COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
          MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
        FROM novel_reactions WHERE novel_id=$2
      `, [user?.id || -1, id]);
      reactions = rr.rows[0];
    } catch {}

    return resp(200, { novel: { ...novel, ...reactions }, episodes: er.rows });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function updateNovel(event, id) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { title, is_published } = getBody(event);
  if (title !== undefined && !title?.trim()) return resp(400, { error: '제목을 입력하세요.' });
  try {
    const check = await pool.query('SELECT user_id FROM novels WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '소설을 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '수정 권한이 없습니다.' });
    const sets = []; const vals = []; let i = 1;
    if (title        !== undefined) { sets.push(`title=$${i++}`);        vals.push(title.trim()); }
    if (is_published !== undefined) { sets.push(`is_published=$${i++}`); vals.push(is_published); }
    sets.push('updated_at=NOW()');
    vals.push(id);
    await pool.query(`UPDATE novels SET ${sets.join(',')} WHERE id=$${i}`, vals);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function deleteNovel(event, id) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const check = await pool.query('SELECT user_id FROM novels WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '소설을 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '삭제 권한이 없습니다.' });
    await pool.query('DELETE FROM novels WHERE id=$1', [id]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function saveEpisodes(event, novelId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { episodes, is_published, novel_content } = getBody(event);
  if (!Array.isArray(episodes)) return resp(400, { error: '문단 데이터가 올바르지 않습니다.' });
  try {
    const check = await pool.query('SELECT user_id FROM novels WHERE id=$1', [novelId]);
    if (!check.rows.length) return resp(404, { error: '소설을 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '수정 권한이 없습니다.' });

    await pool.query('DELETE FROM novel_episodes WHERE novel_id=$1', [novelId]);
    for (const ep of episodes) {
      await pool.query(
        'INSERT INTO novel_episodes (novel_id, episode_no, content, is_draft) VALUES ($1,$2,$3,$4)',
        [novelId, ep.no, ep.content || '', !is_published]
      );
    }

    const pub = is_published !== undefined ? is_published : false;
    await pool.query(
      'UPDATE novels SET is_published=$1, synopsis=$2, updated_at=NOW() WHERE id=$3',
      [pub, novel_content ?? '', novelId]
    );
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function reactNovel(event, novelId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { reaction } = getBody(event);
  if (!['like', 'dislike'].includes(reaction)) return resp(400, { error: '잘못된 요청' });
  try {
    const cur = await pool.query(
      'SELECT reaction FROM novel_reactions WHERE novel_id=$1 AND user_id=$2', [novelId, user.id]
    );
    if (cur.rows.length && cur.rows[0].reaction === reaction) {
      await pool.query('DELETE FROM novel_reactions WHERE novel_id=$1 AND user_id=$2', [novelId, user.id]);
    } else {
      await pool.query(
        `INSERT INTO novel_reactions (novel_id, user_id, reaction) VALUES($1,$2,$3)
         ON CONFLICT (novel_id, user_id) DO UPDATE SET reaction=$3`,
        [novelId, user.id, reaction]
      );
    }
    const c = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
      FROM novel_reactions WHERE novel_id=$2
    `, [user.id, novelId]);
    return resp(200, c.rows[0]);
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getNovelComments(event, novelId) {
  const user = verifyToken(event);
  const uid  = user?.id || -1;
  try {
    const r = await pool.query(`
      SELECT c.id, c.content, c.created_at, u.name AS author, c.user_id,
        COALESCE(SUM(CASE WHEN cr.reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN cr.reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN cr.user_id=$1 THEN cr.reaction END) AS my_reaction
      FROM novel_comments c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN novel_comment_reactions cr ON cr.comment_id = c.id
      WHERE c.novel_id = $2
      GROUP BY c.id, u.name, c.user_id
      ORDER BY c.created_at ASC
    `, [uid, novelId]);
    return resp(200, { comments: r.rows });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function createNovelComment(event, novelId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { content } = getBody(event);
  if (!content?.trim()) return resp(400, { error: '내용을 입력하세요.' });
  try {
    const r = await pool.query(
      'INSERT INTO novel_comments (novel_id, user_id, content) VALUES($1,$2,$3) RETURNING id, content, created_at',
      [novelId, user.id, content.trim()]
    );
    return resp(201, { comment: { ...r.rows[0], author: user.name, user_id: user.id, likes: 0, dislikes: 0, my_reaction: null } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function deleteNovelComment(event, commentId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query('SELECT user_id FROM novel_comments WHERE id=$1', [commentId]);
    if (!r.rows.length) return resp(404, { error: '댓글을 찾을 수 없습니다.' });
    if (r.rows[0].user_id !== user.id) return resp(403, { error: '삭제 권한이 없습니다.' });
    await pool.query('DELETE FROM novel_comments WHERE id=$1', [commentId]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function reactNovelComment(event, commentId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { reaction } = getBody(event);
  if (!['like', 'dislike'].includes(reaction)) return resp(400, { error: '잘못된 요청' });
  try {
    const cur = await pool.query(
      'SELECT reaction FROM novel_comment_reactions WHERE comment_id=$1 AND user_id=$2', [commentId, user.id]
    );
    if (cur.rows.length && cur.rows[0].reaction === reaction) {
      await pool.query('DELETE FROM novel_comment_reactions WHERE comment_id=$1 AND user_id=$2', [commentId, user.id]);
    } else {
      await pool.query(
        `INSERT INTO novel_comment_reactions (comment_id, user_id, reaction) VALUES($1,$2,$3)
         ON CONFLICT (comment_id, user_id) DO UPDATE SET reaction=$3`,
        [commentId, user.id, reaction]
      );
    }
    const c = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
      FROM novel_comment_reactions WHERE comment_id=$2
    `, [user.id, commentId]);
    return resp(200, c.rows[0]);
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

// ────────────────────────────────────────────
// [웹소설] 메뉴 노드 CRUD
// ────────────────────────────────────────────
async function getNovelNodes(event, novelId) {
  const user = verifyToken(event);
  try {
    const check = await pool.query('SELECT user_id FROM novels WHERE id=$1', [novelId]);
    if (!check.rows.length) return resp(404, { error: '소설을 찾을 수 없습니다.' });
    const isOwner = user && check.rows[0].user_id === user.id;
    const r = await pool.query(
      isOwner
        ? 'SELECT id, novel_id, parent_id, position, title, content, ai_content, node_ref, is_visible, updated_at FROM novel_nodes WHERE novel_id=$1 ORDER BY position, id'
        : 'SELECT id, novel_id, parent_id, position, title, content, node_ref, is_visible, updated_at FROM novel_nodes WHERE novel_id=$1 AND is_visible=true ORDER BY position, id',
      [novelId]
    );
    return resp(200, { nodes: r.rows, is_owner: isOwner });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function createNovelNode(event, novelId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { parent_id, title } = getBody(event);
  try {
    const check = await pool.query('SELECT user_id FROM novels WHERE id=$1', [novelId]);
    if (!check.rows.length) return resp(404, { error: '소설을 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });

    const posR = await pool.query(
      'SELECT COALESCE(MAX(position),0)+1 AS nxt FROM novel_nodes WHERE novel_id=$1 AND parent_id IS NOT DISTINCT FROM $2',
      [novelId, parent_id ?? null]
    );
    const pos = posR.rows[0].nxt;

    const r = await pool.query(
      'INSERT INTO novel_nodes (novel_id, parent_id, position, title) VALUES($1,$2,$3,$4) RETURNING *',
      [novelId, parent_id ?? null, pos, (title || '새 메뉴').trim()]
    );
    return resp(201, { node: r.rows[0] });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function updateNovelNode(event, nodeId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const body = getBody(event);
  try {
    const cur = await pool.query(
      'SELECT nn.*, n.user_id FROM novel_nodes nn JOIN novels n ON nn.novel_id=n.id WHERE nn.id=$1', [nodeId]
    );
    if (!cur.rows.length) return resp(404, { error: '노드를 찾을 수 없습니다.' });
    if (cur.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });

    const sets = []; const vals = []; let i = 1;
    if (body.title      !== undefined) { sets.push(`title=$${i++}`);      vals.push(body.title); }
    if (body.content    !== undefined) { sets.push(`content=$${i++}`);    vals.push(body.content); }
    if (body.position   !== undefined) { sets.push(`position=$${i++}`);   vals.push(body.position); }
    if (body.parent_id  !== undefined) { sets.push(`parent_id=$${i++}`);  vals.push(body.parent_id); }
    if (body.is_visible !== undefined) { sets.push(`is_visible=$${i++}`); vals.push(body.is_visible); }
    sets.push('updated_at=NOW()');
    vals.push(nodeId);

    const r = await pool.query(
      `UPDATE novel_nodes SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    return resp(200, { node: r.rows[0] });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function deleteNovelNode(event, nodeId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const cur = await pool.query(
      'SELECT nn.id, n.user_id FROM novel_nodes nn JOIN novels n ON nn.novel_id=n.id WHERE nn.id=$1', [nodeId]
    );
    if (!cur.rows.length) return resp(404, { error: '노드를 찾을 수 없습니다.' });
    if (cur.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });
    await pool.query('DELETE FROM novel_nodes WHERE id=$1', [nodeId]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

// ────────────────────────────────────────────
// [웹소설] 기준정보 / AI 다듬기
// ────────────────────────────────────────────
async function getRefInfo(event, novelId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query(
      'SELECT ref_info, ref_summary FROM novels WHERE id=$1 AND user_id=$2', [novelId, user.id]
    );
    if (!r.rows.length) return resp(404, { error: '소설을 찾을 수 없습니다.' });
    return resp(200, { ref_info: r.rows[0].ref_info || {}, ref_summary: r.rows[0].ref_summary || '' });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function saveRefInfo(event, novelId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { characters, tech, plot, goals, style, files } = getBody(event);
  try {
    const check = await pool.query('SELECT id FROM novels WHERE id=$1 AND user_id=$2', [novelId, user.id]);
    if (!check.rows.length) return resp(404, { error: '소설을 찾을 수 없습니다.' });

    const refInfo = { characters, tech, plot, goals, style, files };
    const parts = [];
    if (characters) parts.push(`[인물 정보]\n${characters}`);
    if (tech)       parts.push(`[기술/세계관]\n${tech}`);
    if (plot)       parts.push(`[주요 내용]\n${plot}`);
    if (goals)      parts.push(`[목표/방향]\n${goals}`);
    if (style)      parts.push(`[작성 스타일]\n${style}`);
    if (Array.isArray(files)) {
      files.forEach(f => {
        const preview = (f.content || '').slice(0, 1500);
        if (preview) parts.push(`[참고 파일: ${f.name}]\n${preview}`);
      });
    }

    let summary = '';
    if (parts.length) {
      const sm = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 800,
        messages: [{ role: 'user', content: `다음 소설 기준정보를 AI가 글 작성 시 참고할 수 있게 핵심만 간결히 요약하세요. 요약만 출력.\n\n${parts.join('\n\n')}` }]
      });
      summary = sm.content[0].text.trim();
    }

    await pool.query(
      'UPDATE novels SET ref_info=$1, ref_summary=$2, updated_at=NOW() WHERE id=$3',
      [JSON.stringify(refInfo), summary, novelId]
    );
    return resp(200, { summary });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function polishNodeContent(event, nodeId) {
  const user = verifyToken(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { guide, content: reqContent } = getBody(event);
  try {
    const nr = await pool.query(
      'SELECT nn.content, n.user_id, n.ref_summary FROM novel_nodes nn JOIN novels n ON nn.novel_id=n.id WHERE nn.id=$1',
      [nodeId]
    );
    if (!nr.rows.length) return resp(404, { error: '노드를 찾을 수 없습니다.' });
    if (nr.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });

    const content = reqContent?.trim() || nr.rows[0].content?.trim();
    const { ref_summary } = nr.rows[0];
    if (!content) return resp(400, { error: '내용이 없습니다.' });

    const systemTxt = ref_summary
      ? `당신은 전문 웹소설 작가입니다.\n\n[소설 기준정보]\n${ref_summary}`
      : '당신은 전문 웹소설 작가입니다.';
    const guideNote = guide ? `\n가이드: ${guide}` : '';
    const userTxt   = `다음 글을 웹소설 작가답게 자연스럽게 다듬어주세요.${guideNote}\n다듬은 글만 출력하세요.\n\n[원문]\n${content}`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4000,
      system: systemTxt,
      messages: [{ role: 'user', content: userTxt }]
    });
    return resp(200, { content: msg.content[0].text.trim() });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}
