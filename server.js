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

const app = express();
const PORT = process.env.PORT || 3000;
const DIST = path.join(__dirname, 'dist');

if (!fs.existsSync(DIST)) {
  console.error('dist/ 가 없습니다. 먼저 `npm run build` 를 실행하세요.');
  process.exit(1);
}

/* ── /sap/* — 배포본과 같은 핸들러를 로컬에서 ──────────── */
let sap = null;
try {
  sap = require('./lambda/sap');
} catch (e) {
  console.warn('[sap] 로컬 API 를 못 올렸습니다: ' + e.message);
  console.warn('[sap] lambda 폴더에서 `npm install` 을 한 번 돌리세요.');
}

if (sap) {
  // 도구 결과까지 실린 대화는 수 MB 가 된다. express 기본값 100kb 로는 막힌다.
  app.use('/sap', express.json({ limit: '12mb' }));

  app.all('/sap/*', async (req, res) => {
    // Lambda 가 주는 모양만 흉내 낸다 — 핸들러 자체는 손대지 않는다
    const ctx = {
      resp: (code, obj) => ({ code, obj }),
      getBody: () => req.body || {},
    };
    const event = { queryStringParameters: req.query || {} };
    try {
      const out = await sap.route(ctx, event, req.method, req.path);
      if (!out) return res.status(404).json({ error: '알 수 없는 /sap 경로' });
      res.status(out.code).json(out.obj);
    } catch (e) {
      console.error('[sap] ' + req.method + ' ' + req.path + ' 실패:', e.message);
      res.status(500).json({ error: e.message, name: e.name });
    }
  });
}

app.use(express.static(DIST));

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
