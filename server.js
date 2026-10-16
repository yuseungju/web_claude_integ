/**
 * 로컬 개발 서버 — 배포와 같은 구조로 dist/ 를 서빙한다.
 *
 *   npm run build && npm start     ->  http://localhost:3000
 *
 * dist/ 는 scripts/build-site.js 가 apps/<앱>/public 에서 조립한다.
 * 앱 코드를 고쳤으면 build 를 다시 돌려야 반영된다.
 *
 * /sap/* 는 배포된 Lambda 와 같은 코드(lambda/sap.js)를 여기서 그대로 돌린다.
 * 고칠 때마다 push → Actions → 배포를 기다리지 않고 바로 확인하기 위해서다.
 * DynamoDB 는 VPC 밖 퍼블릭 엔드포인트라 이 PC 에서도 같은 테이블에 붙는다
 * (AWS 자격증명 필요 — `node scripts/db-check.js` 로 확인).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

/* .env 를 읽는다. 키를 셸에 매번 export 하다 보면 결국 명령줄에 비밀번호를
   남기게 된다. dotenv 를 받기보다 열 줄로 끝내는 편이 의존성이 적다.
   이미 환경에 있는 값은 덮지 않는다 — 배포 환경의 설정이 우선이다. */
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
  console.log('[env] .env 를 읽었습니다');
})();

const app = express();
const PORT = process.env.PORT || 3000;
const DIST = path.join(__dirname, 'dist');

if (!fs.existsSync(DIST)) {
  console.error('dist/ 가 없습니다. 먼저 `npm run build` 를 실행하세요.');
  process.exit(1);
}

/* ── /sap/* · /agent/* — 배포본과 같은 핸들러를 로컬에서 ── */
let sap = null;
let agent = null;
try {
  sap = require('./lambda/sap');
  agent = require('./lambda/agent');
} catch (e) {
  console.warn('[api] 로컬 API 를 못 올렸습니다: ' + e.message);
  console.warn('[api] lambda 폴더에서 `npm install` 을 한 번 돌리세요.');
}

/* 화면을 먼저 내보낸다.
   배포에서는 화면(Amplify)과 API(API Gateway)가 다른 주소라 겹칠 일이 없는데,
   로컬에서는 한 서버가 둘 다 맡는다. /agent/ 와 /sap/ 은 앱의 URL 이면서
   API 의 접두사이기도 해서, API 를 먼저 걸면 페이지를 열었을 때 화면 대신
   {"error":...} 가 나온다.
   express.static 은 해당 파일이 없으면 next() 로 넘기므로, 먼저 두어도
   /agent/docs 같은 API 는 그대로 아래 핸들러로 내려간다. */
app.use(express.static(DIST));

if (sap) {
  // 도구 결과까지 실린 대화는 수 MB 가 된다. express 기본값 100kb 로는 막힌다.
  app.use(['/sap', '/agent'], express.json({ limit: '12mb' }));

  // Lambda 가 주는 모양만 흉내 낸다 — 핸들러 자체는 손대지 않는다
  const bridge = (run) => async (req, res) => {
    const resp = (code, obj) => ({ code, obj });
    const getBody = () => req.body || {};
    const event = { queryStringParameters: req.query || {} };
    try {
      const out = await run({ resp, getBody }, event, req.method, req.path);
      if (!out) return res.status(404).json({ error: '알 수 없는 경로' });
      res.status(out.code).json(out.obj);
    } catch (e) {
      console.error('[api] ' + req.method + ' ' + req.path + ' 실패:', e.message);
      res.status(500).json({ error: e.message, name: e.name });
    }
  };

  app.all('/sap/*', bridge((ctx, ev, m, p) => sap.route(ctx, ev, m, p)));

  if (agent) {
    app.all('/agent/*', bridge((ctx, ev, m, p) => agent.route(
      { ddb: sap.ddb, callAI: sap.callAI, resp: ctx.resp, getBody: ctx.getBody }, ev, m, p)));
  }
}

/* /stay/* — 숙소 찾기. DynamoDB 를 쓰지 않으므로 sap 로드 여부와 무관하게 건다.
   앱 URL 과도 겹치지 않는다(apps/stay 는 없다). */
try {
  const stay = require('./lambda/stay');
  app.use('/stay', express.json({ limit: '1mb' }));
  app.all('/stay/*', async (req, res) => {
    try {
      const out = await stay.route(
        { resp: (code, obj) => ({ code, obj }) }, {}, req.path, req.body || {});
      if (!out) return res.status(404).json({ error: '알 수 없는 경로' });
      res.status(out.code).json(out.obj);
    } catch (e) {
      console.error('[stay] ' + req.method + ' ' + req.path + ' 실패:', e.message);
      res.status(500).json({ error: e.message, name: e.name });
    }
  });
} catch (e) {
  console.warn('[stay] 모듈을 불러오지 못했습니다 — ' + e.message);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, () => {
  const apps = fs.readdirSync(DIST, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => '/' + e.name + '/');
  console.log('Server running on http://localhost:' + PORT);
  console.log('  앱: ' + apps.join('  '));
  if (sap) {
    const ai = process.env.HERMES_URL && process.env.PROXY_TOKEN;
    console.log('  /sap/* 로컬 처리 · 지식(DynamoDB) 조회·수정 가능'
      + (ai ? ' · 모델 호출 가능' : ' · 모델 호출 불가 (HERMES_URL/PROXY_TOKEN 없음)'));
  }
});
