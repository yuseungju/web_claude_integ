# article-writer

한 저장소에 **서로 독립된 두 개의 웹**이 들어 있다. 화면·에셋·URL이 완전히 분리되어 있고
공유하는 것은 배포 파이프라인과 (선택적으로) RDS 인스턴스뿐이다.

| 앱 | URL | 성격 | 에셋 |
|---|---|---|---|
| SAP 업무 활용 정리 | `/` | 정적 문서 사이트 | `public/assets/`, `public/process/` |
| PGO 분석기 | `/pgo/` | 포켓몬GO 포켓몬 분석 도구 | `public/pgo/assets/` |

두 앱은 CSS 토큰·클래스명·JS 전역이 서로 겹치지 않는다.
PGO 쪽은 전부 `pgo-` 접두어를 쓰고 전역은 `window.PGO*` 하나뿐이다.
SAP 사이트 사이드바에는 `/pgo/` 링크를 넣지 않는다 (의도적 분리).

## 배포

- **정적 프론트엔드**: `main` 브랜치 push → AWS Amplify 자동 빌드 (`amplify.yml`, `baseDirectory: public`)
- **Lambda API**: `lambda/**` 변경 push → GitHub Actions가 `article-generate` 함수에 자동 배포
  (`.github/workflows/deploy-lambda.yml`)

## 로컬 실행

```bash
npm install
npm start            # http://localhost:3000
```

`server.js`는 `public/`을 그대로 서빙하는 개발용 정적 서버다.

## PGO 분석기

### 화면

| 경로 | 내용 |
|---|---|
| `/pgo/` | 도감 — 1,157종 검색·필터·정렬, 상세 모달 |
| `/pgo/iv.html` | CP·IV 계산기 — 표시 CP/HP로 가능한 (레벨, IV) 조합 역산 |
| `/pgo/counter.html` | 카운터 분석 — 상대 약점 + 추천 카운터 랭킹 |
| `/pgo/types.html` | 타입 상성표 + 복합 타입 계산기 |
| `/pgo/box.html` | 내 보관함 — 저장한 개체 비교 |

### 데이터

런타임에 외부 API를 호출하지 않는다. 전부 저장소에 번들되어 있다.

```bash
node tools/build-pgo-data.js     # PokeAPI GraphQL -> public/pgo/assets/data/pokedex.json
node tools/fetch-pgo-sprites.js  # 스프라이트 1,157장 -> public/pgo/assets/sprites/ (약 1.2MB)
```

포켓몬GO 종족값은 메인시리즈 종족값 환산식으로 계산한다
(`pgo-core.js`의 `toGoStats`). Niantic이 개별 조정한 종은
`public/pgo/assets/data/go-overrides.json`에 실측값을 넣어 덮어쓰고,
UI에 **실측값** 배지로 표시된다.

### 백엔드 (선택)

보관함은 기본적으로 브라우저 `localStorage`에만 저장된다.
서버 저장으로 전환하려면:

1. `db/pgo_schema.sql`을 기존 RDS에 실행 (`pgo_` 접두어 테이블만 생성, 기존 테이블 무영향)
2. `lambda/pgo.js`가 배포된 상태에서
3. `public/pgo/assets/js/pgo-config.js`의 `PGO_API_BASE`에 API Gateway 엔드포인트 지정

`lambda/pgo.js`는 `pgo_*` 테이블만 다루며 기존 기사/웹소설 라우트와 코드가 섞이지 않는다.
