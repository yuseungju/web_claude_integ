# web_claude_integ

한 저장소에 여러 웹앱이 들어 있고, 경로로 나뉘어 배포된다.
**디렉토리 구조가 곧 URL 구조다.**

## 🔴 DB 는 현재 없다 (2026-10-12 해지)

RDS 를 비용 때문에 끊었다(월 $24). **되살릴 계획 없이 끝낸 상태**이고,
DB 를 쓰는 기능은 고치지 않고 그대로 둔다 — 연결이 안 되면 그 기능만 실패한다.
이건 방치하기로 한 결정이지 버그가 아니다. **고치려 들지 말 것.**

### 사용자가 "DB 만들었어, 연결해줘" 라고 하면

[`db/README.md`](db/README.md) 의 **「다시 켜는 법」** 절을 그대로 따른다. 요점만:

1. **애플리케이션 코드는 한 줄도 고치지 않는다.** 접속이 전부 환경변수다
   (`lambda/index.js` 상단 `DB_CONFIG` → `DB_HOST` `DB_NAME` `DB_USER` `DB_PASSWORD` `DB_PORT`).
   PostgreSQL 이기만 하면 RDS·Neon·Supabase 어디든 붙는다.
2. **스키마를 먼저 올려야 한다.** 빈 DB 에 연결만 하면 테이블이 없어서 전부 실패한다.
   ```bash
   npm run db:build     # db/schema_all.sql 재생성 (테이블 32개)
   ```
   생성된 `db/schema_all.sql` 을 DB 콘솔에 붙여넣거나 `node db/migrate.js` 로 적용.
   전부 `IF NOT EXISTS` 라 여러 번 돌려도 안전하다.
3. **환경변수 4개**를 Lambda(`article-generate`)와 Amplify 양쪽에 넣는다.
4. **서버리스 DB 면 pooled 엔드포인트로.** `getClient()` 가 요청마다 새 커넥션을 열어서
   (`lambda/index.js` 에만 116곳) 직접 연결은 동시 접속 한도에 걸린다.
5. 확인은 workKit **회원가입 → 로그인**. `users` 를 타므로 이것만 되면 나머지도 붙은 것이다.

테이블 32개가 각각 어느 파일에 정의돼 있는지는 `db/README.md` 의 **「테이블 목록」** 표에 있다.

**AWS 에 RDS 를 새로 만들어야 하면** `db/README.md` 의 **「AWS 에 RDS 를 새로 만들 때」** 절에
지웠던 인스턴스의 설정값이 그대로 있다(PostgreSQL / db.t4g.micro / ap-southeast-2 /
사용자 `article_admin` / DB명 `postgres`). **퍼블릭 액세스를 "예" 로 해야 한다** —
이 Lambda 는 VPC 밖이라 사설 RDS 에 닿지 못한다. 대신 보안 그룹 5432 로 좁힌다.

### DB 없이도 되는 것 / 안 되는 것

| | 상태 |
|---|---|
| `/pgo` 도감·일정·배틀·CP계산·카운터 | ✅ JSON 번들이라 서버 불필요 |
| `/pgo` 내 보관함 | ❌ |
| `/nol` | ✅ 서버 호출 없음 |
| `/test` (Hermes 대화) | ✅ 로컬 Hermes 직결 |
| `/tennis` | ❌ 전부 DB |
| `/workKit` | ❌ 로그인부터 DB |

---

## 구조

```
apps/<앱>/public/   →  Amplify 가 dist/<url>/ 로 배포 (화면)
lambda/             →  GitHub Actions 가 Lambda 로 배포 (서버)
db/                 →  스키마 정의 원본 (지금은 미사용)
scripts/            →  빌드 도구. 배포되지 않음
```

배포가 **두 갈래**이고 서로를 모른다. 각자 자기 폴더만 가져간다.

| | Amplify | Lambda |
|---|---|---|
| 가져가는 것 | `apps/` → `dist/` | `lambda/` 만 |
| 지시서 | `amplify.yml` (`baseDirectory: dist`) | `.github/workflows/deploy-lambda.yml` |
| 트리거 | main push | `lambda/**` 변경 시에만 |
| 도는 곳 | 사용자 브라우저 | AWS |
| 소스 공개 | **공개(F12 로 다 보임)** | 비공개 |
| API 키 | 🚫 절대 금지 | ✅ 여기 |

둘은 `import` 로 연결되지 않는다. **URL 로만** 통신한다
(`apps/pgo/public/assets/js/pgo-config.js` 의 `PGO_API_BASE`).

- Lambda 함수명: `article-generate` / 리전 `ap-southeast-2`
- API Gateway: `erilyjnp21`

## 앱 추가

1. `apps/<이름>/public/` 생성
2. `scripts/build-site.js` 의 `APPS` 배열에 한 줄 추가 — **안 넣으면 배포되지 않는다**
3. 스키마가 필요하면 `db/<앱>/*.sql` + `db/build-schema.js` 의 `APP_ORDER` 에 추가
   — **여기 안 넣으면 SQL 이 조용히 무시된다** (예전에 tennis 가 이걸로 누락된 적 있다)

npm 라이브러리는 **`lambda/package.json`** 에 넣는다. 최상위에 넣으면 Lambda 에 안 올라간다.

## 로컬 확인

```bash
node scripts/build-site.js   # apps/ → dist/ 조립. 이걸 안 하면 수정이 반영되지 않는다
node server.js               # http://localhost:3000
```

화면을 고쳤으면 **빌드를 먼저 돌려야** 로컬에서도 보인다.

## /test (Hermes 대화)

로컬 Hermes 에 브라우저가 **직접** 붙는 예제다. Lambda 를 거치지 않는다.

- Hermes 는 내 PC `127.0.0.1:8642` 에서만 듣는다. 서버를 거치면 들어올 길이 없다.
- **Amplify 배포판(HTTPS)에서는 동작하지 않는다.** 크롬의 Private Network Access 가
  `https://` 페이지 → `http://127.0.0.1` 요청을 차단한다(실측 확인). 설정으로 못 푼다.
  → **로컬(`http://localhost:3000/test/`)에서만 쓴다.**
- 쓰기 전 `~/.hermes/.env` 에 `API_SERVER_ENABLED=true`, `API_SERVER_KEY=…`,
  `API_SERVER_CORS_ORIGINS=http://localhost:3000` 을 넣고 `hermes gateway` 를 켠다.
- 대화 기억은 `/v1/responses` 의 `previous_response_id` 로 Hermes 가 이어준다.
