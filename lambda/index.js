/**
 * 통합 백엔드 — /workKit · /pgo 전부 이 Lambda 하나가 처리한다.
 *
 * DB 는 article 운영방식 그대로 비밀번호 인증이다. 예전 workKit Lambda 는
 * RDS IAM 토큰(@aws-sdk/rds-signer)으로 별도 DB 에 붙었는데, 저장소 밖에서
 * 수동 배포되던 것이라 스토리지가 갈라져 있었다. 이제 article-writer-db 하나만 쓴다.
 *
 * 필요한 환경변수
 *   DB_HOST DB_NAME DB_USER DB_PASSWORD [DB_PORT]  — 필수
 *   JWT_SECRET ANTHROPIC_API_KEY                   — 필수
 *   S3_BUCKET                                      — 동영상 제작(파일 업로드)에만 필요
 *   GMAIL_USER GMAIL_PASS FRONTEND_URL             — 이메일 인증/비밀번호 재발급에만 필요
 */
const { Client, Pool } = require('pg');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');
const XLSX_LIB  = require('xlsx');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');
const pgo = require('./pgo');

const DB_CONFIG = {
  host:     process.env.DB_HOST,
  database: process.env.DB_NAME || 'postgres',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port:     Number(process.env.DB_PORT) || 5432,
  ssl:      { rejectUnauthorized: false },
};

// pgo 모듈과 article 유래 라우트는 풀을 쓰고, workKit 유래 핸들러는
// 요청마다 Client 를 열고 닫는다(원래 구현 그대로 두기 위해서다).
const pool = new Pool(DB_CONFIG);
async function getClient() {
  const client = new Client(DB_CONFIG);
  await client.connect();
  return client;
}

const REGION = 'ap-southeast-2';
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const API_BASE = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,GET,PUT,DELETE,OPTIONS',
};

function validatePassword(pw) {
  if (!pw || pw.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (!/[A-Z]/.test(pw)) return '대문자를 1자 이상 포함해야 합니다.';
  if (!/[a-z]/.test(pw)) return '소문자를 1자 이상 포함해야 합니다.';
  if (!/[0-9]/.test(pw)) return '숫자를 1자 이상 포함해야 합니다.';
  if (!/[!@#$%^&*()_+\-=\[\]{}|;':",.<>?/`~]/.test(pw)) return '특수문자를 1자 이상 포함해야 합니다.';
  return null;
}

function makeToken(user) {
  return jwt.sign({ userId: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

async function logAccess(client, userId, email, method, ip) {
  try {
    await client.query(
      'INSERT INTO access_logs (user_id, email, login_method, ip_address) VALUES ($1, $2, $3, $4)',
      [userId, email, method, ip || null]
    );
  } catch (e) { console.error('access log error:', e.message); }
}

async function findOrCreateOAuthUser(client, { email, name, provider, providerId }) {
  const { rows } = await client.query('SELECT * FROM users WHERE email = $1', [email]);
  if (rows.length > 0) return rows[0];
  const result = await client.query(
    'INSERT INTO users (email, name, provider, provider_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [email, name || '', provider, providerId]
  );
  return result.rows[0];
}

// ── Password Reset / Change ─────────────────────────────────
function _generateTempPw() {
  const U='ABCDEFGHJKLMNPQRSTUVWXYZ', L='abcdefghjkmnpqrstuvwxyz', N='23456789', S='!@#$%';
  const all = U+L+N+S;
  let pw = U[Math.floor(Math.random()*U.length)] + L[Math.floor(Math.random()*L.length)]
         + N[Math.floor(Math.random()*N.length)] + S[Math.floor(Math.random()*S.length)];
  for (let i=4; i<10; i++) pw += all[Math.floor(Math.random()*all.length)];
  return pw.split('').sort(()=>Math.random()-0.5).join('');
}

async function forgotPassword(body) {
  const { email } = body;
  if (!email) return { statusCode:400, body:{ error:'이메일을 입력하세요.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query("SELECT id FROM users WHERE email=$1 AND provider='email'", [email]);
    if (!rows.length) return { statusCode:404, body:{ error:'등록된 이메일이 아닙니다.' } };
  } finally { await client.end(); }

  const GMAIL_USER = process.env.GMAIL_USER, GMAIL_PASS = process.env.GMAIL_PASS;
  if (!GMAIL_USER || !GMAIL_PASS) return { statusCode:500, body:{ error:'이메일 서비스 설정 오류' } };
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const verifyToken = jwt.sign({ purpose:'pw-reset', email, code }, JWT_SECRET, { expiresIn:'10m' });
  const transporter = nodemailer.createTransport({ service:'gmail', auth:{ user:GMAIL_USER, pass:GMAIL_PASS } });
  await transporter.sendMail({
    from:`"WorkKit" <${GMAIL_USER}>`, to:email,
    subject:'[WorkKit] 비밀번호 재설정 인증 코드',
    html:`<h2>비밀번호 재설정</h2><p>인증코드: <strong style="font-size:24px;letter-spacing:4px">${code}</strong></p><p>10분 후 만료됩니다.</p>`
  });
  return { statusCode:200, body:{ verifyToken } };
}

async function resetPassword(body) {
  const { verifyToken, code } = body;
  if (!verifyToken || !code) return { statusCode:400, body:{ error:'잘못된 요청입니다.' } };
  let email;
  try {
    const decoded = jwt.verify(verifyToken, JWT_SECRET);
    if (decoded.purpose !== 'pw-reset' || decoded.code !== String(code))
      return { statusCode:400, body:{ error:'인증코드가 올바르지 않습니다.' } };
    email = decoded.email;
  } catch { return { statusCode:400, body:{ error:'인증코드가 만료됐거나 올바르지 않습니다.' } }; }

  const tempPw = _generateTempPw();
  const hash   = await bcrypt.hash(tempPw, 10);
  const client = await getClient();
  try {
    const r = await client.query("UPDATE users SET password_hash=$1 WHERE email=$2 AND provider='email' RETURNING id", [hash, email]);
    if (!r.rows.length) return { statusCode:404, body:{ error:'계정을 찾을 수 없습니다.' } };
  } finally { await client.end(); }

  const GMAIL_USER = process.env.GMAIL_USER, GMAIL_PASS = process.env.GMAIL_PASS;
  if (GMAIL_USER && GMAIL_PASS) {
    const transporter = nodemailer.createTransport({ service:'gmail', auth:{ user:GMAIL_USER, pass:GMAIL_PASS } });
    await transporter.sendMail({
      from:`"WorkKit" <${GMAIL_USER}>`, to:email,
      subject:'[WorkKit] 임시 비밀번호 안내',
      html:`<h2>임시 비밀번호</h2><p>임시 비밀번호: <strong style="font-size:20px;letter-spacing:3px;background:#f1f5f9;padding:4px 10px;border-radius:4px">${tempPw}</strong></p><p style="color:#6b7280;font-size:13px">로그인 후 반드시 비밀번호를 변경해주세요.</p>`
    });
  }
  return { statusCode:200, body:{ message:'임시 비밀번호가 이메일로 전송됐습니다.' } };
}

async function changePassword(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode:401, body:{ error:'로그인이 필요합니다.' } };
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) return { statusCode:400, body:{ error:'비밀번호를 입력하세요.' } };
  const pwErr = validatePassword(newPassword);
  if (pwErr) return { statusCode:400, body:{ error:pwErr } };
  const client = await getClient();
  try {
    const { rows } = await client.query("SELECT password_hash FROM users WHERE id=$1 AND provider='email'", [user.userId]);
    if (!rows.length) return { statusCode:404, body:{ error:'계정을 찾을 수 없습니다. (소셜 로그인 계정은 변경 불가)' } };
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return { statusCode:400, body:{ error:'현재 비밀번호가 틀렸습니다.' } };
    const hash = await bcrypt.hash(newPassword, 10);
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.userId]);
    return { statusCode:200, body:{ message:'비밀번호가 변경됐습니다.' } };
  } finally { await client.end(); }
}

// ── Email Verification ──────────────────────────────────────
async function sendVerifyCode(body) {
  const { email } = body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { statusCode: 400, body: { error: '올바른 이메일 형식이 아닙니다.' } };

  const client = await getClient();
  try {
    const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (rows.length > 0) return { statusCode: 409, body: { error: '이미 사용 중인 이메일입니다.' } };
  } finally { await client.end(); }

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_PASS = process.env.GMAIL_PASS;
  if (!GMAIL_USER || !GMAIL_PASS)
    return { statusCode: 500, body: { error: '이메일 발송 설정이 완료되지 않았습니다. (GMAIL_USER, GMAIL_PASS 환경변수 필요)' } };

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const verifyToken = jwt.sign({ purpose: 'email-verify', email, code }, JWT_SECRET, { expiresIn: '10m' });

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  await transporter.sendMail({
    from: `"Excel Tools" <${GMAIL_USER}>`,
    to: email,
    subject: '[Excel Tools] 이메일 인증 코드',
    text: `인증코드: ${code}\n\n이 코드는 10분 후 만료됩니다.`,
    html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto">
      <h2 style="color:#4f46e5">Excel Tools 이메일 인증</h2>
      <p>아래 인증코드를 입력해주세요.</p>
      <div style="font-size:36px;font-weight:700;letter-spacing:10px;padding:20px;background:#f0f9ff;border:2px solid #7dd3fc;border-radius:8px;text-align:center;color:#0369a1">${code}</div>
      <p style="color:#6b7280;font-size:13px;margin-top:16px">이 코드는 <strong>10분</strong> 후 만료됩니다.</p>
    </div>`,
  });

  return { statusCode: 200, body: { verifyToken, message: '인증코드가 전송됐습니다.' } };
}

async function verifyCode(body) {
  const { verifyToken, code } = body;
  if (!verifyToken || !code)
    return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  try {
    const decoded = jwt.verify(verifyToken, JWT_SECRET);
    if (decoded.purpose !== 'email-verify' || decoded.code !== String(code))
      return { statusCode: 400, body: { error: '인증코드가 올바르지 않습니다.' } };
    const verifiedToken = jwt.sign({ purpose: 'email-verified', email: decoded.email }, JWT_SECRET, { expiresIn: '10m' });
    return { statusCode: 200, body: { verifiedToken, message: '인증됐습니다.' } };
  } catch {
    return { statusCode: 400, body: { error: '인증코드가 만료됐거나 올바르지 않습니다.' } };
  }
}

// ── Email/Password ──────────────────────────────────────────
async function checkEmail(body) {
  const { email } = body;
  if (!email) return { statusCode: 400, body: { error: '이메일을 입력하세요.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    return { statusCode: 200, body: { available: rows.length === 0 } };
  } finally { await client.end(); }
}

async function register(body) {
  const { email, password, name, verifiedToken } = body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { statusCode: 400, body: { error: '올바른 이메일 형식이 아닙니다.' } };

  // 이메일 인증 확인
  if (!verifiedToken)
    return { statusCode: 400, body: { error: '이메일 인증이 필요합니다.' } };
  try {
    const decoded = jwt.verify(verifiedToken, JWT_SECRET);
    if (decoded.purpose !== 'email-verified' || decoded.email !== email)
      return { statusCode: 400, body: { error: '이메일 인증 정보가 올바르지 않습니다.' } };
  } catch {
    return { statusCode: 400, body: { error: '이메일 인증이 만료됐습니다. 다시 인증해주세요.' } };
  }

  const pwErr = validatePassword(password);
  if (pwErr) return { statusCode: 400, body: { error: pwErr } };
  const hash = await bcrypt.hash(password, 10);
  const client = await getClient();
  try {
    await client.query(
      'INSERT INTO users (email, password_hash, name, provider) VALUES ($1, $2, $3, $4)',
      [email, hash, name || '', 'email']
    );
    return { statusCode: 201, body: { message: '회원가입 성공' } };
  } catch (e) {
    if (e.code === '23505') return { statusCode: 409, body: { error: '이미 사용 중인 이메일입니다.' } };
    throw e;
  } finally { await client.end(); }
}

async function login(body, ip) {
  const { email, password } = body;
  if (!email || !password) return { statusCode: 400, body: { error: '이메일과 비밀번호를 입력하세요.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query("SELECT * FROM users WHERE email = $1 AND provider = 'email'", [email]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash)))
      return { statusCode: 401, body: { error: '이메일 또는 비밀번호가 틀렸습니다.' } };
    const user = rows[0];
    await logAccess(client, user.id, user.email, 'email', ip);
    const token = makeToken(user);
    return { statusCode: 200, body: { token, user: { id: user.id, email: user.email, name: user.name } } };
  } finally { await client.end(); }
}

// ── JWT Verify ───────────────────────────────────────────────
function verifyToken(event) {
  const auth = (event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!auth) return null;
  try { return jwt.verify(auth, JWT_SECRET); } catch { return null; }
}

// ── User Data Save/Load (공통 – menu_key로 메뉴 구분) ────────
async function saveData(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { menu_key, title, data } = body;
  if (!menu_key) return { statusCode: 400, body: { error: 'menu_key가 없습니다.' } };
  if (!title?.trim()) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };
  const dataStr = JSON.stringify(data);
  if (dataStr.length > 1048576) {
    return { statusCode: 413, body: { error: '저장 데이터가 너무 큽니다. (최대 1MB)' } };
  }
  const client = await getClient();
  try {
    const { rows: lRows } = await client.query(
      `SELECT u.save_limit, COUNT(s.id)::int AS cnt
       FROM users u
       LEFT JOIN user_saves s ON s.user_id = u.id AND s.menu_key = $2
       WHERE u.id = $1
       GROUP BY u.save_limit`,
      [user.userId, menu_key]
    );
    const { save_limit, cnt } = lRows[0] || { save_limit: 5, cnt: 0 };
    if (cnt >= save_limit) {
      return {
        statusCode: 409,
        body: { error: `메뉴당 최대 ${save_limit}개까지 저장할 수 있습니다. 기존 버전을 삭제 후 저장해주세요.`, limitExceeded: true, limit: save_limit },
      };
    }
    const result = await client.query(
      'INSERT INTO user_saves (user_id, menu_key, title, data) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
      [user.userId, menu_key, title.trim(), dataStr]
    );
    return { statusCode: 201, body: { message: '저장되었습니다.', id: result.rows[0].id, created_at: result.rows[0].created_at } };
  } finally { await client.end(); }
}

async function listData(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { menu_key } = body;
  if (!menu_key) return { statusCode: 400, body: { error: 'menu_key가 없습니다.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query(
      `SELECT us.id, us.title, us.created_at, us.updated_at, false AS is_collab, NULL AS owner_name
         FROM user_saves us WHERE us.user_id = $1 AND us.menu_key = $2
       UNION ALL
       SELECT us.id, us.title, us.created_at, us.updated_at, true AS is_collab, u.name AS owner_name
         FROM schedule_collab_refs scr
         JOIN user_saves us ON us.id = scr.save_id
         JOIN users u ON u.id = us.user_id
         WHERE scr.user_id = $1 AND us.menu_key = $2
       ORDER BY created_at DESC`,
      [user.userId, menu_key]
    );
    return { statusCode: 200, body: { list: rows } };
  } finally { await client.end(); }
}

async function deleteData(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { id } = body;
  if (!id) return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  const client = await getClient();
  try {
    const r = await client.query('DELETE FROM user_saves WHERE id = $1 AND user_id = $2', [id, user.userId]);
    if (r.rowCount === 0) {
      await client.query('DELETE FROM schedule_collab_refs WHERE save_id = $1 AND user_id = $2', [id, user.userId]);
    }
    return { statusCode: 200, body: { message: '삭제되었습니다.' } };
  } finally { await client.end(); }
}

async function loadData(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { id } = body;
  if (!id) return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query(
      `SELECT data FROM user_saves WHERE id = $1
         AND (user_id = $2 OR EXISTS(SELECT 1 FROM schedule_collab_refs WHERE save_id = $1 AND user_id = $2))`,
      [id, user.userId]
    );
    if (!rows.length) return { statusCode: 404, body: { error: '데이터를 찾을 수 없습니다.' } };
    let parsed;
    try { parsed = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data; }
    catch { parsed = {}; }
    return { statusCode: 200, body: { data: parsed } };
  } finally { await client.end(); }
}

async function shareData(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { id } = body;
  if (!id) return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  const token = crypto.randomBytes(16).toString('hex');
  const client = await getClient();
  try {
    const { rows } = await client.query(
      'UPDATE user_saves SET share_token = $1 WHERE id = $2 AND user_id = $3 RETURNING share_token',
      [token, id, user.userId]
    );
    if (!rows.length) return { statusCode: 404, body: { error: '버전을 찾을 수 없습니다.' } };
    return { statusCode: 200, body: { token } };
  } finally { await client.end(); }
}

async function shareNow(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { menu_key, data } = body;
  if (!menu_key) return { statusCode: 400, body: { error: 'menu_key가 없습니다.' } };
  const token = crypto.randomBytes(16).toString('hex');
  const client = await getClient();
  try {
    await client.query(
      `INSERT INTO user_current_shares (user_id, menu_key, data, share_token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, menu_key)
       DO UPDATE SET data = $3, share_token = $4, updated_at = NOW()`,
      [user.userId, menu_key, JSON.stringify(data), token]
    );
    return { statusCode: 200, body: { token } };
  } finally { await client.end(); }
}

async function publicLoad(body) {
  const { token } = body;
  if (!token) return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  const client = await getClient();
  try {
    let { rows } = await client.query(
      'SELECT data FROM user_saves WHERE share_token = $1', [token]
    );
    if (!rows.length) {
      const r2 = await client.query(
        'SELECT data FROM user_current_shares WHERE share_token = $1', [token]
      );
      rows = r2.rows;
    }
    if (!rows.length) return { statusCode: 404, body: { error: '공유 링크를 찾을 수 없습니다.' } };
    let parsed;
    try { parsed = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data; }
    catch { parsed = {}; }
    return { statusCode: 200, body: { data: parsed } };
  } finally { await client.end(); }
}

// ── 일정관리 버전 공유 개편: 수정모드(덮어쓰기)/메타/협업공유 ────
async function updateData(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { id, title, data } = body;
  if (!id) return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  if (!title?.trim()) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };
  const dataStr = JSON.stringify(data);
  if (dataStr.length > 1048576) {
    return { statusCode: 413, body: { error: '저장 데이터가 너무 큽니다. (최대 1MB)' } };
  }
  const client = await getClient();
  try {
    const { rows } = await client.query(
      'UPDATE user_saves SET title = $1, data = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING updated_at',
      [title.trim(), dataStr, id, user.userId]
    );
    if (!rows.length) return { statusCode: 404, body: { error: '버전을 찾을 수 없습니다.' } };
    return { statusCode: 200, body: { message: '저장되었습니다.', updated_at: rows[0].updated_at } };
  } finally { await client.end(); }
}

async function getMeta(body) {
  const { id } = body;
  if (!id) return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query(
      `SELECT us.id, us.title, us.created_at, us.updated_at, us.user_id, u.name AS creator_name
         FROM user_saves us JOIN users u ON u.id = us.user_id
        WHERE us.id = $1`,
      [id]
    );
    if (!rows.length) return { statusCode: 404, body: { error: '버전을 찾을 수 없습니다.' } };
    return { statusCode: 200, body: { meta: rows[0] } };
  } finally { await client.end(); }
}

async function shareCollab(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { id } = body;
  if (!id) return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  const token = crypto.randomBytes(16).toString('hex');
  const client = await getClient();
  try {
    const { rows } = await client.query(
      'UPDATE user_saves SET collab_share_token = $1 WHERE id = $2 AND user_id = $3 RETURNING collab_share_token',
      [token, id, user.userId]
    );
    if (!rows.length) return { statusCode: 404, body: { error: '버전을 찾을 수 없습니다.' } };
    return { statusCode: 200, body: { token } };
  } finally { await client.end(); }
}

async function publicCollabLoad(body) {
  const { token } = body;
  if (!token) return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query(
      `SELECT us.id, us.data, us.title, us.user_id, u.name AS owner_name
         FROM user_saves us JOIN users u ON u.id = us.user_id
        WHERE us.collab_share_token = $1`,
      [token]
    );
    if (!rows.length) return { statusCode: 404, body: { error: '공유 링크를 찾을 수 없습니다.' } };
    const row = rows[0];
    return { statusCode: 200, body: { saveId: row.id, data: row.data, title: row.title, ownerId: row.user_id, ownerName: row.owner_name } };
  } finally { await client.end(); }
}

// 협업 행 병합: 본인(userId) 행은 제출본 기준, 그 외는 최신 원본 기준으로 동시 편집을 보존
function _mergeCollabRows(latestRows, submittedRows, userId) {
  latestRows = latestRows || [];
  submittedRows = submittedRows || [];
  const latestById = new Map(latestRows.map(r => [r.id, r]));
  const usedIds = new Set();
  const merged = [];
  for (const row of submittedRows) {
    if (row.createdBy?.id === userId) {
      merged.push(row);
      usedIds.add(row.id);
    } else if (latestById.has(row.id)) {
      merged.push(latestById.get(row.id));
      usedIds.add(row.id);
    }
  }
  for (const row of latestRows) {
    if (!usedIds.has(row.id)) merged.push(row);
  }
  return merged;
}

async function collabSave(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { token, saveId, data } = body;
  if (!data) return { statusCode: 400, body: { error: '잘못된 요청입니다.' } };
  const client = await getClient();
  try {
    let original;
    if (token) {
      const { rows } = await client.query('SELECT id, data FROM user_saves WHERE collab_share_token = $1', [token]);
      original = rows[0];
    } else if (saveId) {
      const { rows } = await client.query(
        `SELECT us.id, us.data FROM user_saves us
          WHERE us.id = $1
            AND (us.user_id = $2 OR EXISTS(SELECT 1 FROM schedule_collab_refs WHERE save_id = us.id AND user_id = $2))`,
        [saveId, user.userId]
      );
      original = rows[0];
    }
    if (!original) return { statusCode: 404, body: { error: '원본 버전을 찾을 수 없습니다.' } };

    const latest = original.data || {};
    const submitted = data || {};
    const merged = {
      data: _mergeCollabRows(latest.data, submitted.data, user.userId),
      completedData: _mergeCollabRows(latest.completedData, submitted.completedData, user.userId),
      nextId: Math.max(latest.nextId || 1, submitted.nextId || 1),
      activeTab: latest.activeTab || 'plan',
    };

    await client.query('UPDATE user_saves SET data = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(merged), original.id]);
    await client.query(
      'INSERT INTO schedule_collab_refs (save_id, user_id) VALUES ($1, $2) ON CONFLICT (save_id, user_id) DO NOTHING',
      [original.id, user.userId]
    );
    return { statusCode: 200, body: { message: '원본에 저장되었습니다.', data: merged, saveId: original.id } };
  } finally { await client.end(); }
}

// ── 파일 → Claude 블록 변환 (공통) ─────────────────────────
function _fileToBlock(filename, contentType, buf) {
  try {
    const ct = contentType || '';
    if (ct.startsWith('image/'))
      return { type:'image', source:{ type:'base64', media_type:ct, data:buf.toString('base64') } };
    if (ct === 'application/pdf')
      return { type:'document', source:{ type:'base64', media_type:'application/pdf', data:buf.toString('base64') } };
    const fn = (filename || '').toLowerCase();
    if (fn.endsWith('.xlsx') || fn.endsWith('.xls') || ct.includes('spreadsheet') || ct.includes('excel')) {
      try {
        const wb  = XLSX_LIB.read(buf, { type:'buffer' });
        let   txt = `[엑셀: ${filename}]\n`;
        wb.SheetNames.forEach(sn => { txt += `▶ 시트: ${sn}\n${XLSX_LIB.utils.sheet_to_csv(wb.Sheets[sn])}\n`; });
        return { type:'text', text: txt };
      } catch { return { type:'text', text:`[엑셀: ${filename}] (파싱 오류)` }; }
    }
    if (fn.endsWith('.html') || fn.endsWith('.htm') || ct.includes('html')) {
      const raw  = buf.toString('utf8');
      const text = raw.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
                      .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      return { type:'text', text:`[HTML: ${filename}]\n${text}` };
    }
    const pathNote = (filename||'').includes('/') ? ` (경로: ${filename})` : '';
    return { type:'text', text:`[파일: ${filename}]${pathNote}\n${buf.toString('utf8')}` };
  } catch (e) {
    return { type:'text', text:`[파일: ${filename}] 읽기 오류: ${e.message}` };
  }
}

// ── AI Chat ──────────────────────────────────────────────────
async function aiChat(event, body) {
  const user = verifyToken(event);
  const { messages, share_token, file_ids, system_prompt, inline_files } = body;

  if (!user && !share_token) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  if (!Array.isArray(messages) || messages.length === 0)
    return { statusCode: 400, body: { error: '메시지가 없습니다.' } };
  if (!process.env.ANTHROPIC_API_KEY)
    return { statusCode: 500, body: { error: 'AI 서비스가 설정되지 않았습니다.' } };

  let recentMessages = messages.slice(-20).filter(m => m.role && m.content)
    .map(m => ({ role: m.role, content: String(m.content) }));

  let model  = 'claude-haiku-4-5-20251001';
  const allBlocks = []; // 모든 파일 블록 수집

  // 1) DB 저장 파일 (버전에 연결된 파일)
  if (Array.isArray(file_ids) && file_ids.length > 0) {
    const fc = await getClient();
    try {
      const { rows: files } = await fc.query(
        'SELECT filename, content_type, file_data FROM ai_summary_files WHERE id=ANY($1)', [file_ids]);
      files.forEach(f => {
        allBlocks.push(_fileToBlock(f.filename, f.content_type, f.file_data));
      });
    } catch(e) { console.error('DB 파일 조회 오류:', e.message); }
    finally { await fc.end(); }
  }

  // 2) 캐시(pending) 파일 — 아직 저장 전 파일
  if (Array.isArray(inline_files) && inline_files.length > 0) {
    inline_files.forEach(f => {
      try {
        const buf = Buffer.from(f.data, 'base64');
        allBlocks.push(_fileToBlock(f.filename, f.content_type, buf));
      } catch(e) { allBlocks.push({ type:'text', text:`[파일: ${f.filename}] 읽기 오류` }); }
    });
  }

  // 파일이 있으면 Sonnet 사용 + 마지막 user 메시지에 파일 블록 첨부
  if (allBlocks.length > 0) {
    model = 'claude-sonnet-4-6';
    const lastIdx = recentMessages.length - 1;
    const lastMsg = recentMessages[lastIdx];
    if (lastMsg?.role === 'user') {
      allBlocks.push({ type:'text', text: lastMsg.content });
      recentMessages[lastIdx] = { role:'user', content: allBlocks };
    }
  }

  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await ai.messages.create({
    model, max_tokens: 4096,
    ...(system_prompt ? { system: system_prompt } : {}),
    messages: recentMessages,
  });
  const content = response.content?.[0]?.text ?? '';
  return { statusCode: 200, body: { content } };
}

// ── AI Summary ───────────────────────────────────────────────
function _summaryAuth(event, body) {
  const user = verifyToken(event);
  const shareToken = body?.share_token || null;
  return { user, shareToken, isOwner: !!user };
}

async function _ownerIdFromToken(client, shareToken) {
  const { rows } = await client.query(
    'SELECT user_id FROM ai_summaries WHERE share_token = $1 LIMIT 1', [shareToken]);
  return rows[0]?.user_id ?? null;
}

async function summarySave(event, body) {
  const { user, shareToken } = _summaryAuth(event, body);
  const { messages, title, update_id } = body;

  let userId, userEmail, isSharedUser = false, forcedUpdateId = null;

  if (user) {
    userId = user.userId; userEmail = user.email;
    if (!title?.trim()) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };
  } else if (shareToken) {
    // 공유 사용자: 해당 토큰에 연결된 버전만 덮어쓰기 가능, 신규 생성 불가
    const c0 = await getClient();
    try {
      const { rows: sv } = await c0.query(
        'SELECT id, user_id, is_edit_locked FROM ai_summaries WHERE share_token=$1', [shareToken]);
      if (!sv.length) return { statusCode: 403, body: { error: '유효하지 않은 공유 링크입니다.' } };
      if (sv[0].is_edit_locked) return { statusCode: 403, body: { error: '편집이 잠금된 버전입니다.' } };
      forcedUpdateId = sv[0].id;
      userId = sv[0].user_id;
      const { rows: u } = await c0.query('SELECT email FROM users WHERE id=$1', [userId]);
      userEmail = (u[0]?.email ?? '') + ' (공유)';
    } finally { await c0.end(); }
    isSharedUser = true;
  } else {
    return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  }

  if (!process.env.ANTHROPIC_API_KEY) return { statusCode: 500, body: { error: 'AI 설정이 필요합니다.' } };

  // 덮어쓸 버전 ID 결정
  const targetId = isSharedUser ? forcedUpdateId : update_id;

  // 첨부 파일 목록 조회 (프롬프트에 포함)
  let fileNames = [];
  if (targetId) {
    const cf = await getClient();
    try {
      const { rows: files } = await cf.query(
        'SELECT filename FROM ai_summary_files WHERE summary_id=$1 ORDER BY created_at', [targetId]);
      fileNames = files.map(f => f.filename);
    } finally { await cf.end(); }
  }

  // AI 컨텍스트 정리 프롬프트 (과도한 요약 없이 이어서 바로 대화 가능하게)
  const ai   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msgs = Array.isArray(messages) ? messages.slice(-30).filter(m => m.role && m.content) : [];
  const fileSection = fileNames.length
    ? `\n## [첨부 파일]\n${fileNames.map(n => `- ${n}: (이 파일의 핵심 내용·특징 정리)`).join('\n')}`
    : '';
  const instruction = `위 대화 내용을 AI가 다음 대화에서 즉시 이어서 진행할 수 있도록 아래 형식으로 정리해주세요. (한국어)\n\n` +
    `## [사용자 컨텍스트]\n- 목적·배경:\n- 특이사항·선호도:\n\n` +
    `## [주요 논의 내용]\n(핵심 토픽·결정사항·중요 정보를 bullet points로, 충분히 상세하게)\n\n` +
    `## [현재 상태]\n- 마지막 논의 내용:\n- 미결사항·다음 단계:\n\n` +
    `## [AI 필수 기억]\n(반드시 기억해야 할 핵심 정보)` +
    fileSection + `\n\n` +
    `주의: 과도하게 압축하지 말고, AI가 맥락을 즉시 파악하고 이어나갈 수 있도록 필요한 정보를 충분히 포함하세요.`;

  const prompt = msgs.length
    ? [...msgs, { role: 'user', content: instruction }]
    : [{ role: 'user', content: `다음 내용을 AI 컨텍스트 형식으로 정리해주세요:\n${body.content ?? ''}` }];

  const res     = await ai.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 3000, messages: prompt });
  const content = res.content?.[0]?.text ?? '';

  const c = await getClient();
  try {
    // 덮어쓰기 모드
    if (targetId) {
      const { rows: ex } = await c.query('SELECT user_id,is_edit_locked FROM ai_summaries WHERE id=$1', [targetId]);
      if (!ex.length) return { statusCode: 404, body: { error: '버전을 찾을 수 없습니다.' } };
      if (!isSharedUser && ex[0].user_id !== userId) return { statusCode: 403, body: { error: '권한이 없습니다.' } };
      if (ex[0].is_edit_locked) return { statusCode: 403, body: { error: '편집이 잠금된 버전입니다.' } };

      let r;
      if (isSharedUser) {
        // 공유 사용자: 내용만 업데이트, 제목 변경 불가
        r = await c.query('UPDATE ai_summaries SET content=$1,updated_at=NOW() WHERE id=$2 RETURNING id,title', [content, targetId]);
      } else {
        // 소유자: 제목 + 내용 업데이트
        r = await c.query('UPDATE ai_summaries SET title=$1,content=$2,updated_at=NOW() WHERE id=$3 RETURNING id,title', [title.trim(), content, targetId]);
      }
      return { statusCode: 200, body: { id: r.rows[0].id, title: r.rows[0].title, content, updated: true } };
    }

    // 공유 사용자는 신규 생성 불가
    if (isSharedUser) return { statusCode: 403, body: { error: '공유 링크로는 새 버전을 생성할 수 없습니다.' } };

    // 버전 7개 한도
    const { rows: cnt } = await c.query('SELECT COUNT(*) as n FROM ai_summaries WHERE user_id=$1', [userId]);
    if (parseInt(cnt[0].n) >= 7)
      return { statusCode: 409, body: { error: '저장된 버전이 7개입니다. 기존 버전을 삭제 후 저장해주세요.', limitExceeded: true } };

    const r = await c.query(
      'INSERT INTO ai_summaries (user_id,user_email,title,content) VALUES($1,$2,$3,$4) RETURNING id,created_at',
      [userId, userEmail, title.trim(), content]);
    return { statusCode: 201, body: { id: r.rows[0].id, content, created_at: r.rows[0].created_at } };
  } finally { await c.end(); }
}

async function summaryList(event, body) {
  const { user, shareToken } = _summaryAuth(event, body);

  const c = await getClient();
  try {
    if (user) {
      // 소유자: 모든 버전 반환
      const { rows } = await c.query(
        `SELECT s.id, s.title, s.user_email, s.is_edit_locked,
                s.share_token IS NOT NULL AS has_share, s.created_at,
                (SELECT COUNT(*) FROM ai_summary_files f WHERE f.summary_id=s.id) AS file_count
         FROM ai_summaries s WHERE s.user_id=$1 ORDER BY s.created_at DESC`,
        [user.userId]);
      return { statusCode: 200, body: { list: rows, is_owner: true } };
    } else if (shareToken) {
      // 공유 사용자: 해당 토큰에 연결된 버전 하나만 반환
      const { rows } = await c.query(
        `SELECT s.id, s.title, s.user_email, s.is_edit_locked,
                true AS has_share, s.created_at,
                (SELECT COUNT(*) FROM ai_summary_files f WHERE f.summary_id=s.id) AS file_count
         FROM ai_summaries s WHERE s.share_token=$1`,
        [shareToken]);
      if (!rows.length) return { statusCode: 403, body: { error: '유효하지 않은 공유 링크입니다.' } };
      return { statusCode: 200, body: { list: rows, is_owner: false } };
    } else {
      return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
    }
  } finally { await c.end(); }
}

async function summaryGet(event, body) {
  const { user, shareToken } = _summaryAuth(event, body);
  const { id, by_token } = body;
  const c = await getClient();
  try {

    let rows;
    if (by_token && shareToken) {
      ({ rows } = await c.query('SELECT * FROM ai_summaries WHERE share_token=$1', [shareToken]));
    } else {
      ({ rows } = await c.query('SELECT * FROM ai_summaries WHERE id=$1', [id]));
    }
    if (!rows.length) return { statusCode: 404, body: { error: '찾을 수 없습니다.' } };
    const s = rows[0];
    const isOwner = user?.userId === s.user_id;
    if (!isOwner && !shareToken) return { statusCode: 403, body: { error: '권한이 없습니다.' } };
    return { statusCode: 200, body: { ...s, is_owner: isOwner } };
  } finally { await c.end(); }
}

async function summaryDelete(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { ids } = body;
  if (!Array.isArray(ids) || !ids.length) return { statusCode: 400, body: { error: '선택 항목 없음' } };
  const c = await getClient();
  try {
    await c.query('DELETE FROM ai_summaries WHERE id=ANY($1) AND user_id=$2', [ids, user.userId]);
    return { statusCode: 200, body: { message: '삭제됐습니다.' } };
  } finally { await c.end(); }
}

async function summaryRename(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { id, title } = body;
  if (!title?.trim()) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };
  const c = await getClient();
  try {

    const r = await c.query(
      'UPDATE ai_summaries SET title=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id',
      [title.trim(), id, user.userId]);
    if (!r.rows.length) return { statusCode: 404, body: { error: '찾을 수 없습니다.' } };
    return { statusCode: 200, body: { ok: true } };
  } finally { await c.end(); }
}

async function summaryLock(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { id, locked, lock_type } = body; // lock_type: 'delete' | 'edit'
  const col = lock_type === 'edit' ? 'is_edit_locked' : 'is_locked';
  const c = await getClient();
  try {
    const r = await c.query(
      `UPDATE ai_summaries SET ${col}=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id`,
      [!!locked, id, user.userId]);
    if (!r.rows.length) return { statusCode: 404, body: { error: '권한이 없습니다.' } };
    return { statusCode: 200, body: { locked: !!locked, lock_type: lock_type || 'delete' } };
  } finally { await c.end(); }
}

async function summaryShare(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { id } = body;
  const token = crypto.randomBytes(16).toString('hex');
  const c = await getClient();
  try {

    const r = await c.query(
      'UPDATE ai_summaries SET share_token=$1 WHERE id=$2 AND user_id=$3 RETURNING share_token',
      [token, id, user.userId]);
    if (!r.rows.length) return { statusCode: 404, body: { error: '찾을 수 없습니다.' } };
    return { statusCode: 200, body: { token: r.rows[0].share_token } };
  } finally { await c.end(); }
}

async function summaryMerge(event, body) {
  const { user, shareToken } = _summaryAuth(event, body);
  const { ids, title } = body;
  if (!Array.isArray(ids) || ids.length < 2) return { statusCode: 400, body: { error: '2개 이상 선택하세요.' } };
  if (!title?.trim()) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };

  let userId, userEmail;
  if (user) { userId = user.userId; userEmail = user.email; }
  else if (shareToken) {
    const c0 = await getClient();
    try {
      userId = await _ownerIdFromToken(c0, shareToken);
      if (!userId) return { statusCode: 403, body: { error: '유효하지 않은 공유 링크입니다.' } };
      const { rows } = await c0.query('SELECT email FROM users WHERE id=$1', [userId]);
      userEmail = (rows[0]?.email ?? '') + ' (공유)';
    } finally { await c0.end(); }
  } else { return { statusCode: 401, body: { error: '로그인이 필요합니다.' } }; }

  if (!process.env.ANTHROPIC_API_KEY)
    return { statusCode: 500, body: { error: 'AI 설정이 필요합니다.' } };

  const c = await getClient();
  try {

    const { rows } = await c.query(
      'SELECT content FROM ai_summaries WHERE id=ANY($1) AND user_id=$2 ORDER BY created_at', [ids, userId]);
    if (!rows.length) return { statusCode: 404, body: { error: '항목을 찾을 수 없습니다.' } };

    const combined = rows.map(r => r.content).join('\n\n---\n\n');
    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 3000,
      messages: [{ role: 'user', content: `다음 ${rows.length}개의 대화 요약을 중복 내용을 제거하고 핵심 정보가 모두 포함되도록 하나로 합쳐주세요. 한국어로 작성하세요.\n\n${combined}` }]
    });
    const merged = res.content?.[0]?.text ?? combined;

    const { rows: cnt2 } = await c.query('SELECT COUNT(*) as n FROM ai_summaries WHERE user_id=$1', [userId]);
    if (parseInt(cnt2[0].n) >= 7)
      return { statusCode: 409, body: { error: '저장된 버전이 7개입니다. 기존 버전을 삭제 후 합치기를 진행해주세요.', limitExceeded: true } };

    const r = await c.query(
      'INSERT INTO ai_summaries (user_id,user_email,title,content) VALUES($1,$2,$3,$4) RETURNING id,created_at',
      [userId, userEmail, title.trim(), merged]);
    const newId = r.rows[0].id;

    // 합쳐진 버전의 파일들도 새 버전으로 복사
    const { rows: allFiles } = await c.query(
      'SELECT filename,content_type,file_data,file_size FROM ai_summary_files WHERE summary_id=ANY($1)', [ids]);
    for (const f of allFiles) {
      await c.query(
        'INSERT INTO ai_summary_files (summary_id,filename,content_type,file_data,file_size) VALUES($1,$2,$3,$4,$5)',
        [newId, f.filename, f.content_type, f.file_data, f.file_size]);
    }

    return { statusCode: 201, body: { id: newId, content: merged } };
  } finally { await c.end(); }
}

// ── AI Summary Files ──────────────────────────────────────────
async function summaryFileUpload(event, body) {
  const { user, shareToken } = _summaryAuth(event, body);
  let userId;
  if (user) { userId = user.userId; }
  else if (shareToken) {
    const c0 = await getClient();
    try { userId = await _ownerIdFromToken(c0, shareToken); }
    finally { await c0.end(); }
    if (!userId) return { statusCode: 403, body: { error: '권한 없음' } };
  } else return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };

  const { summary_id, filename, content_type, data } = body;
  if (!summary_id || !filename || !data) return { statusCode: 400, body: { error: '필수 파라미터 누락' } };

  const buf = Buffer.from(data, 'base64');
  if (buf.length > 3 * 1024 * 1024) return { statusCode: 413, body: { error: '파일 크기 초과 (최대 3MB)' } };

  const c = await getClient();
  try {
    const { rows: sv } = await c.query('SELECT user_id FROM ai_summaries WHERE id=$1', [summary_id]);
    if (!sv.length || sv[0].user_id !== userId) return { statusCode: 403, body: { error: '권한 없음' } };

    const { rows: cnt } = await c.query('SELECT COUNT(*) as n FROM ai_summary_files WHERE summary_id=$1', [summary_id]);
    if (parseInt(cnt[0].n) >= 10) return { statusCode: 409, body: { error: '버전당 최대 10개 파일' } };

    const { rows: tot } = await c.query(
      `SELECT COALESCE(SUM(f.file_size),0) as total FROM ai_summary_files f
       JOIN ai_summaries s ON s.id=f.summary_id WHERE s.user_id=$1`, [userId]);
    if (parseInt(tot[0].total) + buf.length > 100 * 1024 * 1024)
      return { statusCode: 413, body: { error: '전체 저장 용량 초과 (최대 100MB)' } };

    const r = await c.query(
      'INSERT INTO ai_summary_files (summary_id,filename,content_type,file_data,file_size) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [summary_id, filename, content_type || 'application/octet-stream', buf, buf.length]);
    return { statusCode: 201, body: { id: r.rows[0].id, filename, file_size: buf.length } };
  } finally { await c.end(); }
}

async function summaryFileList(event, body) {
  const { user, shareToken } = _summaryAuth(event, body);
  if (!user && !shareToken) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { summary_id } = body;
  const c = await getClient();
  try {
    const { rows } = await c.query(
      'SELECT id, filename, content_type, file_size, created_at FROM ai_summary_files WHERE summary_id=$1 ORDER BY created_at',
      [summary_id]);
    return { statusCode: 200, body: { files: rows } };
  } finally { await c.end(); }
}

async function summaryFileGet(event, body) {
  const { user, shareToken } = _summaryAuth(event, body);
  if (!user && !shareToken) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { file_id } = body;
  const c = await getClient();
  try {
    const { rows } = await c.query(
      'SELECT id, filename, content_type, file_data FROM ai_summary_files WHERE id=$1', [file_id]);
    if (!rows.length) return { statusCode: 404, body: { error: '파일을 찾을 수 없습니다.' } };
    const f = rows[0];
    return { statusCode: 200, body: {
      id: f.id, filename: f.filename, content_type: f.content_type,
      data: f.file_data.toString('base64')
    }};
  } finally { await c.end(); }
}

async function summaryFileDelete(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '로그인이 필요합니다.' } };
  const { file_id } = body;
  const c = await getClient();
  try {
    // Verify ownership via summary
    const { rows: f } = await c.query(
      `SELECT f.id FROM ai_summary_files f JOIN ai_summaries s ON s.id=f.summary_id
       WHERE f.id=$1 AND s.user_id=$2`, [file_id, user.userId]);
    if (!f.length) return { statusCode: 403, body: { error: '권한 없음' } };
    await c.query('DELETE FROM ai_summary_files WHERE id=$1', [file_id]);
    return { statusCode: 200, body: { ok: true } };
  } finally { await c.end(); }
}

// ============================================================
// [기사작성/웹소설작성] 외부 페이지 fetch 헬퍼
// ============================================================
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

// ============================================================
// [기사작성] 마이페이지 설정
// ============================================================
async function getMypage(event) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query(
      `SELECT name, email, COALESCE(article_style,'') AS article_style FROM users WHERE id=$1`, [user.userId]
    );
    return { statusCode: 200, body: {
      profile: { name: rows[0].name, email: rows[0].email },
      article_style: rows[0]?.article_style || '',
    } };
  } finally { await client.end(); }
}

async function saveArticleStyle(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { article_style } = body;
  const client = await getClient();
  try {
    await client.query('UPDATE users SET article_style=$1 WHERE id=$2', [article_style || '', user.userId]);
    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

async function getSectionGuides(event) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query(
      `SELECT COALESCE(section_guides, '["","","","",""]'::jsonb) AS guides,
              COALESCE(section_labels, '["","","","",""]'::jsonb) AS labels
       FROM users WHERE id=$1`, [user.userId]
    );
    return { statusCode: 200, body: { guides: rows[0]?.guides || ['','','','',''], labels: rows[0]?.labels || ['','','','',''] } };
  } finally { await client.end(); }
}

async function saveSectionGuide(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { section_no, guide } = body;
  if (!section_no || section_no < 1 || section_no > 5) return { statusCode: 400, body: { error: '잘못된 섹션 번호' } };
  const idx = section_no - 1;
  const client = await getClient();
  try {
    await client.query(
      `UPDATE users SET section_guides = jsonb_set(
         COALESCE(section_guides, '["","","","",""]'::jsonb), $1, $2::jsonb
       ) WHERE id=$3`,
      [`{${idx}}`, JSON.stringify(guide || ''), user.userId]
    );
    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

async function saveSectionLabel(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { section_no, label } = body;
  if (!section_no || section_no < 1 || section_no > 5) return { statusCode: 400, body: { error: '잘못된 섹션 번호' } };
  const idx = section_no - 1;
  const client = await getClient();
  try {
    await client.query(
      `UPDATE users SET section_labels = jsonb_set(
         COALESCE(section_labels, '["","","","",""]'::jsonb), $1, $2::jsonb
       ) WHERE id=$3`,
      [`{${idx}}`, JSON.stringify(label || ''), user.userId]
    );
    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

// ============================================================
// [기사작성] 이슈 CRUD
// ============================================================
// 비로그인: 완료된 이슈만 / 로그인: 완료 + 본인 + 편집권한 초안 / 검색·필터·페이징 지원
async function getIssues(event) {
  const user = verifyToken(event);
  const qs = event.queryStringParameters || {};
  const q = (qs.q || '').trim();
  const author = (qs.author || '').trim();
  const date = (qs.date || '').trim();
  const mine = qs.mine === '1' && !!user;
  const draft = qs.draft === '1' && !!user;
  const edit = qs.edit === '1' && !!user;
  const page = Math.max(1, parseInt(qs.page) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;

  const client = await getClient();
  try {
    const conds = [];
    const params = [];
    let idx = 1;

    if (mine) {
      conds.push(`i.user_id = $${idx}`); params.push(user.userId); idx++;
    } else if (user) {
      conds.push(`(i.is_draft = false OR i.user_id = $${idx})`);
      params.push(user.userId); idx++;
    } else {
      conds.push('i.is_draft = false');
    }

    if (draft && user) conds.push('i.is_draft = true');

    if (q)           { conds.push(`i.title ILIKE $${idx++}`);        params.push(`%${q}%`); }
    if (author)      { conds.push(`u.name  ILIKE $${idx++}`);        params.push(`%${author}%`); }
    if (date)        { conds.push(`DATE(i.created_at) = $${idx++}`); params.push(date); }
    if (qs.category) { conds.push(`i.category = $${idx++}`);         params.push(qs.category); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const base = `FROM aw_projects i JOIN users u ON i.user_id = u.id ${where}`;

    const countR = await client.query(`SELECT COUNT(*) ${base}`, params);
    const total = parseInt(countR.rows[0].count);

    const dataR = await client.query(
      `SELECT i.id, i.title, i.is_draft, i.category, i.created_at, u.name AS author, i.user_id
       ${base} ORDER BY i.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    return { statusCode: 200, body: { issues: dataR.rows, total, page, limit, pages: Math.ceil(total / limit) } };
  } finally { await client.end(); }
}

async function createIssue(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { title, category } = body;
  if (!title?.trim()) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };
  const cat = category || '문화';
  const client = await getClient();
  try {
    const { rows } = await client.query(
      'INSERT INTO aw_projects (user_id,title,category,is_draft) VALUES($1,$2,$3,TRUE) RETURNING id,title,category,created_at',
      [user.userId, title.trim(), cat]
    );
    return { statusCode: 201, body: { issue: { ...rows[0], author: user.name, user_id: user.userId } } };
  } finally { await client.end(); }
}

// 완료 이슈: 비로그인 조회 가능 / 초안: 작성자·편집자만
async function getIssue(event, body, id) {
  const user = verifyToken(event);
  const client = await getClient();
  try {
    const ir = await client.query(
      'SELECT i.*, u.name AS author FROM aw_projects i JOIN users u ON i.user_id=u.id WHERE i.id=$1', [id]
    );
    if (!ir.rows.length) return { statusCode: 404, body: { error: '이슈를 찾을 수 없습니다.' } };

    if (ir.rows[0].is_draft) {
      if (!user) return { statusCode: 403, body: { error: '로그인이 필요합니다.' } };
      if (ir.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '조회 권한이 없습니다.' } };
    }

    const sr = await client.query(
      `SELECT section_no, content,
              COALESCE(guide,'')      AS guide,
              COALESCE(ai_content,'') AS ai_content,
              COALESCE(label,'')      AS label
       FROM aw_sections WHERE issue_id=$1 ORDER BY section_no`, [id]
    );
    const sections = [1, 2, 3, 4, 5].map(n => {
      const f = sr.rows.find(r => r.section_no === n);
      return f ? f.content : '';
    });
    const sectionGuides = [1, 2, 3, 4, 5].map(n => {
      const f = sr.rows.find(r => r.section_no === n);
      return f ? f.guide : '';
    });
    const sectionAiContents = [1, 2, 3, 4, 5].map(n => {
      const f = sr.rows.find(r => r.section_no === n);
      return f ? f.ai_content : '';
    });
    const sectionLabels = [1, 2, 3, 4, 5].map(n => {
      const f = sr.rows.find(r => r.section_no === n);
      return f ? f.label : '';
    });

    return { statusCode: 200, body: { issue: ir.rows[0], sections, sectionGuides, sectionAiContents, sectionLabels } };
  } finally { await client.end(); }
}

async function updateIssue(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { title } = body;
  if (!title?.trim()) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };
  const client = await getClient();
  try {
    const check = await client.query('SELECT user_id FROM aw_projects WHERE id=$1', [id]);
    if (!check.rows.length) return { statusCode: 404, body: { error: '이슈를 찾을 수 없습니다.' } };
    if (check.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '수정 권한이 없습니다.' } };
    await client.query('UPDATE aw_projects SET title=$1, updated_at=NOW() WHERE id=$2', [title.trim(), id]);
    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

async function deleteIssue(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const check = await client.query('SELECT user_id FROM aw_projects WHERE id=$1', [id]);
    if (!check.rows.length) return { statusCode: 404, body: { error: '이슈를 찾을 수 없습니다.' } };
    if (check.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '삭제 권한이 없습니다.' } };
    await client.query('DELETE FROM aw_projects WHERE id=$1', [id]);
    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

// ============================================================
// [기사작성] 섹션 저장 / 편집자 지정
// ============================================================
// 작성자: 전체 5개 섹션 + 기사 본문 저장
async function saveSections(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { sections, guides, labels, aiContents, is_draft, article_content } = body;
  if (!Array.isArray(sections) || sections.length !== 5)
    return { statusCode: 400, body: { error: '섹션 데이터가 올바르지 않습니다.' } };
  const client = await getClient();
  try {
    const check = await client.query('SELECT user_id FROM aw_projects WHERE id=$1', [id]);
    if (!check.rows.length) return { statusCode: 404, body: { error: '이슈를 찾을 수 없습니다.' } };
    if (check.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '수정 권한이 없습니다.' } };
    for (let i = 0; i < 5; i++) {
      await client.query(
        `INSERT INTO aw_sections (issue_id, section_no, content, guide, ai_content, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, guide=$4, ai_content=$5, updated_at=NOW()`,
        [id, i + 1, sections[i] || '', (guides && guides[i]) || '', (aiContents && aiContents[i]) || '']
      );
    }
    const draft = is_draft !== undefined ? is_draft : true;
    await client.query(
      'UPDATE aw_projects SET is_draft=$1, article_content=$2, updated_at=NOW() WHERE id=$3',
      [draft, article_content ?? '', id]
    );

    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

// 편집자: 단일 섹션 저장
async function saveSection(event, body, id, sectionNo) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { content } = body;
  const client = await getClient();
  try {
    const issue = await client.query('SELECT user_id FROM aw_projects WHERE id=$1', [id]);
    if (!issue.rows.length) return { statusCode: 404, body: { error: '이슈를 찾을 수 없습니다.' } };

    const isAuthor = issue.rows[0].user_id === user.userId;
    if (!isAuthor) return { statusCode: 403, body: { error: '편집 권한이 없습니다.' } };
    await client.query(
      `INSERT INTO aw_sections (issue_id, section_no, content, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, updated_at=NOW()`,
      [id, sectionNo, content || '']
    );
    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

// ============================================================
// [기사작성] AI 주제 생성 (제목/링크 입력 → 이슈 생성)
// ============================================================
async function aiTopic(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  try {
    const userTitle = (body.userTitle || '').trim();
    const category = body.category || '문화';
    if (!userTitle) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };

    // URL 입력 감지 → 링크 분석 흐름
    if (/^https?:\/\//i.test(userTitle)) {
      return await aiTopicFromUrl(user, userTitle, category);
    }

    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // 1. Haiku로 핵심 키워드 추출
    let keywords = userTitle.split(/\s+/).slice(0, 4).join(' ');
    try {
      const kwMsg = await ai.messages.create({
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
      const tM = xml.match(/<title>([\s\S]*?)<\/title>/);
      const lM = xml.match(/<link>([\s\S]*?)<\/link>/) || xml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      const dM = xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (!tM) continue;
      const t = tM[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();
      const l = lM ? lM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      const d = dM ? dM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      if (t && l && /^https?:\/\//i.test(l) && !t.toLowerCase().includes('google')) items.push({ title: t, link: l, pubDate: d });
    }
    items.sort((a, b) => (b.pubDate ? new Date(b.pubDate) : 0) - (a.pubDate ? new Date(a.pubDate) : 0));

    if (!items.length) return { statusCode: 422, body: { error: '입력한 제목으로 관련 최신 기사를 찾지 못했습니다. 다른 제목으로 시도해보세요.' } };

    // 3. Haiku로 제목 다듬기
    let finalTitle = userTitle;
    try {
      const refContext = items.slice(0, 5).map(i => i.title).join('\n');
      const titleMsg = await ai.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 80,
        messages: [{ role: 'user', content: `기사 제목을 최신 뉴스 참고해서 더 구체적으로 다듬어 한 줄로 출력하세요.\n규칙: 반드시 완성된 기사 제목 텍스트만 출력. 설명·이유·실패메시지·부연 문장 절대 금지.\n적합한 제목을 못 찾으면 원본 제목을 그대로 출력.\n\n원본 제목: ${userTitle}\n최신 뉴스:\n${refContext}` }]
      });
      const refined = titleMsg.content[0].text.trim().split('\n')[0];
      const isFailMsg = /완전하지|부족|실패|없습니다|찾지 못|불가능|어렵습니다|적합하지|모르겠|죄송/.test(refined);
      if (refined && refined.length > 3 && refined.length < 120 && !isFailMsg) finalTitle = refined;
    } catch {}

    const refLinks = items.map(i => ({ title: i.title, url: i.link, pubDate: i.pubDate || '' }));

    const client = await getClient();
    let row;
    try {
      const r = await client.query(
        'INSERT INTO aw_projects (user_id,title,category,is_draft,reference_links) VALUES($1,$2,$3,TRUE,$4) RETURNING id,title,category,created_at',
        [user.userId, finalTitle, category, JSON.stringify(refLinks)]
      );
      row = r.rows[0];
    } finally { await client.end(); }
    return { statusCode: 201, body: { issue: { ...row, author: user.name, user_id: user.userId } } };
  } catch (e) { console.error(e); return { statusCode: 500, body: { error: e.message || 'AI 주제 생성 실패' } }; }
}

// URL 입력 시: 페이지 내용 분석 → 제목 생성 → 관련 뉴스 검색 → 섹션 자동채우기
async function aiTopicFromUrl(user, pageUrl, category) {
  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // 1. 페이지 내용 + 링크 추출
  let html = '';
  try { html = await Promise.race([fetchUrl(pageUrl), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))]); } catch {}

  const pageText = html ? extractPageText(html) : '';
  const pageLinks = html ? extractPageLinks(html, pageUrl) : [];

  if (!pageText && !pageLinks.length) {
    return { statusCode: 422, body: { error: '해당 URL에서 내용을 가져오지 못했습니다. 다른 URL을 시도해보세요.' } };
  }

  const contextSnippet = pageText || pageLinks.slice(0, 6).map(l => l.title).join('\n');

  // 2. Haiku로 분류에 맞는 기사 제목 생성
  let finalTitle = '';
  try {
    const titleMsg = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 100,
      messages: [{ role: 'user', content: `아래 웹페이지 내용을 바탕으로 [${category}] 분야에 특징 있는 기사 제목을 한 줄로 작성하세요. 제목만 출력.\n\n내용:\n${contextSnippet}` }]
    });
    finalTitle = titleMsg.content[0].text.trim().split('\n')[0];
    const isFail = /완전하지|부족|실패|없습니다|찾지 못|불가능|어렵습니다|모르겠/.test(finalTitle);
    if (!finalTitle || isFail) return { statusCode: 422, body: { error: '제목을 생성하지 못했습니다. 다른 URL을 시도해보세요.' } };
  } catch (e) { return { statusCode: 500, body: { error: '제목 생성 실패' } }; }

  // 3. 제목 키워드로 Google News RSS 최신글 추가 검색
  let googleLinks = [];
  try {
    const kwMsg = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 40,
      messages: [{ role: 'user', content: `기사 제목에서 핵심 명사 4개만 추출. 띄어쓰기로만 구분.\n제목: ${finalTitle}` }]
    });
    const keywords = kwMsg.content[0].text.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
    const rss = await fetchUrl(`https://news.google.com/rss/search?q=${encodeURIComponent(keywords)}&hl=ko&gl=KR&ceid=KR:ko`);
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let im;
    while ((im = itemRe.exec(rss)) !== null && googleLinks.length < 15) {
      const xml = im[1];
      const tM = xml.match(/<title>([\s\S]*?)<\/title>/);
      const lM = xml.match(/<link>([\s\S]*?)<\/link>/) || xml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      const dM = xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
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
  const refLinks = googleLinks.slice(0, 25);

  // 5. 이슈 저장 + 6. 섹션 자동채우기 (Haiku, 최대 3섹션)
  const client = await getClient();
  let row;
  try {
    const r = await client.query(
      'INSERT INTO aw_projects (user_id,title,category,is_draft,reference_links) VALUES($1,$2,$3,TRUE,$4) RETURNING id,title,category,created_at',
      [user.userId, finalTitle, category, JSON.stringify(refLinks)]
    );
    row = r.rows[0];
    const issueId = row.id;

    try {
      const DEFAULT_LABELS = ['배경 / 발단', '주요 내용', '인터뷰 / 현장', '관련 자료', '결론 / 전망'];
      const toGenerate = DEFAULT_LABELS
        .map((l, i) => ({ no: i + 1, label: l, guide: '' }))
        .slice(0, 3);

      if (toGenerate.length) {
        const sectionSpecs = toGenerate.map(s => `[${s.no}]`).join('\n');
        const batchMsg = await ai.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 4000,
          messages: [{ role: 'user', content: `기사 제목: ${finalTitle}\n\n[참고자료 — 이 내용을 최우선으로 활용]\n${contextSnippet}\n\n규칙: 참고자료의 사실·내용·수치를 빠짐없이 담아 각 섹션을 가능한 한 길고 상세하게 작성. 짧게 쓰지 마세요. 섹션 번호·제목 포함하지 마세요.\n\n${sectionSpecs}\n\n출력:\n[1]\n내용\n\n[2]\n내용` }]
        });
        const batchText = batchMsg.content[0].text;
        for (const s of toGenerate) {
          const m = batchText.match(new RegExp(`\\[${s.no}\\]([\\s\\S]*?)(?=\\[\\d+\\]|$)`));
          const content = m ? m[1].trim() : '';
          if (content) {
            await client.query(
              `INSERT INTO aw_sections (issue_id, section_no, content, updated_at)
               VALUES ($1,$2,$3,NOW())
               ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, updated_at=NOW()`,
              [issueId, s.no, content]
            );
          }
        }
      }
    } catch (e) { console.error('URL 섹션 자동채우기 오류:', e.message); }
  } finally { await client.end(); }

  return { statusCode: 201, body: { issue: { ...row, author: user.name, user_id: user.userId } } };
}

// ============================================================
// [기사작성] AI 기사 생성
// ============================================================
async function generateArticle(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { title, sections, content } = body;
  if (!title) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };
  const client = await getClient();
  try {
    let writingStyle = '', articleStyle = '';
    try {
      const ur = await client.query(
        `SELECT writing_style, COALESCE(article_style,'') AS article_style FROM users WHERE id=$1`, [user.userId]
      );
      writingStyle = ur.rows[0]?.writing_style || '';
      articleStyle = ur.rows[0]?.article_style  || '';
    } catch {
      const ur = await client.query('SELECT writing_style FROM users WHERE id=$1', [user.userId]);
      writingStyle = ur.rows[0]?.writing_style || '';
    }

    let promptContent;
    if (content?.trim()) {
      const hasStyle = !!(articleStyle?.trim());
      const styleRef = hasStyle ? `\n\n[기사 스타일 참고]\n${articleStyle}` : '';
      promptContent = `아래 기사 원고를 하나의 완성된 뉴스 기사로 다듬어주세요.

주의사항:
- ###, **, -- 같은 섹션 구분자나 소제목을 제거하고 하나의 흐름으로 이어지게 작성하세요
- 각 문단이 자연스럽게 연결되도록 하고, 별개 기사처럼 끊기지 않게 해주세요
- ${hasStyle ? '위 스타일 참고해 문체·구조를 맞춰주세요.' : '전문 뉴스 기자처럼 서론·본론·결론이 자연스럽게 이어지는 한 편의 기사로 작성하세요.'}

기사 제목: ${title}

[원고]
${content}${styleRef}`;
    } else {
      if (!Array.isArray(sections)) return { statusCode: 400, body: { error: '섹션 내용을 입력하세요.' } };
      const labels = ['배경/발단', '주요 내용', '인터뷰/현장', '관련 자료', '결론/전망'];
      const sectionBody = sections.map((s, i) => `[${labels[i]}]\n${s || '(내용 없음)'}`).join('\n\n');
      let personalSection = '';
      if (articleStyle) personalSection += `\n\n[기사 완성본 스타일 예시]\n${articleStyle}`;
      if (writingStyle)  personalSection += `\n\n[작성자 스타일 가이드]\n${writingStyle}`;
      const styleNote = personalSection ? '\n위 스타일 예시와 가이드를 최대한 반영하세요.' : '';
      promptContent = `아래 제목과 5개 섹션 내용을 바탕으로 완성도 높은 뉴스 기사를 작성해 주세요.\n육하원칙에 따라 자연스럽게 이어지는 기사 형식으로 작성하세요.${styleNote}\n\n제목: ${title}\n\n${sectionBody}${personalSection}`;
    }

    // 다듬기(content 전달) → Haiku(빠름), 섹션 기반 생성 → Sonnet
    const useHaiku = !!(content?.trim());
    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await ai.messages.create({
      model:      useHaiku ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6',
      max_tokens: useHaiku ? 6000 : 3000,
      messages: [{ role: 'user', content: promptContent }]
    });
    return { statusCode: 200, body: { article: msg.content[0].text.trim() } };
  } catch (e) { console.error(e); return { statusCode: 500, body: { error: e.message || '기사 생성 실패' } }; }
  finally { await client.end(); }
}

// ============================================================
// [기사작성] 관련기사 검색 / AI 섹션 작성 / 섹션 자동채우기
// ============================================================
async function searchRelated(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const ir = await client.query('SELECT title, category FROM aw_projects WHERE id=$1', [id]);
    if (!ir.rows.length) return { statusCode: 404, body: { error: '이슈를 찾을 수 없습니다.' } };
    const { title, category } = ir.rows[0];

    const catExtra = {
      '문화': '예술 공연 전시',   '정치': '국회 정책 정부',
      '경제': '산업 금융 주식',   '사회': '사건 복지 환경',
      '스포츠': '축구 야구 올림픽','연예': '드라마 K팝 영화',
      'IT/과학': '인공지능 기술', '국제': '외교 세계 해외',
      '교육': '학교 입시 대학',   '건강': '의료 병원 질병',
    };

    let keywords;
    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    try {
      const kwMsg = await ai.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 40,
        messages: [{ role: 'user', content: `기사 제목에서 검색에 유용한 핵심 명사 4개만 추출하세요. 흔하지 않고 구체적인 고유명사·전문용어 위주. 쉼표 없이 띄어쓰기로만 구분해서 단어들만 출력.\n제목: ${title}` }]
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

    items.sort((a, b) => (b.pubDate ? new Date(b.pubDate) : 0) - (a.pubDate ? new Date(a.pubDate) : 0));

    return { statusCode: 200, body: { items } };
  } catch (e) { console.error(e); return { statusCode: 500, body: { error: '검색 실패' } }; }
  finally { await client.end(); }
}

async function aiWriteSection(event, body, id, sectionNo) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { content, guide, label } = body;
  const client = await getClient();
  try {
    const ir = await client.query('SELECT title FROM aw_projects WHERE id=$1', [id]);
    if (!ir.rows.length) return { statusCode: 404, body: { error: '이슈를 찾을 수 없습니다.' } };
    const issueTitle = ir.rows[0].title;
    const DEFAULT_LABELS = ['배경/발단', '주요 내용', '인터뷰/현장', '관련 자료', '결론/전망'];
    const sectionLabel = label?.trim() || DEFAULT_LABELS[parseInt(sectionNo) - 1] || `섹션 ${sectionNo}`;
    const guideNote   = guide?.trim() ? `\n\n[작성 가이드]\n${guide.trim()}`   : '';
    const contentNote = content?.trim() ? `\n\n[작성자 메모]\n${content}` : '';
    const ur = await client.query('SELECT writing_style FROM users WHERE id=$1', [user.userId]);
    const writingStyle = ur.rows[0]?.writing_style || '';
    const styleNote = writingStyle ? `\n\n[작성 스타일]\n${writingStyle}` : '';

    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await ai.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 6000,
      messages: [{ role: 'user', content: `다음 기사의 "${sectionLabel}" 섹션을 전문 기자 스타일로 작성해주세요.\n기사 제목: ${issueTitle}${guideNote}${contentNote}${styleNote}\n\n규칙:\n- 작성자 메모를 바탕으로 사실·내용·수치를 빠짐없이 담아 가능한 한 길고 상세하게 작성하세요.\n- 짧게 쓰지 마세요. 전문 기사 수준으로 풍부하게 작성하세요.\n- 가이드가 있으면 그 방향에 맞게 작성하세요.\n- 섹션 제목·번호를 본문에 포함하지 마세요.\n- 본문 내용만 출력하세요. 제목, 설명, 머리말 없이 바로 시작.` }]
    });
    const aiContent = msg.content[0].text.trim();
    await client.query(
      `INSERT INTO aw_sections (issue_id, section_no, guide, ai_content, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (issue_id, section_no) DO UPDATE SET guide=$3, ai_content=$4, updated_at=NOW()`,
      [id, sectionNo, guide || '', aiContent]
    );
    return { statusCode: 200, body: { ai_content: aiContent } };
  } catch (e) { console.error(e); return { statusCode: 500, body: { error: e.message || 'AI 작성 실패' } }; }
  finally { await client.end(); }
}

async function autoFillSections(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const links = Array.isArray(body.links) ? body.links : [];
  const client = await getClient();
  try {
    const ir = await client.query('SELECT title, category, reference_links FROM aw_projects WHERE id=$1', [id]);
    if (!ir.rows.length) return { statusCode: 404, body: { error: '이슈를 찾을 수 없습니다.' } };
    const { title } = ir.rows[0];

    const DEFAULT_LABELS = ['배경 / 발단', '주요 내용', '인터뷰 / 현장', '관련 자료', '결론 / 전망'];
    const toGenerate = DEFAULT_LABELS.map((l, i) => ({ no: i + 1, label: l, guide: '' }));

    if (!toGenerate.length) return { statusCode: 200, body: { results: [], message: '섹션 제목이 설정되지 않았습니다.' } };

    // 참고링크 URL 실제 내용 조회 (병렬, URL당 3초 타임아웃)
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
      return { statusCode: 200, body: { results: [], message: '참고할 내용이 없습니다. 참고링크를 먼저 추가하세요.' } };
    }
    const fullContext = fetchedContent
      ? `${fetchedContent}\n\n[참고 기사 목록]\n${linkTitles}`
      : linkTitles;

    const sectionSpecs = toGenerate.map(s => `[${s.no}]${s.guide ? ` (${s.guide})` : ''}`).join('\n');

    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const batchMsg = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 6000,
      messages: [{ role: 'user', content: `기사 제목: ${title}\n\n[참고자료 — 아래 내용을 최우선으로 활용해 각 섹션을 채워주세요]\n${fullContext}\n\n규칙:\n- 위 참고자료에 있는 사실·내용·수치·인용·배경 등을 빠짐없이 최대한 담아서 작성하세요\n- 참고자료에 없는 내용은 추가하지 마세요\n- 섹션 번호·제목은 본문에 포함하지 마세요\n- 각 섹션을 가능한 한 길고 상세하게, 전문 기사 수준으로 작성하세요 (짧게 쓰지 마세요)\n\n${sectionSpecs}\n\n출력:\n[1]\n내용\n\n[2]\n내용` }]
    });

    const batchText = batchMsg.content[0].text;
    const results = [];
    for (const s of toGenerate) {
      const m = batchText.match(new RegExp(`\\[${s.no}\\]([\\s\\S]*?)(?=\\[\\d+\\]|$)`));
      const content = m ? m[1].trim() : '';
      try {
        await client.query(
          `INSERT INTO aw_sections (issue_id, section_no, content, label, updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (issue_id, section_no) DO UPDATE SET content=$3, label=$4, updated_at=NOW()`,
          [id, s.no, content, s.label]
        );
      } catch {}
      results.push({ no: s.no, content, label: s.label, sources: usedLinks });
    }
    return { statusCode: 200, body: { results } };
  } catch (e) { console.error(e); return { statusCode: 500, body: { error: e.message || '섹션 자동작성 실패' } }; }
  finally { await client.end(); }
}

// ============================================================
// [웹소설작성] 소설 CRUD
// ============================================================
async function getNovels(event) {
  const user = verifyToken(event);
  const qs = event.queryStringParameters || {};
  const q = (qs.q || '').trim();
  const author = (qs.author || '').trim();
  const date = (qs.date || '').trim();
  const mine = qs.mine === '1' && !!user;
  const draft = qs.draft === '1' && !!user;
  const page = Math.max(1, parseInt(qs.page) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;

  const client = await getClient();
  try {
    const conds = [];
    const params = [];
    let idx = 1;

    if (mine) {
      conds.push(`n.user_id = $${idx}`); params.push(user.userId); idx++;
    } else if (user) {
      conds.push(`(n.is_published = true OR n.user_id = $${idx})`);
      params.push(user.userId); idx++;
    } else {
      conds.push('n.is_published = true');
    }

    if (draft && user) conds.push('n.is_published = false');
    if (q)      { conds.push(`n.title ILIKE $${idx++}`); params.push(`%${q}%`); }
    if (author) { conds.push(`u.name  ILIKE $${idx++}`); params.push(`%${author}%`); }
    if (date)   { conds.push(`DATE(n.created_at) = $${idx++}`); params.push(date); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const base  = `FROM nw_projects n JOIN users u ON n.user_id = u.id ${where}`;

    const countR = await client.query(`SELECT COUNT(*) ${base}`, params);
    const total  = parseInt(countR.rows[0].count);

    const dataR = await client.query(
      `SELECT n.id, n.title, n.is_published, n.created_at, u.name AS author, n.user_id
       ${base} ORDER BY n.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    return { statusCode: 200, body: { novels: dataR.rows, total, page, limit, pages: Math.ceil(total / limit) } };
  } finally { await client.end(); }
}

async function createNovel(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { title } = body;
  if (!title?.trim()) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };
  const client = await getClient();
  try {
    const { rows } = await client.query(
      'INSERT INTO nw_projects (user_id,title,is_published) VALUES($1,$2,FALSE) RETURNING id,title,created_at',
      [user.userId, title.trim()]
    );
    return { statusCode: 201, body: { novel: { ...rows[0], author: user.name, user_id: user.userId } } };
  } finally { await client.end(); }
}

async function getNovel(event, body, id) {
  const user = verifyToken(event);
  const client = await getClient();
  try {
    const nr = await client.query(
      'SELECT n.*, u.name AS author FROM nw_projects n JOIN users u ON n.user_id=u.id WHERE n.id=$1', [id]
    );
    if (!nr.rows.length) return { statusCode: 404, body: { error: '소설을 찾을 수 없습니다.' } };
    const novel = nr.rows[0];

    if (!novel.is_published) {
      if (!user) return { statusCode: 403, body: { error: '로그인이 필요합니다.' } };
      if (novel.user_id !== user.userId) return { statusCode: 403, body: { error: '조회 권한이 없습니다.' } };
    }

    return { statusCode: 200, body: { novel: { ...novel, is_owner: !!(user && novel.user_id === user.userId) } } };
  } finally { await client.end(); }
}

async function updateNovel(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { title, is_published } = body;
  if (title !== undefined && !title?.trim()) return { statusCode: 400, body: { error: '제목을 입력하세요.' } };
  const client = await getClient();
  try {
    const check = await client.query('SELECT user_id FROM nw_projects WHERE id=$1', [id]);
    if (!check.rows.length) return { statusCode: 404, body: { error: '소설을 찾을 수 없습니다.' } };
    if (check.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '수정 권한이 없습니다.' } };
    const sets = []; const vals = []; let i = 1;
    if (title        !== undefined) { sets.push(`title=$${i++}`);        vals.push(title.trim()); }
    if (is_published !== undefined) { sets.push(`is_published=$${i++}`); vals.push(is_published); }
    sets.push('updated_at=NOW()');
    vals.push(id);
    await client.query(`UPDATE nw_projects SET ${sets.join(',')} WHERE id=$${i}`, vals);
    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

async function deleteNovel(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const check = await client.query('SELECT user_id FROM nw_projects WHERE id=$1', [id]);
    if (!check.rows.length) return { statusCode: 404, body: { error: '소설을 찾을 수 없습니다.' } };
    if (check.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '삭제 권한이 없습니다.' } };
    await client.query('DELETE FROM nw_projects WHERE id=$1', [id]);
    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

// ============================================================
// [웹소설작성] 메뉴 노드(트리) CRUD
// ============================================================
async function getNovelNodes(event, body, novelId) {
  const user = verifyToken(event);
  const client = await getClient();
  try {
    const check = await client.query('SELECT user_id FROM nw_projects WHERE id=$1', [novelId]);
    if (!check.rows.length) return { statusCode: 404, body: { error: '소설을 찾을 수 없습니다.' } };
    const isOwner = !!(user && check.rows[0].user_id === user.userId);
    const r = await client.query(
      isOwner
        ? 'SELECT id, novel_id, parent_id, position, title, content, ai_content, node_ref, is_visible, updated_at FROM nw_nodes WHERE novel_id=$1 ORDER BY position, id'
        : 'SELECT id, novel_id, parent_id, position, title, content, node_ref, is_visible, updated_at FROM nw_nodes WHERE novel_id=$1 AND is_visible=true ORDER BY position, id',
      [novelId]
    );
    return { statusCode: 200, body: { nodes: r.rows, is_owner: isOwner } };
  } finally { await client.end(); }
}

async function createNovelNode(event, body, novelId) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { parent_id, title } = body;
  const client = await getClient();
  try {
    const check = await client.query('SELECT user_id FROM nw_projects WHERE id=$1', [novelId]);
    if (!check.rows.length) return { statusCode: 404, body: { error: '소설을 찾을 수 없습니다.' } };
    if (check.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '권한이 없습니다.' } };

    const posR = await client.query(
      'SELECT COALESCE(MAX(position),0)+1 AS nxt FROM nw_nodes WHERE novel_id=$1 AND parent_id IS NOT DISTINCT FROM $2',
      [novelId, parent_id ?? null]
    );
    const pos = posR.rows[0].nxt;

    const r = await client.query(
      'INSERT INTO nw_nodes (novel_id, parent_id, position, title) VALUES($1,$2,$3,$4) RETURNING *',
      [novelId, parent_id ?? null, pos, (title || '새 메뉴').trim()]
    );
    return { statusCode: 201, body: { node: r.rows[0] } };
  } finally { await client.end(); }
}

async function updateNovelNode(event, body, nodeId) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const cur = await client.query(
      'SELECT nn.*, n.user_id FROM nw_nodes nn JOIN nw_projects n ON nn.novel_id=n.id WHERE nn.id=$1', [nodeId]
    );
    if (!cur.rows.length) return { statusCode: 404, body: { error: '노드를 찾을 수 없습니다.' } };
    if (cur.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '권한이 없습니다.' } };

    const sets = []; const vals = []; let i = 1;
    if (body.title      !== undefined) { sets.push(`title=$${i++}`);      vals.push(body.title); }
    if (body.content    !== undefined) { sets.push(`content=$${i++}`);    vals.push(body.content); }
    if (body.position   !== undefined) { sets.push(`position=$${i++}`);   vals.push(body.position); }
    if (body.parent_id  !== undefined) { sets.push(`parent_id=$${i++}`);  vals.push(body.parent_id); }
    if (body.is_visible !== undefined) { sets.push(`is_visible=$${i++}`); vals.push(body.is_visible); }
    sets.push('updated_at=NOW()');
    vals.push(nodeId);

    const r = await client.query(`UPDATE nw_nodes SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    return { statusCode: 200, body: { node: r.rows[0] } };
  } finally { await client.end(); }
}

async function deleteNovelNode(event, body, nodeId) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const cur = await client.query(
      'SELECT nn.id, n.user_id FROM nw_nodes nn JOIN nw_projects n ON nn.novel_id=n.id WHERE nn.id=$1', [nodeId]
    );
    if (!cur.rows.length) return { statusCode: 404, body: { error: '노드를 찾을 수 없습니다.' } };
    if (cur.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '권한이 없습니다.' } };
    await client.query('DELETE FROM nw_nodes WHERE id=$1', [nodeId]);
    return { statusCode: 200, body: { ok: true } };
  } finally { await client.end(); }
}

/* ── vm_projects (새 동영상 제작) ──────────────────────────── */
async function getVmSettings(event) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const r = await client.query('SELECT flow_settings FROM video_maker_settings WHERE user_id=$1', [user.userId]);
    const url = r.rows[0]?.flow_settings?.url || '';
    return { statusCode: 200, body: { url } };
  } catch (e) { console.error('getVmSettings:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function getVmProjects(event) {
  const user = verifyToken(event);
  const client = await getClient();
  try {
    let r;
    if (user) {
      // 로그인: 내 프로젝트 목록 (게시 여부 포함)
      r = await client.query(
        `SELECT vp.id, vp.title, vp.is_published, vp.updated_at, u.name AS author_name
         FROM vm_projects vp JOIN users u ON u.id = vp.user_id
         WHERE vp.user_id=$1 ORDER BY vp.updated_at DESC`,
        [user.userId]
      );
    } else {
      // 비로그인: 게시된 프로젝트만 공개
      r = await client.query(
        `SELECT vp.id, vp.title, vp.is_published, vp.updated_at, u.name AS author_name
         FROM vm_projects vp JOIN users u ON u.id = vp.user_id
         WHERE vp.is_published = TRUE ORDER BY vp.updated_at DESC`
      );
    }
    return { statusCode: 200, body: { projects: r.rows, isOwner: !!user } };
  } catch (e) { console.error('getVmProjects:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function getVmProjectById(event, id) {
  const user = verifyToken(event);
  const client = await getClient();
  try {
    const r = await client.query(
      `SELECT vp.id, vp.title, vp.is_published, vp.updated_at, u.name AS author_name,
              (vp.user_id = $2) AS is_owner
       FROM vm_projects vp JOIN users u ON u.id = vp.user_id
       WHERE vp.id = $1`,
      [id, user?.userId || 0]
    );
    if (!r.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    const proj = r.rows[0];
    if (!proj.is_owner && !proj.is_published) return { statusCode: 403, body: { error: '비공개 프로젝트입니다.' } };
    return { statusCode: 200, body: { project: proj } };
  } catch (e) { console.error('getVmProjectById:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function publishVmProject(event, id, isPublish) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const r = await client.query(
      `UPDATE vm_projects SET is_published=$1, updated_at=NOW()
       WHERE id=$2 AND user_id=$3 RETURNING id, title, is_published`,
      [isPublish, id, user.userId]
    );
    if (!r.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    return { statusCode: 200, body: { project: r.rows[0] } };
  } catch (e) { console.error('publishVmProject:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function createVmProject(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const r = await client.query(
      `INSERT INTO vm_projects (user_id, title) VALUES ($1,$2) RETURNING id, title, updated_at`,
      [user.userId, (String(body.title || '새 프로젝트')).slice(0, 200)]
    );
    return { statusCode: 201, body: { project: r.rows[0] } };
  } catch (e) { console.error('createVmProject:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function updateVmProject(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const cur = await client.query('SELECT user_id FROM vm_projects WHERE id=$1', [id]);
    if (!cur.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    if (cur.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '권한이 없습니다.' } };
    const sets = [], vals = []; let i = 1;
    if (body.title     !== undefined) { sets.push(`title=$${i++}`);     vals.push(String(body.title).slice(0, 200)); }
    if (body.grid_data !== undefined) { sets.push(`grid_data=$${i++}`); vals.push(JSON.stringify(body.grid_data)); }
    if (!sets.length) return { statusCode: 400, body: { error: '변경할 내용이 없습니다.' } };
    sets.push('updated_at=NOW()');
    vals.push(id);
    const r = await client.query(
      `UPDATE vm_projects SET ${sets.join(',')} WHERE id=$${i} RETURNING id, title, updated_at`,
      vals
    );
    return { statusCode: 200, body: { project: r.rows[0] } };
  } catch (e) { console.error('updateVmProject:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function deleteVmProject(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const cur = await client.query('SELECT user_id FROM vm_projects WHERE id=$1', [id]);
    if (!cur.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    if (cur.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '권한이 없습니다.' } };
    // 프로젝트 내 모든 노드 ID 조회 → 각 노드 S3 디렉터리 삭제
    const { rows: nodeRows } = await client.query(
      'SELECT id FROM vm_nodes WHERE project_id=$1 AND user_id=$2', [id, user.userId]);
    await client.query('DELETE FROM vm_projects WHERE id=$1', [id]);
    await Promise.all(nodeRows.map(r => _listNodeS3Keys(user.userId, r.id).then(keys => _s3DeleteKeys(keys))));
    return { statusCode: 200, body: { ok: true } };
  } catch (e) { console.error('deleteVmProject:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function getVmNodes(event, pid) {
  const user = verifyToken(event);
  const client = await getClient();
  try {
    // 접근 권한 확인: 오너 또는 게시된 프로젝트
    const projR = await client.query('SELECT user_id, is_published FROM vm_projects WHERE id=$1', [pid]);
    if (!projR.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    const proj = projR.rows[0];
    const isOwner = user && proj.user_id === user.userId;
    if (!isOwner && !proj.is_published) return { statusCode: 403, body: { error: '비공개 프로젝트입니다.' } };

    const r = await client.query(
      'SELECT id, parent_id, position, title, objects, updated_at FROM vm_nodes WHERE project_id=$1 ORDER BY position',
      [pid]
    );
    return { statusCode: 200, body: { nodes: r.rows } };
  } catch (e) { console.error('getVmNodes:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function createVmNode(event, body, pid) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const parentId = body.parent_id != null ? body.parent_id : null;
    const posR = await client.query(
      `SELECT COALESCE(MAX(position), -1)+1 AS pos FROM vm_nodes WHERE user_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3`,
      [user.userId, pid, parentId]
    );
    const position = posR.rows[0].pos;
    const r = await client.query(
      `INSERT INTO vm_nodes (user_id, project_id, parent_id, position, title) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, parent_id, position, title, objects, updated_at`,
      [user.userId, pid, parentId, position, String(body.title || '새 항목').slice(0, 200)]
    );
    return { statusCode: 201, body: { node: r.rows[0] } };
  } catch (e) { console.error('createVmNode:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function updateVmNode(event, body, pid, nid) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const sets = [], vals = [user.userId, pid, nid]; let i = 4;
    if (body.title    !== undefined) { sets.push(`title=$${i++}`);    vals.push(String(body.title).slice(0, 200)); }
    if (body.objects  !== undefined) { sets.push(`objects=$${i++}`);  vals.push(JSON.stringify(body.objects)); }
    if (body.position !== undefined) { sets.push(`position=$${i++}`); vals.push(body.position); }
    if (!sets.length) return { statusCode: 400, body: { error: '변경할 내용이 없습니다.' } };
    sets.push('updated_at=NOW()');
    await client.query(`UPDATE vm_nodes SET ${sets.join(',')} WHERE user_id=$1 AND project_id=$2 AND id=$3`, vals);

    // 노드 디렉터리(vm-objects/{userId}/{nodeId}/) 내 파일 중 DB에 없는 것 삭제
    // S3 오류(권한 등)가 발생해도 DB 저장은 성공으로 처리
    if (body.objects !== undefined) {
      const newKeys = new Set(
        (Array.isArray(body.objects) ? body.objects : []).filter(o => o.s3_key).map(o => o.s3_key)
      );
      try {
        const allDirKeys = await _listNodeS3Keys(user.userId, nid);
        const orphans = allDirKeys.filter(k => !newKeys.has(k));
        if (orphans.length) await _s3DeleteKeys(orphans);
      } catch (e) {
        console.warn('updateVmNode: S3 orphan cleanup failed (non-fatal):', e.message);
      }
    }
    return { statusCode: 200, body: { ok: true } };
  } catch (e) { console.error('updateVmNode:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function deleteVmNode(event, pid, nid) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    // 서브트리 노드 ID 수집 → DB 삭제 → 각 노드 S3 디렉터리 삭제
    const subtreeIds = await _getNodeSubtreeIds(client, user.userId, nid);
    await client.query('DELETE FROM vm_nodes WHERE user_id=$1 AND project_id=$2 AND id=$3', [user.userId, pid, nid]);
    await Promise.all(subtreeIds.map(id => _listNodeS3Keys(user.userId, id).then(keys => _s3DeleteKeys(keys))));
    return { statusCode: 200, body: { ok: true } };
  } catch (e) { console.error('deleteVmNode:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function getChildrenObjects(event, pid, nid) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const r = await client.query(
      `SELECT id, title, objects FROM vm_nodes WHERE user_id=$1 AND project_id=$2 AND parent_id=$3 ORDER BY position`,
      [user.userId, pid, nid]
    );
    const combined = [];
    for (const child of r.rows) {
      const objs = Array.isArray(child.objects) ? child.objects : [];
      for (const obj of objs) combined.push({ ...obj, _nodeId: child.id, _nodeTitle: child.title });
    }
    return { statusCode: 200, body: { children: r.rows.map(c => ({ id: c.id, title: c.title })), objects: combined } };
  } catch (e) { console.error('getChildrenObjects:', e); return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

// ── 동영상/이미지 S3 공통 헬퍼 ──────────────────────────────
async function _s3DeleteKeys(keys) {
  if (!keys.length) return;
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return;
  const s3 = new S3Client({ region: REGION });
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map(k => ({ Key: k })) },
      }));
    } catch (e) { console.error('S3 batch delete error:', e.message); }
  }
}

// 노드 S3 디렉터리(vm-objects/{userId}/{nodeId}/) 내 파일 목록 조회
async function _listNodeS3Keys(userId, nodeId) {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return [];
  const s3 = new S3Client({ region: REGION });
  const prefix = `vm-objects/${userId}/${nodeId}/`;
  const keys = [];
  let token = null;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}),
    }));
    (res.Contents || []).forEach(o => keys.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : null;
  } while (token);
  return keys;
}

// nodeId 서브트리(자신 포함)의 vm_nodes id 목록
async function _getNodeSubtreeIds(client, userId, nodeId) {
  const { rows } = await client.query(`
    WITH RECURSIVE sub AS (
      SELECT id FROM vm_nodes WHERE id=$1 AND user_id=$2
      UNION ALL
      SELECT n.id FROM vm_nodes n JOIN sub ON n.parent_id=sub.id
    ) SELECT id FROM sub
  `, [nodeId, userId]);
  return rows.map(r => r.id);
}

// 노드 서브트리의 S3 파일 전체 삭제
async function _deleteNodeTree(userId, rootNodeId, client) {
  const ids = await _getNodeSubtreeIds(client, userId, rootNodeId);
  await Promise.all(ids.map(async id => {
    const keys = await _listNodeS3Keys(userId, id);
    if (keys.length) await _s3DeleteKeys(keys);
  }));
}


async function vmS3Presign(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { filename, content_type, node_id, obj_id } = body;
  if (!filename || !node_id) return { statusCode: 400, body: { error: '필수 파라미터 누락' } };
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return { statusCode: 500, body: { error: 'S3_BUCKET 환경변수가 설정되지 않았습니다.' } };
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const keyPart = obj_id
    ? obj_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) + '-' + safeName
    : Date.now() + '-' + safeName;
  // S3 경로: vm-objects/{userId}/{nodeId}/{objId}-{filename}
  const s3Key = `vm-objects/${user.userId}/${node_id}/${keyPart}`;
  const s3 = new S3Client({ region: REGION });
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: content_type || 'application/octet-stream' });
  const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
  return { statusCode: 200, body: { presignedUrl, s3Key } };
}

async function vmS3GetUrl(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { s3_key } = body;
  if (!s3_key) return { statusCode: 400, body: { error: 's3_key가 없습니다.' } };
  if (!s3_key.startsWith(`vm-objects/${user.userId}/`))
    return { statusCode: 403, body: { error: '권한이 없습니다.' } };
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return { statusCode: 500, body: { error: 'S3_BUCKET 환경변수가 설정되지 않았습니다.' } };
  const s3 = new S3Client({ region: REGION });
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: s3_key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
  return { statusCode: 200, body: { url } };
}

async function vmS3CopyObjects(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { objects, node_id } = body;
  if (!Array.isArray(objects) || !node_id) return { statusCode: 400, body: { error: '필수 파라미터 누락' } };
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return { statusCode: 500, body: { error: 'S3_BUCKET 환경변수가 설정되지 않았습니다.' } };
  const s3 = new S3Client({ region: REGION });
  const userPrefix = `vm-objects/${user.userId}/`;
  const results = [];
  for (const obj of objects) {
    const { sourceKey, filename, newObjId } = obj;
    if (!sourceKey || !newObjId || !sourceKey.startsWith(userPrefix)) continue;
    const safeName = (filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    // 대상 경로: vm-objects/{userId}/{targetNodeId}/{timestamp}-{filename}
    const destKey = `vm-objects/${user.userId}/${node_id}/${Date.now()}-${safeName}`;
    try {
      await s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${sourceKey}`, Key: destKey }));
      const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: destKey }), { expiresIn: 3600 });
      results.push({ newObjId, s3Key: destKey, url: getUrl });
    } catch (e) { console.error('S3 copy error:', e.message); }
  }
  return { statusCode: 200, body: { results } };
}

async function vmS3Cleanup(event) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return { statusCode: 500, body: { error: 'S3_BUCKET 환경변수가 설정되지 않았습니다.' } };
  // 사용자 전체 S3 파일 목록 조회
  const allKeys = await _listNodeS3Keys(user.userId, ''); // prefix: vm-objects/{userId}/
  // 실제로는 vm-objects/{userId}/ 를 prefix로 씀 — _listNodeS3Keys에 빈 문자열 넣으면 userId/ 까지만 됨
  // 직접 구현:
  const s3 = new S3Client({ region: REGION });
  const allUserKeys = [];
  let token = null;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: `vm-objects/${user.userId}/`, ...(token ? { ContinuationToken: token } : {}),
    }));
    (res.Contents || []).forEach(o => allUserKeys.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : null;
  } while (token);
  if (!allUserKeys.length) return { statusCode: 200, body: { deleted: 0 } };
  const client = await getClient();
  const referenced = new Set();
  try {
    const { rows } = await client.query('SELECT objects FROM vm_nodes WHERE user_id=$1', [user.userId]);
    for (const row of rows) {
      const objs = Array.isArray(row.objects) ? row.objects : [];
      for (const obj of objs) { if (obj.s3_key) referenced.add(obj.s3_key); }
    }
  } finally { await client.end(); }
  const orphans = allUserKeys.filter(k => !referenced.has(k));
  if (!orphans.length) return { statusCode: 200, body: { deleted: 0 } };
  await _s3DeleteKeys(orphans);
  return { statusCode: 200, body: { deleted: orphans.length } };
}

async function vmS3DeleteObject(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { s3_key } = body;
  if (!s3_key) return { statusCode: 400, body: { error: 's3_key가 없습니다.' } };
  if (!s3_key.startsWith(`vm-objects/${user.userId}/`))
    return { statusCode: 403, body: { error: '권한이 없습니다.' } };
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return { statusCode: 500, body: { error: 'S3_BUCKET 환경변수가 설정되지 않았습니다.' } };
  try {
    await _s3DeleteKeys([s3_key]);
    return { statusCode: 200, body: { ok: true } };
  } catch (e) {
    console.error('vmS3DeleteObject:', e);
    return { statusCode: 500, body: { error: e.message } };
  }
}

async function routeVideoMaker(event, body, method, path) {
  if (path === '/video-maker/s3/presign'  && method === 'POST') return vmS3Presign(event, body);
  if (path === '/video-maker/s3/get-url'  && method === 'POST') return vmS3GetUrl(event, body);
  if (path === '/video-maker/s3/delete'   && method === 'POST') return vmS3DeleteObject(event, body);
  if (path === '/video-maker/s3/copy'     && method === 'POST') return vmS3CopyObjects(event, body);
  if (path === '/video-maker/s3/cleanup'  && method === 'POST') return vmS3Cleanup(event);
  if (path === '/video-maker/settings' && method === 'GET') return getVmSettings(event);
  if (path === '/video-maker/projects' && method === 'GET') return getVmProjects(event);
  if (path === '/video-maker/projects' && method === 'POST') return createVmProject(event, body);

  const publishM = path.match(/^\/video-maker\/projects\/(\d+)\/(publish|unpublish)$/);
  if (publishM && method === 'PUT') return publishVmProject(event, publishM[1], publishM[2] === 'publish');

  const projM = path.match(/^\/video-maker\/projects\/(\d+)$/);
  if (projM && method === 'GET')    return getVmProjectById(event, projM[1]);
  if (projM && method === 'PUT')    return updateVmProject(event, body, projM[1]);
  if (projM && method === 'DELETE') return deleteVmProject(event, body, projM[1]);

  // children-objects 먼저 매칭 (nodes/:nid 패턴보다 우선)
  const childrenM = path.match(/^\/video-maker\/projects\/(\d+)\/nodes\/(\d+)\/children-objects$/);
  if (childrenM && method === 'GET') return getChildrenObjects(event, childrenM[1], childrenM[2]);

  const nodesListM = path.match(/^\/video-maker\/projects\/(\d+)\/nodes$/);
  if (nodesListM && method === 'GET')  return getVmNodes(event, nodesListM[1]);
  if (nodesListM && method === 'POST') return createVmNode(event, body, nodesListM[1]);

  const nodeM = path.match(/^\/video-maker\/projects\/(\d+)\/nodes\/(\d+)$/);
  if (nodeM && method === 'PUT')    return updateVmNode(event, body, nodeM[1], nodeM[2]);
  if (nodeM && method === 'DELETE') return deleteVmNode(event, nodeM[1], nodeM[2]);

  return null;
}

// ============================================================
// [화면 설계서] screen-designer CRUD
// ============================================================
async function getSdProjects(event) {
  const user = verifyToken(event);
  const client = await getClient();
  try {
    let r;
    if (user) {
      r = await client.query(
        `SELECT sp.id, sp.title, sp.is_published, sp.updated_at, u.name AS author_name
         FROM sd_projects sp JOIN users u ON u.id = sp.user_id
         WHERE sp.user_id=$1 ORDER BY sp.updated_at DESC`, [user.userId]);
    } else {
      r = await client.query(
        `SELECT sp.id, sp.title, sp.is_published, sp.updated_at, u.name AS author_name
         FROM sd_projects sp JOIN users u ON u.id = sp.user_id
         WHERE sp.is_published=TRUE ORDER BY sp.updated_at DESC`);
    }
    return { statusCode: 200, body: { projects: r.rows, isOwner: !!user } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function getSdProjectById(event, id) {
  const user = verifyToken(event);
  const client = await getClient();
  try {
    const r = await client.query(
      `SELECT sp.id, sp.title, sp.is_published, sp.updated_at, u.name AS author_name,
              (sp.user_id=$2) AS is_owner
       FROM sd_projects sp JOIN users u ON u.id=sp.user_id WHERE sp.id=$1`,
      [id, user?.userId || 0]);
    if (!r.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    const proj = r.rows[0];
    if (!proj.is_owner && !proj.is_published) return { statusCode: 403, body: { error: '비공개 프로젝트입니다.' } };
    return { statusCode: 200, body: { project: proj } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function createSdProject(event, body) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const r = await client.query(
      `INSERT INTO sd_projects (user_id, title) VALUES ($1,$2) RETURNING id, title, updated_at`,
      [user.userId, String(body.title || '새 화면 설계서').slice(0, 200)]);
    return { statusCode: 201, body: { project: r.rows[0] } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function updateSdProject(event, body, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const cur = await client.query('SELECT user_id FROM sd_projects WHERE id=$1', [id]);
    if (!cur.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    if (cur.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '권한이 없습니다.' } };
    const sets = [], vals = []; let i = 1;
    if (body.title !== undefined) { sets.push(`title=$${i++}`); vals.push(String(body.title).slice(0, 200)); }
    if (!sets.length) return { statusCode: 400, body: { error: '변경할 내용이 없습니다.' } };
    sets.push('updated_at=NOW()'); vals.push(id);
    const r = await client.query(`UPDATE sd_projects SET ${sets.join(',')} WHERE id=$${i} RETURNING id,title,updated_at`, vals);
    return { statusCode: 200, body: { project: r.rows[0] } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function deleteSdProject(event, id) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const cur = await client.query('SELECT user_id FROM sd_projects WHERE id=$1', [id]);
    if (!cur.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    if (cur.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '권한이 없습니다.' } };
    await client.query('DELETE FROM sd_projects WHERE id=$1', [id]);
    return { statusCode: 200, body: { ok: true } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function publishSdProject(event, id, isPublish) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const r = await client.query(
      `UPDATE sd_projects SET is_published=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id,title,is_published`,
      [isPublish, id, user.userId]);
    if (!r.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    return { statusCode: 200, body: { project: r.rows[0] } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function getSdNodes(event, pid) {
  const user = verifyToken(event);
  const client = await getClient();
  try {
    const projR = await client.query('SELECT user_id, is_published FROM sd_projects WHERE id=$1', [pid]);
    if (!projR.rows.length) return { statusCode: 404, body: { error: '프로젝트를 찾을 수 없습니다.' } };
    const isOwner = user && projR.rows[0].user_id === user.userId;
    if (!isOwner && !projR.rows[0].is_published) return { statusCode: 403, body: { error: '비공개 프로젝트입니다.' } };
    const r = await client.query(
      'SELECT id, parent_id, position, title, components FROM sd_nodes WHERE project_id=$1 ORDER BY position', [pid]);
    return { statusCode: 200, body: { nodes: r.rows } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function createSdNode(event, body, pid) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const parentId = body.parent_id != null ? body.parent_id : null;
    const posR = await client.query(
      `SELECT COALESCE(MAX(position),-1)+1 AS pos FROM sd_nodes WHERE user_id=$1 AND project_id=$2 AND parent_id IS NOT DISTINCT FROM $3`,
      [user.userId, pid, parentId]);
    const r = await client.query(
      `INSERT INTO sd_nodes (user_id,project_id,parent_id,position,title) VALUES ($1,$2,$3,$4,$5)
       RETURNING id,parent_id,position,title,components`,
      [user.userId, pid, parentId, posR.rows[0].pos, String(body.title || '새 화면').slice(0, 200)]);
    return { statusCode: 201, body: { node: r.rows[0] } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function updateSdNode(event, body, pid, nid) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const sets = [], vals = [user.userId, pid, nid]; let i = 4;
    if (body.title      !== undefined) { sets.push(`title=$${i++}`);      vals.push(String(body.title).slice(0, 200)); }
    if (body.components !== undefined) { sets.push(`components=$${i++}`); vals.push(JSON.stringify(body.components)); }
    if (!sets.length) return { statusCode: 400, body: { error: '변경할 내용이 없습니다.' } };
    sets.push('updated_at=NOW()');
    await client.query(`UPDATE sd_nodes SET ${sets.join(',')} WHERE user_id=$1 AND project_id=$2 AND id=$3`, vals);
    return { statusCode: 200, body: { ok: true } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function deleteSdNode(event, pid, nid) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    await client.query('DELETE FROM sd_nodes WHERE user_id=$1 AND project_id=$2 AND id=$3', [user.userId, pid, nid]);
    return { statusCode: 200, body: { ok: true } };
  } catch (e) { return { statusCode: 500, body: { error: e.message } }; }
  finally { await client.end(); }
}

async function routeScreenDesigner(event, body, method, path) {
  if (path === '/screen-designer/projects' && method === 'GET')  return getSdProjects(event);
  if (path === '/screen-designer/projects' && method === 'POST') return createSdProject(event, body);

  const pubM = path.match(/^\/screen-designer\/projects\/(\d+)\/(publish|unpublish)$/);
  if (pubM && method === 'PUT') return publishSdProject(event, pubM[1], pubM[2] === 'publish');

  const projM = path.match(/^\/screen-designer\/projects\/(\d+)$/);
  if (projM && method === 'GET')    return getSdProjectById(event, projM[1]);
  if (projM && method === 'PUT')    return updateSdProject(event, body, projM[1]);
  if (projM && method === 'DELETE') return deleteSdProject(event, projM[1]);

  const nodesM = path.match(/^\/screen-designer\/projects\/(\d+)\/nodes$/);
  if (nodesM && method === 'GET')  return getSdNodes(event, nodesM[1]);
  if (nodesM && method === 'POST') return createSdNode(event, body, nodesM[1]);

  const nodeM = path.match(/^\/screen-designer\/projects\/(\d+)\/nodes\/(\d+)$/);
  if (nodeM && method === 'PUT')    return updateSdNode(event, body, nodeM[1], nodeM[2]);
  if (nodeM && method === 'DELETE') return deleteSdNode(event, nodeM[1], nodeM[2]);

  return null;
}

// ============================================================
// [웹소설작성] 기준정보 / AI 다듬기
// ============================================================
async function getRefInfo(event, body, novelId) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const client = await getClient();
  try {
    const r = await client.query(
      'SELECT ref_info, ref_summary FROM nw_projects WHERE id=$1 AND user_id=$2', [novelId, user.userId]
    );
    if (!r.rows.length) return { statusCode: 404, body: { error: '소설을 찾을 수 없습니다.' } };
    return { statusCode: 200, body: { ref_info: r.rows[0].ref_info || {}, ref_summary: r.rows[0].ref_summary || '' } };
  } finally { await client.end(); }
}

async function saveRefInfo(event, body, novelId) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { characters, tech, plot, goals, style, files } = body;
  const client = await getClient();
  try {
    const check = await client.query('SELECT id FROM nw_projects WHERE id=$1 AND user_id=$2', [novelId, user.userId]);
    if (!check.rows.length) return { statusCode: 404, body: { error: '소설을 찾을 수 없습니다.' } };

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
      const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const sm = await ai.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 800,
        messages: [{ role: 'user', content: `다음 소설 기준정보를 AI가 글 작성 시 참고할 수 있게 핵심만 간결히 요약하세요. 요약만 출력.\n\n${parts.join('\n\n')}` }]
      });
      summary = sm.content[0].text.trim();
    }

    await client.query(
      'UPDATE nw_projects SET ref_info=$1, ref_summary=$2, updated_at=NOW() WHERE id=$3',
      [JSON.stringify(refInfo), summary, novelId]
    );
    return { statusCode: 200, body: { summary } };
  } catch (e) { console.error(e); return { statusCode: 500, body: { error: '서버 오류' } }; }
  finally { await client.end(); }
}

async function polishNodeContent(event, body, nodeId) {
  const user = verifyToken(event);
  if (!user) return { statusCode: 401, body: { error: '인증이 필요합니다.' } };
  const { guide, content: reqContent } = body;
  const client = await getClient();
  try {
    const nr = await client.query(
      'SELECT nn.content, n.user_id, n.ref_summary FROM nw_nodes nn JOIN nw_projects n ON nn.novel_id=n.id WHERE nn.id=$1',
      [nodeId]
    );
    if (!nr.rows.length) return { statusCode: 404, body: { error: '노드를 찾을 수 없습니다.' } };
    if (nr.rows[0].user_id !== user.userId) return { statusCode: 403, body: { error: '권한이 없습니다.' } };

    const content = reqContent?.trim() || nr.rows[0].content?.trim();
    const { ref_summary } = nr.rows[0];
    if (!content) return { statusCode: 400, body: { error: '내용이 없습니다.' } };

    const systemTxt = ref_summary
      ? `당신은 전문 웹소설 작가입니다.\n\n[소설 기준정보]\n${ref_summary}`
      : '당신은 전문 웹소설 작가입니다.';
    const guideNote = guide ? `\n가이드: ${guide}` : '';
    const userTxt   = `다음 글을 웹소설 작가답게 자연스럽게 다듬어주세요.${guideNote}\n다듬은 글만 출력하세요.\n\n[원문]\n${content}`;

    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await ai.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4000,
      system: systemTxt,
      messages: [{ role: 'user', content: userTxt }]
    });
    return { statusCode: 200, body: { content: msg.content[0].text.trim() } };
  } catch (e) { console.error(e); return { statusCode: 500, body: { error: '서버 오류' } }; }
  finally { await client.end(); }
}

// ============================================================
// [기사작성/웹소설작성] 정규식 기반 동적 라우터
// (기존 dispatcher의 exact-match에서 처리하지 못하는 path-param + method 라우트)
// ============================================================
async function routeArticleNovel(event, body, method, path) {
  // ── 마이페이지 설정 ──
  if (path === '/mypage' && method === 'GET') return getMypage(event);
  if (path === '/mypage/article-style' && method === 'POST') return saveArticleStyle(event, body);
  if (path === '/mypage/section-guides' && method === 'GET')  return getSectionGuides(event);
  if (path === '/mypage/section-guides' && method === 'POST') return saveSectionGuide(event, body);
  if (path === '/mypage/section-labels' && method === 'POST') return saveSectionLabel(event, body);

  // ── 이슈 CRUD ──
  if (path === '/issues' && method === 'GET') return getIssues(event);
  if (path === '/issues' && method === 'POST') return createIssue(event, body);

  const issueM        = path.match(/^\/issues\/(\d+)$/);
  const sectionsM     = path.match(/^\/issues\/(\d+)\/sections$/);
  const sectionM      = path.match(/^\/issues\/(\d+)\/sections\/(\d+)$/);
  const searchRelatedM= path.match(/^\/issues\/(\d+)\/search-related$/);
  const aiWriteSecM   = path.match(/^\/issues\/(\d+)\/sections\/(\d+)\/ai-write$/);
  const autoSectionsM = path.match(/^\/issues\/(\d+)\/auto-sections$/);

  if (aiWriteSecM    && method === 'POST')   return aiWriteSection(event, body, aiWriteSecM[1], aiWriteSecM[2]);
  if (sectionM       && method === 'PUT')    return saveSection(event, body, sectionM[1], sectionM[2]);
  if (issueM         && method === 'GET')    return getIssue(event, body, issueM[1]);
  if (issueM         && method === 'PUT')    return updateIssue(event, body, issueM[1]);
  if (issueM         && method === 'DELETE') return deleteIssue(event, body, issueM[1]);
  if (sectionsM      && method === 'POST')   return saveSections(event, body, sectionsM[1]);
  if (searchRelatedM && method === 'POST')   return searchRelated(event, body, searchRelatedM[1]);
  if (autoSectionsM  && method === 'POST')   return autoFillSections(event, body, autoSectionsM[1]);

  // ── AI 주제/기사 생성 ──
  if (path === '/topics/ai' && method === 'POST') return aiTopic(event, body);
  if (path === '/generate'  && method === 'POST') return generateArticle(event, body);

  // ── 웹소설: 소설 CRUD ──
  if (path === '/novel/novels' && method === 'GET')  return getNovels(event);
  if (path === '/novel/novels' && method === 'POST') return createNovel(event, body);

  const novelM      = path.match(/^\/novel\/novels\/(\d+)$/);
  const novelNodesM = path.match(/^\/novel\/novels\/(\d+)\/nodes$/);
  const novelNodeIdM= path.match(/^\/novel\/nodes\/(\d+)$/);
  const novelRefM   = path.match(/^\/novel\/novels\/(\d+)\/refinfo$/);
  const novelPolishM= path.match(/^\/novel\/nodes\/(\d+)\/polish$/);

  if (novelM         && method === 'GET')    return getNovel(event, body, novelM[1]);
  if (novelM         && method === 'PUT')    return updateNovel(event, body, novelM[1]);
  if (novelM         && method === 'DELETE') return deleteNovel(event, body, novelM[1]);

  // ── 웹소설: 메뉴 노드(트리) / 기준정보 / AI 다듬기 ──
  if (novelNodesM  && method === 'GET')    return getNovelNodes(event, body, novelNodesM[1]);
  if (novelNodesM  && method === 'POST')   return createNovelNode(event, body, novelNodesM[1]);
  if (novelNodeIdM && method === 'PUT')    return updateNovelNode(event, body, novelNodeIdM[1]);
  if (novelNodeIdM && method === 'DELETE') return deleteNovelNode(event, body, novelNodeIdM[1]);
  if (novelRefM    && method === 'GET')    return getRefInfo(event, body, novelRefM[1]);
  if (novelRefM    && method === 'PUT')    return saveRefInfo(event, body, novelRefM[1]);
  if (novelPolishM && method === 'POST')   return polishNodeContent(event, body, novelPolishM[1]);

  return null;
}

// ── Handler ──────────────────────────────────────────────────

/* ============================================================
 * article 백엔드에서 옮겨온 라우트 — 댓글 · 반응 · 공동편집자 · 북마크
 *
 * workKit 화면은 이 경로들을 부르는데 workKit 백엔드에는 구현이 없었다
 * (호출하면 404 라 그동안 동작하지 않던 기능들이다).
 * 원래 issues / novels 테이블을 보던 것을 aw_projects / nw_projects 로 맞췄다.
 * 이 구역만 pool 과 resp() 를 쓴다.
 * ============================================================ */

function resp(code, body) {
  return { statusCode: code, headers: HEADERS, body: JSON.stringify(body) };
}
function getBodyAr(e) {
  if (!e.body) return {};
  try { return JSON.parse(e.body); } catch { return {}; }
}
// 토큰 payload 키가 article 은 id, workKit 은 userId 였다. 양쪽을 다 받는다.
function verifyTokenAr(e) {
  const auth = e.headers?.authorization || e.headers?.Authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return { ...p, id: p.id ?? p.userId };
  } catch { return null; }
}

async function setEditor(event, id) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { section_no, email } = getBodyAr(event);
  if (!section_no || !email) return resp(400, { error: '섹션 번호와 이메일을 입력하세요.' });
  try {
    const check = await pool.query('SELECT user_id FROM aw_projects WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '작성자만 편집자를 지정할 수 있습니다.' });

    const target = await pool.query('SELECT id, name FROM users WHERE email=$1', [email]);
    if (!target.rows.length) return resp(404, { error: '해당 이메일의 사용자가 없습니다.' });
    const editor = target.rows[0];

    await pool.query(
      `INSERT INTO aw_section_editors (issue_id, section_no, user_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (issue_id, section_no) DO UPDATE SET user_id=$3`,
      [id, section_no, editor.id]
    );
    return resp(200, { editor: { user_id: editor.id, name: editor.name, email } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function removeEditor(event, id, sectionNo) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const check = await pool.query('SELECT user_id FROM aw_projects WHERE id=$1', [id]);
    if (!check.rows.length) return resp(404, { error: '이슈를 찾을 수 없습니다.' });
    if (check.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });
    await pool.query(
      'DELETE FROM aw_section_editors WHERE issue_id=$1 AND section_no=$2', [id, sectionNo]
    );
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function reactIssue(event, issueId) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { reaction } = getBodyAr(event);
  if (!['like', 'dislike'].includes(reaction)) return resp(400, { error: '잘못된 요청' });
  try {
    const cur = await pool.query(
      'SELECT reaction FROM aw_reactions WHERE issue_id=$1 AND user_id=$2', [issueId, user.id]
    );
    if (cur.rows.length && cur.rows[0].reaction === reaction) {
      await pool.query('DELETE FROM aw_reactions WHERE issue_id=$1 AND user_id=$2', [issueId, user.id]);
    } else {
      await pool.query(
        `INSERT INTO aw_reactions (issue_id, user_id, reaction) VALUES($1,$2,$3)
         ON CONFLICT (issue_id, user_id) DO UPDATE SET reaction=$3`,
        [issueId, user.id, reaction]
      );
    }
    const c = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
      FROM aw_reactions WHERE issue_id=$2
    `, [user.id, issueId]);
    return resp(200, c.rows[0]);
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getComments(event, issueId) {
  const user = verifyTokenAr(event);
  const uid  = user?.id || -1;
  try {
    const r = await pool.query(`
      SELECT c.id, c.content, c.created_at, u.name AS author, c.user_id,
        COALESCE(SUM(CASE WHEN cr.reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN cr.reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN cr.user_id=$1 THEN cr.reaction END) AS my_reaction
      FROM aw_comments c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN aw_comment_reactions cr ON cr.comment_id = c.id
      WHERE c.issue_id = $2
      GROUP BY c.id, u.name, c.user_id
      ORDER BY c.created_at ASC
    `, [uid, issueId]);
    return resp(200, { comments: r.rows });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function createComment(event, issueId) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { content } = getBodyAr(event);
  if (!content?.trim()) return resp(400, { error: '내용을 입력하세요.' });
  try {
    const r = await pool.query(
      'INSERT INTO aw_comments (issue_id, user_id, content) VALUES($1,$2,$3) RETURNING id, content, created_at',
      [issueId, user.id, content.trim()]
    );
    return resp(201, { comment: { ...r.rows[0], author: user.name, user_id: user.id, likes: 0, dislikes: 0, my_reaction: null } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function deleteComment(event, commentId) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query('SELECT user_id FROM aw_comments WHERE id=$1', [commentId]);
    if (!r.rows.length) return resp(404, { error: '댓글을 찾을 수 없습니다.' });
    if (r.rows[0].user_id !== user.id) return resp(403, { error: '삭제 권한이 없습니다.' });
    await pool.query('DELETE FROM aw_comments WHERE id=$1', [commentId]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function reactComment(event, commentId) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { reaction } = getBodyAr(event);
  if (!['like', 'dislike'].includes(reaction)) return resp(400, { error: '잘못된 요청' });
  try {
    const cur = await pool.query(
      'SELECT reaction FROM aw_comment_reactions WHERE comment_id=$1 AND user_id=$2', [commentId, user.id]
    );
    if (cur.rows.length && cur.rows[0].reaction === reaction) {
      await pool.query('DELETE FROM aw_comment_reactions WHERE comment_id=$1 AND user_id=$2', [commentId, user.id]);
    } else {
      await pool.query(
        `INSERT INTO aw_comment_reactions (comment_id, user_id, reaction) VALUES($1,$2,$3)
         ON CONFLICT (comment_id, user_id) DO UPDATE SET reaction=$3`,
        [commentId, user.id, reaction]
      );
    }
    const c = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
      FROM aw_comment_reactions WHERE comment_id=$2
    `, [user.id, commentId]);
    return resp(200, c.rows[0]);
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getBookmarks(event) {
  const user = verifyTokenAr(event);
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
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { name } = getBodyAr(event);
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
  const user = verifyTokenAr(event);
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
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  const { url, title } = getBodyAr(event);
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
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query('SELECT user_id FROM link_bookmarks WHERE id=$1', [linkId]);
    if (!r.rows.length) return resp(404, { error: '링크를 찾을 수 없습니다.' });
    if (r.rows[0].user_id !== user.id) return resp(403, { error: '권한이 없습니다.' });
    await pool.query('DELETE FROM link_bookmarks WHERE id=$1', [linkId]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function reactNovel(event, novelId) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { reaction } = getBodyAr(event);
  if (!['like', 'dislike'].includes(reaction)) return resp(400, { error: '잘못된 요청' });
  try {
    const cur = await pool.query(
      'SELECT reaction FROM nw_reactions WHERE novel_id=$1 AND user_id=$2', [novelId, user.id]
    );
    if (cur.rows.length && cur.rows[0].reaction === reaction) {
      await pool.query('DELETE FROM nw_reactions WHERE novel_id=$1 AND user_id=$2', [novelId, user.id]);
    } else {
      await pool.query(
        `INSERT INTO nw_reactions (novel_id, user_id, reaction) VALUES($1,$2,$3)
         ON CONFLICT (novel_id, user_id) DO UPDATE SET reaction=$3`,
        [novelId, user.id, reaction]
      );
    }
    const c = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
      FROM nw_reactions WHERE novel_id=$2
    `, [user.id, novelId]);
    return resp(200, c.rows[0]);
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function getNovelComments(event, novelId) {
  const user = verifyTokenAr(event);
  const uid  = user?.id || -1;
  try {
    const r = await pool.query(`
      SELECT c.id, c.content, c.created_at, u.name AS author, c.user_id,
        COALESCE(SUM(CASE WHEN cr.reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN cr.reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN cr.user_id=$1 THEN cr.reaction END) AS my_reaction
      FROM nw_comments c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN nw_comment_reactions cr ON cr.comment_id = c.id
      WHERE c.novel_id = $2
      GROUP BY c.id, u.name, c.user_id
      ORDER BY c.created_at ASC
    `, [uid, novelId]);
    return resp(200, { comments: r.rows });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function createNovelComment(event, novelId) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { content } = getBodyAr(event);
  if (!content?.trim()) return resp(400, { error: '내용을 입력하세요.' });
  try {
    const r = await pool.query(
      'INSERT INTO nw_comments (novel_id, user_id, content) VALUES($1,$2,$3) RETURNING id, content, created_at',
      [novelId, user.id, content.trim()]
    );
    return resp(201, { comment: { ...r.rows[0], author: user.name, user_id: user.id, likes: 0, dislikes: 0, my_reaction: null } });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function deleteNovelComment(event, commentId) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '인증이 필요합니다.' });
  try {
    const r = await pool.query('SELECT user_id FROM nw_comments WHERE id=$1', [commentId]);
    if (!r.rows.length) return resp(404, { error: '댓글을 찾을 수 없습니다.' });
    if (r.rows[0].user_id !== user.id) return resp(403, { error: '삭제 권한이 없습니다.' });
    await pool.query('DELETE FROM nw_comments WHERE id=$1', [commentId]);
    return resp(200, { ok: true });
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function reactNovelComment(event, commentId) {
  const user = verifyTokenAr(event);
  if (!user) return resp(401, { error: '로그인이 필요합니다.' });
  const { reaction } = getBodyAr(event);
  if (!['like', 'dislike'].includes(reaction)) return resp(400, { error: '잘못된 요청' });
  try {
    const cur = await pool.query(
      'SELECT reaction FROM nw_comment_reactions WHERE comment_id=$1 AND user_id=$2', [commentId, user.id]
    );
    if (cur.rows.length && cur.rows[0].reaction === reaction) {
      await pool.query('DELETE FROM nw_comment_reactions WHERE comment_id=$1 AND user_id=$2', [commentId, user.id]);
    } else {
      await pool.query(
        `INSERT INTO nw_comment_reactions (comment_id, user_id, reaction) VALUES($1,$2,$3)
         ON CONFLICT (comment_id, user_id) DO UPDATE SET reaction=$3`,
        [commentId, user.id, reaction]
      );
    }
    const c = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END),0)::int AS likes,
        COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END),0)::int AS dislikes,
        MAX(CASE WHEN user_id=$1 THEN reaction END) AS my_reaction
      FROM nw_comment_reactions WHERE comment_id=$2
    `, [user.id, commentId]);
    return resp(200, c.rows[0]);
  } catch (e) { console.error(e); return resp(500, { error: '서버 오류' }); }
}

async function routeSocial(event, method, path) {
  const editorsM     = path.match(/^\/issues\/(\d+)\/editors$/);
  const editorM      = path.match(/^\/issues\/(\d+)\/editors\/(\d+)$/);
  const issueReactM  = path.match(/^\/issues\/(\d+)\/react$/);
  const commentM     = path.match(/^\/issues\/(\d+)\/comments$/);
  const commentIdM   = path.match(/^\/comments\/(\d+)$/);
  const commentReactM= path.match(/^\/comments\/(\d+)\/react$/);

  if (editorsM     && method === 'POST')   return setEditor(event, editorsM[1]);
  if (editorM      && method === 'DELETE') return removeEditor(event, editorM[1], editorM[2]);
  if (issueReactM  && method === 'POST')   return reactIssue(event, issueReactM[1]);
  if (commentM     && method === 'GET')    return getComments(event, commentM[1]);
  if (commentM     && method === 'POST')   return createComment(event, commentM[1]);
  if (commentIdM   && method === 'DELETE') return deleteComment(event, commentIdM[1]);
  if (commentReactM&& method === 'POST')   return reactComment(event, commentReactM[1]);

  const folderM      = path.match(/^\/bookmarks\/folders\/(\d+)$/);
  const folderLinksM = path.match(/^\/bookmarks\/folders\/(\d+)\/links$/);
  const linkM        = path.match(/^\/bookmarks\/links\/(\d+)$/);
  if (path === '/bookmarks'         && method === 'GET')    return getBookmarks(event);
  if (path === '/bookmarks/folders' && method === 'POST')   return createFolder(event);
  if (folderM      && method === 'DELETE') return deleteFolder(event, folderM[1]);
  if (folderLinksM && method === 'POST')   return addLink(event, folderLinksM[1]);
  if (linkM        && method === 'DELETE') return deleteLink(event, linkM[1]);

  const novelReactM    = path.match(/^\/novel\/novels\/(\d+)\/react$/);
  const novelComM      = path.match(/^\/novel\/novels\/(\d+)\/comments$/);
  const novelComIdM    = path.match(/^\/novel\/comments\/(\d+)$/);
  const novelComReactM = path.match(/^\/novel\/comments\/(\d+)\/react$/);
  if (novelReactM    && method === 'POST')   return reactNovel(event, novelReactM[1]);
  if (novelComM      && method === 'GET')    return getNovelComments(event, novelComM[1]);
  if (novelComM      && method === 'POST')   return createNovelComment(event, novelComM[1]);
  if (novelComIdM    && method === 'DELETE') return deleteNovelComment(event, novelComIdM[1]);
  if (novelComReactM && method === 'POST')   return reactNovelComment(event, novelComReactM[1]);

  return null;
}

async function routeWorkKit(event, method, path, ip) {

  try {
    const body = JSON.parse(event.body || '{}');
    let result;
    if (path === '/auth/register') result = await register(body);
    else if (path === '/auth/login') result = await login(body, ip);
    else if (path === '/auth/check-email') result = await checkEmail(body);
    else if (path === '/auth/forgot-password')  result = await forgotPassword(body);
    else if (path === '/auth/reset-password')   result = await resetPassword(body);
    else if (path === '/auth/change-password')  result = await changePassword(event, body);
    else if (path === '/auth/send-verify-code') result = await sendVerifyCode(body);
    else if (path === '/auth/verify-code') result = await verifyCode(body);
    else if (path === '/data/save') result = await saveData(event, body);
    else if (path === '/data/list') result = await listData(event, body);
    else if (path === '/data/delete') result = await deleteData(event, body);
    else if (path === '/data/load') result = await loadData(event, body);
    else if (path === '/data/share') result = await shareData(event, body);
    else if (path === '/data/share-now') result = await shareNow(event, body);
    else if (path === '/data/public') result = await publicLoad(body);
    else if (path === '/data/update') result = await updateData(event, body);
    else if (path === '/data/meta') result = await getMeta(body);
    else if (path === '/data/share-collab') result = await shareCollab(event, body);
    else if (path === '/data/public-collab') result = await publicCollabLoad(body);
    else if (path === '/data/collab-save') result = await collabSave(event, body);
    else if (path === '/ai/chat') result = await aiChat(event, body);
    else if (path === '/ai/summary/save')   result = await summarySave(event, body);
    else if (path === '/ai/summary/list')   result = await summaryList(event, body);
    else if (path === '/ai/summary/get')    result = await summaryGet(event, body);
    else if (path === '/ai/summary/delete') result = await summaryDelete(event, body);
    else if (path === '/ai/summary/rename') result = await summaryRename(event, body);
    else if (path === '/ai/summary/lock')   result = await summaryLock(event, body);
    else if (path === '/ai/summary/share')  result = await summaryShare(event, body);
    else if (path === '/ai/summary/merge')       result = await summaryMerge(event, body);
    else if (path === '/ai/summary/file/upload') result = await summaryFileUpload(event, body);
    else if (path === '/ai/summary/file/list')   result = await summaryFileList(event, body);
    else if (path === '/ai/summary/file/delete') result = await summaryFileDelete(event, body);
    else if (path === '/ai/summary/file/get')    result = await summaryFileGet(event, body);
    else {
      result = await routeArticleNovel(event, body, method, path);
      if (!result) result = await routeVideoMaker(event, body, method, path);
      if (!result) result = await routeScreenDesigner(event, body, method, path);
      if (!result) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    }

    return { statusCode: result.statusCode, headers: HEADERS, body: JSON.stringify(result.body) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: '서버 오류' }) };
  }
}

/* ============================================================
 * 진입점
 * ============================================================ */
exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
  const path   = event.rawPath || event.requestContext?.http?.path || event.path || '';
  const ip     = event.requestContext?.http?.sourceIp || null;

  if (method === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  // [PGO 분석기] pgo_ 테이블만 다루는 독립 모듈
  if (path.startsWith('/pgo/')) {
    const pgoRes = await pgo.route({ pool, resp, getBody: getBodyAr }, event, method, path);
    if (pgoRes) return pgoRes;
  }

  try {
    // workKit 백엔드에 없던 라우트(댓글·반응·북마크)를 먼저 본다
    const social = await routeSocial(event, method, path);
    if (social) return social;

    return await routeWorkKit(event, method, path, ip);
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
