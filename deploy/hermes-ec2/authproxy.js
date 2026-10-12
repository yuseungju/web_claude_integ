/**
 * hermes proxy 앞에 세우는 인증 프록시.
 *
 * `hermes proxy` 는 "any bearer token" 을 받는다 — 즉 자체 인증이 없다.
 * 0.0.0.0 으로 열면 주소를 아는 누구나 내 Nous 계정으로 추론을 돌릴 수 있다.
 * 그래서 공개 포트는 이 프록시가 잡고, 공유 비밀값이 맞을 때만 뒤로 넘긴다.
 *
 *   외부 :8646  →  이 파일(토큰 검사)  →  127.0.0.1:8645 (hermes proxy)
 *
 * 환경변수
 *   PROXY_TOKEN    (필수) Lambda 와 나눠 갖는 비밀값
 *   UPSTREAM_PORT  기본 8645
 *   LISTEN_PORT    기본 8646
 */
const http = require('node:http');

const TOKEN    = process.env.PROXY_TOKEN || '';
const UP_PORT  = Number(process.env.UPSTREAM_PORT) || 8645;
const PORT     = Number(process.env.LISTEN_PORT) || 8646;

if (!TOKEN || TOKEN.length < 24) {
  console.error('PROXY_TOKEN 이 없거나 너무 짧습니다(24자 이상). 종료합니다.');
  process.exit(1);
}

/** 타이밍 공격을 피해 길이를 먼저 비교하고 상수시간 비교한다. */
const crypto = require('node:crypto');
function tokenOk(v) {
  if (!v) return false;
  const a = Buffer.from(v), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (!tokenOk(req.headers['x-proxy-token'])) {
    console.warn(`[deny] ${req.socket.remoteAddress} ${req.method} ${req.url}`);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  // hermes proxy 는 bearer 를 무시하고 자기 자격증명을 붙인다.
  const headers = { ...req.headers, authorization: 'Bearer local', host: '127.0.0.1:' + UP_PORT };
  delete headers['x-proxy-token'];

  const up = http.request(
    { host: '127.0.0.1', port: UP_PORT, path: req.url, method: req.method, headers },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    }
  );
  up.on('error', (e) => {
    console.error('[upstream]', e.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'hermes proxy 에 연결할 수 없습니다: ' + e.message }));
  });
  // 분석 요청은 오래 걸릴 수 있다. API Gateway 29초보다는 길게 둔다.
  up.setTimeout(120000, () => up.destroy(new Error('upstream timeout')));
  req.pipe(up);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`인증 프록시 :${PORT} → hermes proxy 127.0.0.1:${UP_PORT}`);
});
