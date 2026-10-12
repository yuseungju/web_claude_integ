# DB 스키마

> ## ⚠️ 현재 이 프로젝트는 DB 를 쓰지 않는다
>
> 비용 때문에 **2026-10-12 에 RDS 를 해지했다**(월 $24). 되살릴 계획 없이 끝낸 것이고,
> DB 가 필요한 기능은 **고치지 않고 그대로 둔다**. 연결이 안 되면 그 기능만 실패한다.
>
> **이 디렉토리는 그대로 두는 것이 중요하다.** 저장소의 `.sql` 이 DB 정의 원본이라,
> 나중에 DB 를 다시 붙이고 싶어지면 → **[다시 켜는 법](#다시-켜는-법)** 한 절만 따라 하면
> 빈 DB 에 테이블 32 개가 그대로 복원된다. 코드는 한 줄도 고치지 않는다.

## DB 없이 지금 되는 것 / 안 되는 것

| | 상태 | 비고 |
|---|---|---|
| `/pgo` 도감 · 일정 · 배틀 · CP계산 · 카운터 | ✅ 정상 | 데이터가 JSON 번들이라 서버가 필요 없다 |
| `/pgo` **내 보관함** | ❌ | 유일하게 DB 를 쓰는 pgo 기능 |
| `/nol` | ✅ 정상 | 서버 호출이 아예 없다 |
| `/test` (Hermes 대화) | ✅ 정상 | 로컬 Hermes 에 직접 붙는다. 서버·DB 무관 |
| `/tennis` | ❌ | 계정 · 예약수집 · 정산 전부 DB |
| `/workKit` | ❌ | **로그인부터** DB 라 사실상 전부 |

DB 가 없으면 해당 API 가 연결 실패로 떨어지고 화면에는 오류만 뜬다. 의도한 상태다.

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
지금은 `CREATE TABLE IF NOT EXISTS` 32개, `CREATE INDEX IF NOT EXISTS` 33개,
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 3개뿐이다.
컬럼을 추가해야 하면 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 를 쓰되, 반드시 그 컬럼을
참조하는 인덱스보다 **먼저** 와야 한다(없는 컬럼에 인덱스를 걸면 실패한다).

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

## 테이블 목록 (총 32개)

DB 를 다시 만들 때 **무엇이 생기는지**의 전부다. 이 목록과 `schema_all.sql` 이 어긋나면
`npm run db:build` 를 다시 돌린 뒤 이 표를 고친다.

| 정의 파일 | 테이블 |
|---|---|
| `db/common/common_schema.sql` | `users`, `access_logs`, `user_saves`, `user_current_shares` |
| `db/pgo/pgo_schema.sql` | `pgo_trainer`, `pgo_box` |
| `db/tennis/tennis_schema.sql` | `tn_accounts`, `tn_reservations`, `tn_checks`, `tn_prices`, `tn_settings` |
| `db/workkit/content/article-writer/…` | `aw_projects`, `aw_sections`, `aw_section_editors`, `aw_reactions`, `aw_comments`, `aw_comment_reactions` |
| `db/workkit/content/novel-writer/…` | `nw_projects`, `nw_nodes`, `nw_reactions`, `nw_comments`, `nw_comment_reactions` |
| `db/workkit/content/video-maker/…` | `vm_projects`, `vm_nodes`, `video_maker_settings` |
| `db/workkit/dev/screen-designer/…` | `sd_projects`, `sd_nodes` |
| `db/workkit/general/bookmark/…` | `link_folders`, `link_bookmarks` |
| `db/workkit/general/schedule/…` | `schedule_collab_refs` |
| `db/workkit/other/claude-chat/…` | `ai_summaries`, `ai_summary_files` |

`users` 가 거의 모든 테이블의 외래키 대상이라 `common` 이 항상 먼저 실행된다(`APP_ORDER`).

## 다시 켜는 법

DB 를 다시 붙이고 싶어지면 이 절만 따라 하면 된다. **애플리케이션 코드는 고치지 않는다** —
접속 정보가 전부 환경변수라([`lambda/index.js`](../lambda/index.js) 상단 `DB_CONFIG`),
PostgreSQL 이기만 하면 어디든 붙는다.

### 1. DB 를 하나 띄운다

| 선택지 | 월 비용 | 메모 |
|---|---|---|
| **Neon** | $0 | PostgreSQL 그대로. 1GB. 5분 미사용 시 컴퓨트 일시정지(첫 요청이 몇 초 느림) |
| Supabase | $0 | 500MB. **1주 방치하면 프로젝트가 정지**되니 주의 |
| RDS | $24~ | 예전에 쓰던 것. 상시 가동이 필요할 때만 |

### 2. 스키마를 올린다

```bash
npm run db:build     # db/schema_all.sql 재생성 (테이블 32개)
```

생성된 `db/schema_all.sql` 을 그대로 실행한다. 둘 중 편한 쪽:

- DB 콘솔(Neon SQL Editor 등)에 **파일 내용을 통째로 붙여넣기**
- 또는 CLI:
  ```bash
  DB_HOST=... DB_NAME=... DB_USER=... DB_PASSWORD=... node db/migrate.js
  ```

전부 `IF NOT EXISTS` 라 **여러 번 돌려도 안전하다.** 빈 스키마에 두 번 연속 실행해
32개가 그대로 만들어지는 것까지 확인했다(FK 순서 문제 없음).

### 3. 환경변수 4개를 넣는다

Lambda(`article-generate`) → 구성 → 환경 변수. Amplify 쪽도 같은 이름을 쓴다.

| 환경변수 | 설명 |
|---|---|
| `DB_HOST` | 엔드포인트 |
| `DB_NAME` | 데이터베이스 이름 |
| `DB_USER` | 사용자 |
| `DB_PASSWORD` | 비밀번호 |
| `DB_PORT` | 생략 시 5432 |

> **서버리스 DB 를 쓴다면 반드시 pooled 엔드포인트로 넣는다.** Neon 이라면 호스트에
> `-pooler` 가 붙은 쪽이다. `getClient()` 가 요청마다 새 커넥션을 열기 때문에
> (`lambda/index.js` 에만 116곳) 직접 연결로는 동시 접속 한도에 금방 걸린다.

### 4. 확인

workKit 에서 **회원가입 → 로그인**이 되면 끝이다. 로그인이 `users` 테이블을 타므로
이것만 되면 나머지도 붙은 것이다.

### 올리기 전에 한 번 보고 갈 것

`ai_summary_files.file_data` 가 **첨부파일을 base64 로 DB 에 통째로** 넣는다
(다른 파일은 전부 S3 로 빠지는데 AI 대화 첨부만 예외다). 무료 티어로 갈 거라면
파일 몇 개에 용량 한도가 차고, 한도에 닿으면 **INSERT/UPDATE 가 실패한다.**
AI 대화 첨부를 쓸 생각이면 S3 로 먼저 돌리는 편이 낫다.

## 참고: 예전 RDS 를 정리할 때

**"중지(Stop)"가 아니라 "삭제(Delete)"** 여야 요금이 멈춘다. 중지는 7일 뒤 자동으로
다시 시작되고, 그동안 스토리지 요금은 계속 나간다.
