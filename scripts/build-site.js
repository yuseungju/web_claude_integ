/**
 * 배포용 정적 사이트 조립
 *   node scripts/build-site.js
 *
 * apps/<앱>/public/ 을 dist/<URL경로>/ 로 복사하고, 루트에 런처(site/index.html)를 둔다.
 * Amplify 는 dist/ 를 그대로 호스팅하므로 **디렉토리 구조가 곧 URL 구조**다.
 *
 * 앱을 추가하려면 apps/ 아래 디렉토리를 만들고 아래 APPS 에 한 줄 넣으면 된다.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** dir: apps/ 아래 디렉토리명, url: 배포될 경로(대소문자 그대로 URL 이 된다) */
const APPS = [
  { dir: 'nol', url: 'nol', title: 'SAP 업무 활용 정리',
    desc: '운영 · IMG Config · 프로세스 고도화 자료' },
  { dir: 'pgo', url: 'pgo', title: '사라님을 위한 포켓몬 쓸모분석',
    desc: '보유 판정 · 계열별 순위 · 일정 · 배틀 퀴즈' },
  { dir: 'workKit', url: 'workKit', title: 'Work Kit',
    desc: '기사·웹소설 작성, 일정 공유, 엑셀 비교 등 업무 도구 모음' },
  { dir: 'tennis', url: 'tennis', title: '대치유수지 예약 자동화',
    desc: '코트·시간 설정을 크롬 확장에 넘겨 예약을 자동화' },
];

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) n += copyDir(s, d);
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });

const built = [];
for (const app of APPS) {
  const src = path.join(ROOT, 'apps', app.dir, 'public');
  if (!fs.existsSync(src)) {
    console.error('[build] apps/' + app.dir + '/public 이 없습니다. 건너뜁니다.');
    continue;
  }
  const n = copyDir(src, path.join(DIST, app.url));
  built.push({ app, n });
  console.log('[build] /' + app.url + '/  <- apps/' + app.dir + '/public  (' + n + '개 파일)');
}

// 루트 런처 — 어떤 앱이 어디에 있는지 한 화면에 모은다
const launcher = path.join(ROOT, 'site', 'index.html');
if (fs.existsSync(launcher)) {
  const cards = built.map(({ app }) =>
    '      <a class="card" href="/' + app.url + '/">\n'
    + '        <span class="card-path">/' + app.url + '/</span>\n'
    + '        <span class="card-title">' + app.title + '</span>\n'
    + '        <span class="card-desc">' + app.desc + '</span>\n'
    + '      </a>').join('\n');
  const html = fs.readFileSync(launcher, 'utf8').replace('<!--APPS-->', cards);
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  console.log('[build] /            <- site/index.html (앱 ' + built.length + '개 링크)');
}

const total = built.reduce((a, b) => a + b.n, 0);
console.log('[build] 완료 — ' + built.length + '개 앱 / ' + total + '개 파일 -> dist/');
