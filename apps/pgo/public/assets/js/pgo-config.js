/**
 * PGO 앱 설정.
 *
 * PGO_API_BASE 를 비워 두면 보관함이 브라우저 localStorage 에만 저장된다.
 * 백엔드(Lambda + RDS pgo_* 테이블)를 붙일 때 API Gateway 엔드포인트를 넣으면
 * 자동으로 서버 저장으로 전환된다. 끝에 슬래시는 붙이지 않는다.
 *
 *   window.PGO_API_BASE = 'https://xxxxxxxx.execute-api.ap-southeast-2.amazonaws.com';
 */
window.PGO_API_BASE = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';
