# DB 스키마

앱별로 디렉토리를 나눠 관리하고, 배포할 때 하나로 합쳐 RDS 에 반영한다.
**이 저장소의 스키마가 DB 의 정의 그 자체다** — 빈 DB 에 `schema_all.sql` 만 돌리면
서비스가 쓰는 테이블이 전부 만들어진다.

```
db/
├── common/          모든 앱이 공유 (users, access_logs, user_saves,
│                    user_current_shares)
├── nol/             SAP 업무 활용 정리 — 현재 전용 스키마 없음
├── pgo/             포켓몬 쓸모분석 (pgo_* 테이블)
├── workkit/         Work Kit — 분류/메뉴 구조를 그대로 유지
│   ├── content/       기사작성(aw_*) · 웹소설(nw_*) · 동영상(vm_*)
│   ├── dev/           화면 설계(sd_*)
│   ├── general/       일정 공유 · 링크 보관함
│   └── other/         claude-chat(ai_*)
├── _archive/        실행하지 않는 옛 스키마 보관 (밑줄로 시작하면 빌드에서 제외)
├── build-schema.js  위 파일들을 schema_all.sql 로 병합
├── migrate.js       schema_all.sql 을 RDS 에 반영 (배포 시 자동 실행)
└── schema_all.sql   ★ 자동 생성 — 직접 수정하지 말 것
```

## 규칙

**모든 구문은 여러 번 실행해도 안전해야 한다.** 배포할 때마다 돌기 때문이다.
`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
만 쓴다.

**한 테이블은 한 파일만 정의한다.** 앱이 늘어날수록 이름이 겹치기 쉬운데
`CREATE TABLE IF NOT EXISTS` 는 조용히 넘어가 버려서, 먼저 실행된 쪽 정의가 이기고
나중 앱은 자기가 기대한 컬럼이 없는 테이블을 쓰게 된다. 그래서 `build-schema.js` 가
같은 테이블명이 두 곳에 나오면 **빌드를 실패시킨다.** 겹치면 둘 중 하나로 정리한다.

- 여러 앱이 **같은 테이블을 공유**하는 것이면 → `db/common/` 한 곳에만 두고 앱 파일에서는 지운다
- **서로 다른 테이블인데 이름만 같은** 것이면 → 앱 접두사로 이름을 나눈다
  (`pgo_`, `aw_`, `nw_`, `vm_`, `sd_` 처럼)

`common` 은 항상 가장 먼저 실행되므로(`APP_ORDER`) 앱 스키마에서 `users(id)` 같은
외래키를 바로 걸 수 있다.

`DROP TABLE` · `TRUNCATE` · `DELETE FROM` 이 들어가면 **빌드가 실패한다**
(`build-schema.js` 와 `migrate.js` 양쪽에서 막는다). 데이터를 지우는 작업이 꼭 필요하면
`db/_archive/` 에 두고 사람이 직접 실행한다.

## 스키마 추가·수정

1. 해당 앱 디렉토리의 `.sql` 을 고치거나 새로 만든다
   - 여러 앱이 공유하면 `db/common/`
   - 특정 앱 전용이면 `db/<앱>/...`
2. 통합 파일 재생성 — 배포 때도 자동으로 돌지만 커밋 전에 확인하는 게 좋다
   ```bash
   npm run db:build
   ```
3. 무엇이 실행될지 미리 보기
   ```bash
   npm run db:migrate:dry
   ```

## 배포 시 자동 반영

`amplify.yml` 의 build 단계에서 `node db/migrate.js` 가 돈다.
접속 정보는 **Amplify 콘솔의 환경 변수**에서 읽는다:

| 환경변수 | 설명 |
|---|---|
| `DB_HOST` | RDS 엔드포인트 |
| `DB_NAME` | 데이터베이스 이름 |
| `DB_USER` | 사용자 |
| `DB_PASSWORD` | 비밀번호 |
| `DB_PORT` | 생략 시 5432 |

**환경변수가 없으면 마이그레이션만 건너뛰고 프론트엔드 배포는 계속 진행한다.**
자격증명이 없는 환경에서 배포 전체가 실패하지 않도록 한 것이다.
빌드 로그에 `[migrate] 건너뜁니다` 가 찍히면 환경 변수를 확인하면 된다.

적용은 한 트랜잭션으로 이뤄지고, 실패하면 롤백한 뒤 빌드를 중단한다.

## 새 DB 를 처음부터 만들 때

DB 만 비어 있으면 되고, 별도 순서나 수작업이 필요 없다.

```bash
npm run db:build          # schema_all.sql 재생성
DB_HOST=... DB_NAME=... DB_USER=... DB_PASSWORD=... node db/migrate.js
```

빈 스키마에서 전체가 한 번에 생성되는지 확인했다 — 27개 테이블 생성 성공, FK 순서 문제 없음.

스키마에 정의된 테이블과 `lambda/` 가 실제로 쓰는 테이블은 일치해야 한다 (현재 27 : 27).
안 쓰는 테이블을 남겨두면 새 DB 를 만들 때마다 따라다닌다.
