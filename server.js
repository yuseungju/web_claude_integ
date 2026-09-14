/**
 * 로컬 개발 서버 — 배포와 같은 구조로 dist/ 를 서빙한다.
 *
 *   npm run build && npm start     ->  http://localhost:3000
 *
 * dist/ 는 scripts/build-site.js 가 apps/<앱>/public 에서 조립한다.
 * 앱 코드를 고쳤으면 build 를 다시 돌려야 반영된다.
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

app.use(express.static(DIST));

app.get('/', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, () => {
  const apps = fs.readdirSync(DIST, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => '/' + e.name + '/');
  console.log('Server running on http://localhost:' + PORT);
  console.log('  앱: ' + apps.join('  '));
});
