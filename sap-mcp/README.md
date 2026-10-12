# SAP 조회 도구 (MCP + HTTP)

Hermes 에이전트가 **스스로 SAP 을 조회하며 분석**하게 하는 도구다. 같은 조회 로직에
껍데기가 둘 붙어 있다.

```
sap_mcp.py       MCP (stdio)   → Hermes 에이전트가 쓴다
sap_worker.py    HTTP (:8777)  → 브라우저가 쓴다 (웹 /sap-local)
  └ sap_summary.py        조회 결과 요약 (2,000행 → 약 1,200토큰)
      └ explore_objects.py    ADT 세션·CSRF·개발/운영 분리
```

에이전트는 HTTP API 를 스스로 쓸 줄 모른다. "이런 도구가 있고 이렇게 부른다"를 알리는
규격이 필요한데 그게 MCP 다. 그래서 같은 함수에 껍데기를 하나 더 붙였다.

## 도구 세 개

| 이름 | 하는 일 |
|---|---|
| `search_object` | 이름 일부로 오브젝트 검색 → 타입·패키지·설명 |
| `read_source` | ABAP 프로그램·인클루드·테이블 DDL 소스 |
| `query_table` | 테이블 데이터 → 행 수·컬럼 분포·샘플 10행으로 요약 |

## 운영 전용 · 읽기 전용

조회 대상은 **운영서버**다. 개발서버 코드는 미이관분이 있어 실제 도는 것과 다르다
(검색 결과가 개발 20건 / 운영 16건으로 갈렸다).

쓰기는 세션 수준에서 막는다 — `PUT`·`DELETE`·`PATCH` 전면 차단, `POST` 는
`datapreview/freestyle`(SELECT 조회)만 허용한다. 모델이 지시하든 코드 실수든
운영에 쓰기가 나갈 수 없다.

조회 결과에서 이름·연락처 등으로 보이는 컬럼은 마스킹하고, 행 수는 2,000 으로 제한한다.

## 로컬에서 쓰기

```bash
cp .env.example .env          # 값 채우기
```

**Hermes 에이전트로** — `~/.hermes/config.yaml` 끝에:

```yaml
mcp_servers:
  sap:
    command: python
    args: ["C:/git/web_claude_integ/sap-mcp/sap_mcp.py"]
    timeout: 180
```

```bash
hermes -z "ZSDNR0010 이 다루는 테이블을 소스에서 찾고 데이터 건수도 알려줘"
```

**브라우저로** — 웹 `/sap-local/` 에서 쓰려면 HTTP 워커를 띄운다:

```bash
python sap_worker.py          # http://127.0.0.1:8777
```

## EC2 로 옮기기

지금은 EC2 가 사내망에 못 닿아 의미가 없다. **VPC 로 사내망이 연결된 뒤**에 한다.

```bash
# EC2 에서
cd ~ && git clone <repo> && cd web_claude_integ/sap-mcp
cp .env.example .env && vi .env        # 자격증명은 서버에서 직접 넣는다

# ~/.hermes/config.yaml
mcp_servers:
  sap:
    command: python3
    args: ["/home/ubuntu/web_claude_integ/sap-mcp/sap_mcp.py"]
    timeout: 180

sudo systemctl restart hermes-gateway
```

**바뀌는 건 `args` 경로와 `python`→`python3` 뿐이다.** 로컬에서 검증한 설정이 그대로 간다.

## 주의

- `.env`(자격증명)는 **커밋하지 않는다**. `.gitignore` 에 들어 있다.
- `explore_objects.py` 는 작업 디렉토리에서 `.env` 또는 `접속정보.env` 를 찾는다.
  MCP 로 띄우면 Hermes 가 프로세스를 어디서 실행하는지에 따라 경로가 달라질 수 있으니,
  조회가 "접속정보 파일을 찾을 수 없다"로 실패하면 `cwd` 를 확인한다.
