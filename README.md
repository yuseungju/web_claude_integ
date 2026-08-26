# article-writer

한 저장소에 **서로 독립된 두 개의 웹**이 들어 있다. 화면·에셋·URL이 완전히 분리되어 있고
공유하는 것은 배포 파이프라인과 (선택적으로) RDS 인스턴스뿐이다.

| 앱 | URL | 성격 | 에셋 |
|---|---|---|---|
| SAP 업무 활용 정리 | `/` | 정적 문서 사이트 | `public/assets/`, `public/process/` |
| 사라님을 위한 포켓몬 쓸모분석 | `/pgo/` | 포켓몬GO 보유/버림 판정 도구 | `public/pgo/assets/` |

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

## 사라님을 위한 포켓몬 쓸모분석 (`/pgo/`)

### 화면

| 경로 | 내용 |
|---|---|
| `/pgo/` | 도감 — 1,248종 검색·계열 필터·정렬, 카드에 계열별 순위 표시 |
| `/pgo/rank.html` | 계열별 순위 — 등급/타입/세대별 강함 순위 (상위·하위) |
| `/pgo/iv.html` | CP·IV 계산기 — 표시 CP/HP로 가능한 (레벨, IV) 조합 역산 |
| `/pgo/counter.html` | 카운터 분석 — 상대 약점 + 추천 카운터 랭킹 |
| `/pgo/types.html` | 타입 상성표 + 복합 타입 계산기 |
| `/pgo/box.html` | 내 보관함 — 저장한 개체 비교 |

### 데이터

런타임에 외부 API를 호출하지 않는다. 전부 저장소에 번들되어 있다.

```bash
node tools/build-pgo-data.js     # PokeAPI GraphQL -> pokedex.json (타입 상성표 + 스프라이트 매핑)
node tools/fetch-pgo-sprites.js  # 스프라이트 -> public/pgo/assets/sprites/ (약 1.2MB)
node tools/build-pgo-godata.js   # 위 둘 + pokemon-go-api + pvpoke -> godex.json (런타임이 읽는 파일)
```

런타임이 읽는 파일은 `godex.json` 하나다. 담긴 내용:

| 출처 | 내용 |
|---|---|
| pokemon-go-api | **게임 내 실측 종족값**, 한국어명, PvE 기술 수치(위력/에너지/시전시간), 전설·환상·UB 분류 |
| pvpoke gamemaster | 출시 여부 (게임 파일에만 있는 미출시 폼 제외) |
| PokeAPI | 타입 상성표, 경량 스프라이트 |

종족값이 환산치가 아니라 실측값이므로 보정 테이블이 필요 없다.
외형만 다른 폼(안농 A~Z 등)은 빌드 단계에서 제거하고,
이름이 겹치는 폼은 폼 태그를 붙여 구분한다.

### 보유 판정 등급 (메인 화면의 1순위 정보)

도감 카드 최상단에 **보유/버림 판정**이 배너로 붙는다. 판정 기준은
**진화 체인의 최종 잠재력** — 자신 · 모든 진화 후손 · 각자의 메가진화 중 가장 높은 ER이다.
따라서 미뇽은 지금 약해도 메가망나뇽 기준으로 `보유` 등급을 받고,
카드에 `→ 메가망나뇽 기준` 이라고 근거가 표시된다.

| 등급 | 뜻 | 기준 |
|---|---|---|
| `필수 보유` S | 최상위권. 무조건 키운다 | 잠재력 상위 3% |
| `보유` A | 실전에서 제 몫을 한다 | 상위 15% |
| `보통` B | 아쉬우면 쓸 만한 수준 | 상위 45% |
| `버림` C | 사탕용. 키울 가치 없음 | 나머지 |

잠재력이 같으면(같은 진화 체인이라 흔하다) 반드시 같은 등급·같은 순위를 받는다.

**주의**: 이 판정은 **레이드(PvE) 기준**이다. ER이 화력 가중 지표라
마릴리처럼 PvP 전용으로 강한 종은 낮게 나온다.

### 순위 계산

`pgo-core.js`가 로딩 직후 전 종에 대해 계산한다 (레벨 40 · 개체값 15/15/15):

- **DPS** — 보유 기술 전 조합을 실제 위력·에너지·시전시간으로 사이클 시뮬레이션해 최댓값 채택.
  피해 공식 `floor(0.5 × 위력 × 공÷방 × 자속) + 1`, 가상 상대 방어력 180
- **TDO** — DPS × 생존시간(체력 × 방어 비례)
- **ER** — `(DPS³ × TDO)^(1/4)`. 화력 가중 종합 지표이자 기본 정렬 기준
- 순위는 **전체 / 등급 / 타입 / 세대** 각 계열마다 따로 매겨 도감 카드와 상세 모달에 표시

### 백엔드

보관함은 **서버 저장(RDS)** 으로 동작한다. 구성 요소:

| 계층 | 위치 | 내용 |
|---|---|---|
| 테이블 | `db/pgo_schema.sql` | `pgo_trainer` / `pgo_box` / `pgo_favorite` / `pgo_lookup_log` |
| API | `lambda/pgo.js` | `GET·POST /pgo/box`, `DELETE /pgo/box/{id}` |
| 연결 | `public/pgo/assets/js/pgo-config.js` | `PGO_API_BASE` |

`lambda/pgo.js`는 `pgo_*` 테이블만 다루며 기존 기사/웹소설 라우트와 코드가 섞이지 않는다.
`lambda/index.js`에는 `/pgo/` 접두 경로를 위임하는 분기 하나만 들어가고,
매칭되는 라우트가 없으면 `null`을 반환해 기존 라우터로 그대로 통과한다.

로그인은 없다. 브라우저가 발급한 `device_key` 단위로 보관함을 구분하므로
키를 아는 사람은 해당 보관함을 볼 수 있다 — 민감한 정보는 저장하지 않는다.
입력값은 `poke_key` 패턴 검사, IV 0~15 clamp, 보관함 500건 상한을 적용한다.

`PGO_API_BASE`를 비우면 `localStorage` 저장으로 자동 폴백한다 (백엔드 없이도 동작).
