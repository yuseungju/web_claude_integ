# SAP 조회 도구 (MCP + HTTP)

에이전트가 **스스로 SAP 을 조회하며 분석**하게 하는 도구다. 같은 조회 로직에
껍데기가 둘 붙어 있다.

```
sap_mcp.py       MCP (stdio)   → Hermes 에이전트가 쓴다
sap_worker.py    HTTP (:8777)  → 브라우저가 쓴다 (웹 /sap-local)
  └ sap_summary.py        조회 결과 요약 (행이 늘어도 토큰은 거의 안 는다)
      └ explore_objects.py    ADT 세션·CSRF·개발/운영 분리
```

에이전트는 HTTP API 를 스스로 쓸 줄 모른다. "이런 도구가 있고 이렇게 부른다"를 알리는
규격이 필요한데 그게 MCP 다. 그래서 같은 함수에 껍데기를 하나 더 붙였다.

## 도구 아홉 개

브라우저는 이 목록을 하드코딩하지 않는다 — 띄워둔 워커의 `GET /tools` 를 읽어 그대로
모델에 넘긴다. **그래서 도구를 늘려도 화면은 고칠 필요가 없고, 반대로 낡은 워커가
돌고 있으면 도구가 조용히 줄어든다.** 분석이 이상하면 워커부터 확인한다.

| 이름 | 하는 일 |
|---|---|
| `search_object` | 이름 일부로 오브젝트 검색 → 타입·패키지·설명. 이름만 알 때 제일 먼저 |
| `read_source` | ABAP 프로그램·인클루드·테이블 DDL 소스 |
| `query_table` | 테이블 데이터 → 행 수·컬럼 분포·샘플 10행으로 요약 |
| `count_rows` | 전체 건수. 행을 안 가져오므로 테이블이 아무리 커도 싸다 |
| `aggregate` | 컬럼별 건수 집계 — 상태값 분포, 월별 건수 등 |
| `run_select` | 자유 SELECT. 조인·복잡한 집계용. SELECT 외에는 거부 |
| `adt_get` | 편의 도구가 없는 조회를 ADT GET 으로 직접 |
| `adt_post` | where-used 등 조회 성격의 POST. 허용 목록 밖은 거부 |
| `adt_reference` | 위 둘을 쓰기 위한 ADT 엔드포인트 참고표 |

앞의 여섯은 자주 쓰는 길을 포장한 것이고, 뒤의 셋은 **포장되지 않은 조회를 에이전트가
스스로 찾아 하라고** 둔 것이다. 질문이 나올 때마다 도구를 새로 만들어 주는 식으로는
끝이 없다.

## 운영 전용 · 읽기 전용

조회 대상은 **운영서버**다. 개발서버 코드는 미이관분이 있어 실제 도는 것과 다르다
(검색 결과가 개발 20건 / 운영 16건으로 갈렸다).

쓰기는 세션 수준에서 막는다 — `PUT`·`DELETE`·`PATCH` 전면 차단, `POST` 는 아래
세 경로만 허용한다. 모델이 지시하든 코드 실수든 운영에 쓰기가 나갈 수 없다.

```
/sap/bc/adt/datapreview/freestyle                          자유 SELECT
/sap/bc/adt/repository/informationsystem/usageReferences   where-used
/sap/bc/adt/repository/nodestructure                       패키지 트리
```

`run_select` 는 한 겹 더 막는다 — `SELECT` 로 시작하지 않거나, 변경 구문이 섞였거나,
`;` 로 문장을 여러 개 이어 붙이면 실행하지 않는다.

조회 결과에서 이름·연락처 등으로 보이는 컬럼은 마스킹한다.

## 행 수를 제한하지 않는 이유

결과를 원문 그대로 싣지 않고 **요약해서** 주기 때문이다. 행 수·컬럼별 분포·값 범위·
샘플 10행으로 접어서 보내므로, 2,000행이든 20,000행이든 토큰이 비슷하다. 그래서
상한을 둘 이유가 없다 — 오히려 상한 때문에 "뒤를 못 봤다"는 걸 모른 채 틀린 결론을
내는 쪽이 비싸다.

소스도 자르지 않는다. 중간이 잘린 ABAP 은 읽으나 마나다.

## 로컬에서 쓰기

자격증명은 작업 디렉토리의 `.env` 또는 `접속정보.env` 에서 읽는다.
`SAP_ENV_DIR` 로 그 디렉토리를 지정할 수 있다.

**브라우저로** — 웹 `/sap-local/` 에서 쓰려면 HTTP 워커를 띄운다:

```bash
SAP_ENV_DIR="C:/ABAP_NOL" python -X utf8 sap_worker.py   # http://127.0.0.1:8777
```

```bash
curl http://127.0.0.1:8777/tools    # 도구 9개가 보이면 정상
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
- **사본을 만들지 않는다.** 예전에 `C:\ABAP_NOL\` 에 같은 파일들이 복사돼 있었고,
  저장소 쪽을 고쳤는데 실제로 돌던 건 사본이라 "고쳤는데 그대로"인 상태가 오래 갔다.
  고친 뒤에는 **워커를 반드시 재시작하고** `/tools` 로 도구 수를 확인한다.
- `explore_objects.py` 는 작업 디렉토리에서 `.env` 또는 `접속정보.env` 를 찾는다.
  MCP 로 띄우면 Hermes 가 프로세스를 어디서 실행하는지에 따라 경로가 달라질 수 있으니,
  조회가 "접속정보 파일을 찾을 수 없다"로 실패하면 `cwd` 또는 `SAP_ENV_DIR` 을 확인한다.
