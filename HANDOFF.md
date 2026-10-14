# 인수인계 — SAP 분석 에이전트 + 에이전트 관리 웹

작성 2026-10-14. **다른 Claude 세션이 이 작업을 이어받을 때 먼저 읽는 문서**다.
저장소 구조는 [CLAUDE.md](CLAUDE.md), SAP 접근 규칙은 `C:\ABAP_NOL\CLAUDE.md` 에 따로 있다.
여기에는 **그 둘에 안 적혀 있는 것**만 쓴다 — 왜 이렇게 생겼는지, 어디서 사람이 넘어졌는지.

---

## 1. 이게 뭔가

LLM 에이전트가 **SAP ERP 운영 시스템을 스스로 조회하며 분석**하게 하는 웹앱이다.
"ZSDR0665 에 투숙일이 왜 안 나오나" 를 물으면, 에이전트가 ABAP 소스를 읽고 테이블을
조회해가며 근거를 모아 답한다. 실제로 22단계를 돌아 원인 두 곳을 짚어낸 기록이 있다.

알아낸 것은 요약해서 DynamoDB 에 쌓고, 여러 사람이 그 요약을 함께 고친다.

---

## 2. 가장 중요한 제약 — 이게 구조를 전부 결정했다

**SAP 은 사내망에 있다. AWS 는 거기에 닿지 못한다.**

```
AWS Lambda ──✕──▶ 사내망 SAP        회사 방화벽
AWS Lambda ──✕──▶ 사용자 PC          NAT. 바깥에서 전화를 걸 수 없다
브라우저   ──✅──▶ 양쪽 모두          ← 유일하게 둘 다 닿는 지점
```

그래서 **에이전트 루프(하네스)가 브라우저 안에서 돈다.** 모델 호출은 AWS 로,
SAP 조회는 `127.0.0.1:8777` 로 브라우저가 나눠 보낸다. 이상해 보이지만 다른 길이 없다.

따라오는 결과:

- 브라우저 탭을 닫으면 분석이 멈춘다. AWS 에 "작업" 이 떠 있는 게 아니다.
- 다른 사람이 쓰려면 **그 사람도 자기 PC 에 워커를 띄워야** 한다.
- 공유되는 것은 **지식 DB 뿐**이다.
- EC2 혼자서는 SAP 분석을 못 한다.

사내망이 열리면(VPC + Direct Connect/VPN) 워커를 EC2 로 옮기고 화면의 워커 주소만
바꾸면 된다. 그게 가장 적게 바꾸는 길이다.

---

## 3. 흐름

```
┌─ 사용자 PC ──────────────────────┐   ┌─ AWS ─────────────────────────┐
│ 브라우저 (루프를 도는 주체)        │   │ Amplify ── 화면(dist/)         │
│   ├─① 모델 ─────────────────────┼──▶│ API Gateway → Lambda           │
│   │                              │   │   ├─▶ DynamoDB                 │
│   └─② SAP 조회                    │   │   └─▶ EC2:8646 authproxy       │
│        ▼                         │   │          └ :8645 hermes proxy  │
│   127.0.0.1:8777 워커(python)     │   │               │                │
│        ▼                         │   └───────────────┼────────────────┘
│   사내망 ─▶ SAP 운영 (ADT REST)   │                   ▼
│                                  │            Nous Portal → OpenAI
│ node server.js :3000  화면+API    │
└──────────────────────────────────┘
```

### 판단은 밖, 권한은 안

| | 누가 |
|---|---|
| 어떤 도구를 쓸지, 언제 끝낼지 | **모델**(`openai/gpt-6-luna`) |
| 루프 돌리기, 횟수 세기 | **브라우저** |
| 도구 실행, 허용/거부, 결과 요약 | **워커** |
| 중계만 (판단 안 함) | Lambda, authproxy, hermes proxy, Nous |

**헤르메스는 생각하지 않는다.** `hermes proxy` 모드라 중계기일 뿐이다. 헤르메스의
에이전트 하네스(루프·압축·가드레일)는 이 경로에서 **쓰이지 않는다**. 사람이 "헤르메스가
판단하냐" 고 여러 번 물었다 — 아니라고 분명히 답해야 한다.

종료 판정은 [apps/sap-local/public/index.html](apps/sap-local/public/index.html) 의
`if (!calls.length)` 한 줄이 전부다. 모델이 도구를 더 안 부르면 끝이다.

---

## 4. 돌려야 하는 것

```bash
# 웹 (화면 + /sap/* /agent/* 로컬 API)
cd /c/git/web_claude_integ && node server.js            # :3000

# SAP 워커 — 이것 없이는 SAP 조회가 안 된다
cd /c/git/web_claude_integ/sap-mcp && SAP_ENV_DIR="C:/ABAP_NOL" python -X utf8 sap_worker.py
```

| 화면 | 용도 |
|---|---|
| `localhost:3000/agent/` | 메뉴 홈 (새로 만든 것) |
| `localhost:3000/agent/merge/` | 글 합치기·요약 |
| `localhost:3000/sap-local/` | SAP 분석 — 워커 필요 |
| `localhost:3000/sap-facts/` | 지식 정리 (트리·일괄저장) |

화면 상단에 **서버: AWS / 로컬** 선택이 있다. 같은 `lambda/sap.js` 가 양쪽에서 돌고
**같은 DynamoDB** 를 본다. 로컬은 `HERMES_URL`/`PROXY_TOKEN` 이 없어 **모델 호출만
안 되고** 지식 조회·수정은 된다.

---

## 5. 저장소

```
C:\git\web_claude_integ          ← 코드는 전부 여기 하나. 옛 이름 article-writer
  apps/<앱>/public/              화면. 폴더명 = URL 경로
  lambda/                        서버. 전부 Lambda 하나(article-generate)
    index.js(3200줄) sap.js sap_facts.js agent.js pgo.js tennis.js
  sap-mcp/                       SAP 워커 (로컬 전용, AWS 에 안 올라감)
  scripts/build-site.js          apps/*/public → dist/  ← 앱 추가 시 APPS 배열에 한 줄
  db/                            PostgreSQL 스키마 (RDS 해지로 미사용)

C:\ABAP_NOL                      ← 코드 저장소 아님. SAP 작업 자료
  접속정보.env                    ← 지금도 필수. SAP_ENV_DIR 로 참조
  *.abap, data/, extract/        소스 덤프·엑셀
  push_*.py, compare_*.py …      일회성 스크립트 20여 개
```

배포는 두 갈래이고 서로를 모른다. `main` push → Amplify 가 `apps/`, GitHub Actions 가
`lambda/**`. **Lambda 는 push 후 약 30초면 반영된다.**

---

## 6. DynamoDB

| 테이블 | 키 | 용도 |
|---|---|---|
| `sap_conversations` | userKey / convId | `/sap` 대화 |
| `sap_messages` | convId / seq | `/sap` 메시지 |
| `sap_facts` | subject / factId | **지식** — 분석에서 알게 된 것 |
| `agent_docs` | userKey / docId | `/agent` 문서 — **아직 안 만들어짐** |

RDS(`article-writer-db`)는 **2026-10-12 에 해지**됐다(월 $24). 되살릴 계획 없음.
`/workKit`·`/tennis` 는 그래서 죽어 있다 — 버그가 아니라 의도된 상태다.

### 테이블/권한을 늘릴 때

Claude 는 **AWS 리소스를 만들 수 없다.** 로컬 자격증명(`seungju-local`)은 DynamoDB
데이터 조작만 되고 CreateTable 권한이 없다. 사용자에게 콘솔 절차를 **클릭 단위로**
알려줘야 한다. 그때 IAM 을 **두 곳** 고쳐야 한다는 걸 빠뜨리기 쉽다:

- 정책 `sap-dynamodb-local` — 사용자 PC 용
- 역할 `article-generate-role-27ly013f` 의 인라인 정책 `sap-dynamodb` — Lambda 용

`dynamodb:Scan` 이 기존 정책에 없었다. 지식 목록이 Scan 을 쓰므로 반드시 추가해야 한다.

---

## 7. 지켜야 하는 규칙

- **운영 SAP 수정 절대 불가.** 세션 수준에서 막는다 — `PUT`/`DELETE`/`PATCH` 전면 차단,
  `POST` 는 3개 경로만(`datapreview/freestyle`, `usageReferences`, `nodestructure`),
  `run_select` 는 `SELECT` 로 시작하고 `;` 가 없어야 통과. 모델이 시켜도 못 나간다.
- **자격증명은 어떤 형태로도 출력하지 않는다.** 길이·앞뒤 글자도 안 된다.
  `접속정보.env` 는 워커만 읽고, 모델에는 조회 결과만 간다.
- **PII 는 마스킹.** `sap_summary.py` 가 처리한다. 지식 추출 프롬프트에도 금지가 들어 있다.
- **에이전트가 스스로 도구를 찾게 둔다.** 질문이 나올 때마다 전용 도구를 추가하지 않는다.
  그래서 `adt_get`/`adt_post`/`adt_reference` 라는 범용 창구를 뒀다.

---

## 8. 사람이 실제로 넘어진 곳 — 같은 실수를 반복하지 말 것

### ① 고친 파일과 돌고 있는 파일이 달랐다

`C:\ABAP_NOL\sap_worker.py` 라는 **사본**이 돌고 있었다. 저장소 쪽을 고치고 커밋까지
했는데 아무 변화가 없었다. "배포 안 된 수정" 과 "고장난 수정" 은 구분이 안 된다.

→ **파이썬을 고쳤으면 워커를 반드시 재시작하고 `curl 127.0.0.1:8777/tools` 로 확인한다.**
→ `C:\ABAP_NOL\explore_objects.py` 도 아직 사본이 남아 있다(저장소 쪽이 먼저 로드되는 건 확인됨).

### ② 제한이 사방에 흩어져 있었다

사용자가 "모든 제한 해제" 를 요구했는데 제한이 6곳에 있었다: 브라우저 반복 10회,
Lambda 메시지 60개, 질문 20,000자, 도구 결과 60KB→200KB, 워커 행수, 답변 1,500토큰.
한 곳만 고치면 다음 벽에 부딪힌다.

지금 남은 것은 **우리가 못 없애는 것뿐**이다: API Gateway 요청 10MB·응답 29초, 모델
컨텍스트, Nous 무료 등급 속도 제한. 반복은 `SAFETY_STEPS = 1000` 과 **중단 버튼**으로만 막는다.

### ③ `Failed to fetch` 는 CORS 가 아니라 게이트웨이였다

API Gateway 가 자기가 만든 오류(413·504)에는 **CORS 헤더를 안 붙인다.** 그래서 브라우저엔
`Failed to fetch` 로만 보이고 상태코드도 안 보인다. **Lambda 는 끝까지 돌아 DynamoDB 에
저장까지 마쳤는데** 응답만 못 돌아온 것이었다.

→ 이 오류를 보면 **CORS 를 의심하기 전에 크기와 시간을 먼저 재라.**

### ④ CSRF 토큰이 만료되는데 갱신을 안 했다

`AdtSession` 이 생성 시 한 번만 토큰을 받았다. 세션이 오래되면 POST 가 전부
`403 CSRF token validation failed`. 모델은 이유를 모르니 URI 를 바꿔가며 같은 호출을
반복했다 — **조사처럼 보이지만 헛돌기다.** `AdtSession.post()` 에서 403 이면 토큰만
다시 받아 1회 재시도하도록 고쳤다. 가장 밑단이라 모든 조회가 함께 산다.

### ⑤ 도구 설명문에 거짓이 남아 있었다

`"2,000행 상한과 무관하다"` 가 도구 description 에 남아 있었다. **그 글은 모델이 읽는다.**
없는 제한을 피하려고 엉뚱하게 돈다. 코드를 고치면 **설명문도 같이** 고쳐야 한다.

### ⑥ 요약이 너무 잘게 쪼개졌다

`MAX_BODY = 500` 으로 묶어두고 "한 문장으로 쓰라" 고 지시했으니 쪼개는 것 말고 선택지가
없었다. 지금은 4,000자 + "2~6문장, 한 subject 에 한 건" + **코드 차원의 강제**
(60자 미만 버림, 같은 subject 중복 제거, 최대 5건). **프롬프트만으로는 안 된다.**

### ⑦ 개발 환경의 함정

- **Bash 도구의 heredoc 이 백슬래시를 먹는다.** `'\\n'` 이 진짜 줄바꿈이 돼 파일이 깨졌다.
  파이썬/JS 에 백슬래시가 들어가는 수정은 Write/Edit 도구를 쓸 것.
- **Windows 콘솔이 한글을 깨뜨린다.** `curl -d '한글'` 은 깨져서 전송된다. 서버 문제로
  오인하기 쉽다. UTF-8 파일로 만들어 `--data-binary @file` 로 보내고, 결과도 파일로
  저장해 `python -X utf8` 로 읽을 것. **섣불리 "인코딩이 깨졌다" 고 판단하지 말 것.**
- `lambda/node_modules` 가 불완전할 수 있다. `cd lambda && npm install`.

---

## 9. 알려진 보안 문제 — 사용자에게 보고했고 아직 안 고쳤다

| 심각도 | 문제 |
|---|---|
| 🔴 | **워커가 `Access-Control-Allow-Origin: *`.** 워커가 떠 있는 동안 **아무 웹사이트나** `127.0.0.1:8777` 을 불러 운영 데이터를 가져갈 수 있다. `Allow-Private-Network: true` 가 그걸 허용한다. 읽기 전용이라 고쳐지진 않지만 새어나간다. **Origin 제한 + 토큰으로 10분이면 막는다.** |
| 🔴 | **API 에 인증이 없다.** `userKey` 는 이름표지 자물쇠가 아니다. 주소만 알면 누구나 추론을 돌리고 `GET /sap/facts` 로 지식을 전부 읽고 `PUT` 으로 고칠 수 있다. |
| 🟠 | **Lambda→EC2 가 평문 HTTP.** 운영 ABAP 소스가 공인 인터넷을 암호화 없이 지난다. 저장소 README 에 "ABAP 소스를 넣기 전에 TLS 를 붙인다" 고 적혀 있는데 **그 시점이 이미 지났다.** |
| 🟠 | 운영 소스·데이터 샘플이 개인 Nous 계정을 통해 OpenAI 로 나간다. **회사 승인 채널인지 확인이 안 됐다.** Bedrock 전환이 대안이고 `callAI()` 하나만 바꾸면 된다. |
| 🟡 | SAP 운영 비밀번호 교체 미완(과거 화면 노출). |

---

## 10. 지금 상태와 다음 할 일

### 미완

- **`agent_docs` 테이블이 없다.** `/agent/merge` 의 합치기·요약은 되지만 **저장이 막힌다**
  (`AccessDeniedException`). 사용자에게 테이블 생성 + IAM 2곳 수정을 안내해 둔 상태.
- `3e18920` 커밋이 **푸시 안 됨.** 테이블 생성 후 저장을 확인하고 푸시하기로 했다.
- **프롬프트 캐싱 측정 미착수.** `usage.prompt_tokens_details.cached_tokens` 를 로그·화면에
  찍어야 한다. **측정 전에 압축을 붙이면 안 된다** — 압축은 프리픽스를 바꿔 캐시를 깨뜨린다.
  둘은 서로 싸운다. 적중률 70% 이상이면 압축을 붙이지 않는 게 맞다.
- 반복 호출 감지(같은 도구·같은 인자 3연속 중단) 제안했으나 미착수.

### 사용자가 생각 중인 방향

- **GitHub 소스 분석으로 전환** — `yanolja-org/yanolja_erp_aiagent_development`.
  권한이 없어 404(EMU 조직으로 추정). 되면 EC2 단독 실행이 가능해지지만 **운영 데이터는
  못 본다** — 소스 구조 분석까지다.
- **관계형 DB 로 이전** — 조인·파일명 관리·메뉴트리를 데이터로 쌓고 싶어 한다.
  DynamoDB 로는 조인이 안 된다. 저장소에 PostgreSQL 스키마(`db/`, 32테이블)와
  `migrate.js` 가 **이미 있고 접속이 전부 환경변수**라, Neon/Supabase 를 붙이면
  코드를 안 고치고 동작한다. 선택을 묻다가 중단됐다.
- 사용자가 **"로컬 DB 를 만들어 AWS 가 쓰게"** 를 여러 번 물었다. **안 된다** — Lambda 가
  PC 로 들어오는 연결을 걸어야 하는데 NAT 뒤라 불가능하고, PC 가 꺼지면 모두가 멈춘다.
  집에서 해도 같다. 방향이 거꾸로다.

---

## 11. 사용자에 대해

- SAP ABAP 개발자. 운영 시스템을 다루므로 **안전장치를 건너뛰자는 제안을 하면 안 된다.**
- 한국어로 소통한다. 설명을 요구할 때가 많고, **구조를 그림으로 보여주면 잘 통한다.**
- 질문이 짧고 빠르게 이어진다. 오타가 잦으니 의도를 보고 읽을 것.
- **틀린 전제를 자주 세운다.** 예: "헤르메스가 판단한다", "로컬 테스트는 AWS 를 안 거친다",
  "C:\ABAP_NOL 과 합쳐야 한다". **맞장구치지 말고 확인한 사실로 바로잡아야 한다.**
- 제한·제약을 싫어한다. "모든 제한 해제" 를 요구했고, 비용·위험을 설명한 뒤 그대로 진행했다.
  **다시 제한을 거는 제안은 근거를 들어 설명할 것.**
- 커밋 메시지는 한국어, 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
