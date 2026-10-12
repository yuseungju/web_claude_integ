"""로컬 SAP 조회 워커 — 브라우저가 부르는 HTTP 서버.

왜 로컬인가
    SAP 은 사내망에 있어 AWS Lambda 에서 못 붙는다. 반면 브라우저는 이 PC 에서
    돌아가므로 127.0.0.1 로 바로 닿는다. 그래서 AI 호출은 클라우드로, SAP 조회는
    이 워커로 나눠 보낸다. 나중에 AWS 에서 사내망이 열리면 이 워커를 그쪽으로
    옮기고 주소만 바꾸면 된다.

    브라우저 ──▶ API Gateway → Lambda → Hermes   (AI)
            └──▶ 127.0.0.1:8777  이 파일          (SAP)

조회 로직은 explore_objects.py / sap_summary.py 를 그대로 재사용한다.

    python sap_worker.py            # http://127.0.0.1:8777
    python sap_worker.py --port 9000
"""
import os
import sys

# Hermes 가 MCP 프로세스를 어느 디렉토리에서 띄울지 알 수 없다. 접속정보 파일과
# explore_objects 를 확실히 찾도록 기준 경로를 스스로 잡는다.
#   SAP_ENV_DIR 를 주면 그 폴더의 .env / 접속정보.env 를 쓰고(자격증명을 복사하지 않아도 된다),
#   없으면 이 스크립트가 있는 폴더를 쓴다.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
os.chdir(os.environ.get("SAP_ENV_DIR") or _HERE)

import io
import json
import re
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import explore_objects as eo
import sap_summary as ss

PORT = 8777
MAX_ROWS = 2000

# 동시 요청이 와도 ADT 세션은 하나만 쓰도록 묶는다. 세션에 CSRF 토큰이 매여 있어
# 여러 스레드가 동시에 건드리면 토큰이 엉킨다.
_LOCK = threading.Lock()


# ── 읽기 전용 가드 ───────────────────────────────────────
# 운영 시스템이다. 조회만 한다. 실수로든 모델 지시로든 쓰기가 나가지 않도록
# 세션 수준에서 막는다. datapreview 는 POST 지만 SELECT 조회라 허용한다.
_ALLOWED_POST = "/sap/bc/adt/datapreview/freestyle"


class ReadOnlyViolation(RuntimeError):
    pass


def _harden(session):
    """AdtSession 에 쓰기 차단을 입힌다. 이미 입혔으면 그대로 둔다."""
    if getattr(session, "_readonly_hardened", False):
        return session
    orig_post = session.post

    def guarded_post(path, **kw):
        if not str(path).startswith(_ALLOWED_POST):
            raise ReadOnlyViolation(f"운영 읽기 전용 — POST 차단: {path}")
        return orig_post(path, **kw)

    def blocked(verb):
        def _f(path, **kw):
            raise ReadOnlyViolation(f"운영 읽기 전용 — {verb} 차단: {path}")
        return _f

    session.post = guarded_post
    for verb in ("put", "delete", "patch"):
        setattr(session, verb, blocked(verb.upper()))
    session._readonly_hardened = True
    return session


def prod():
    """운영 세션. 항상 읽기 전용 가드를 거친다."""
    return _harden(ss._session())


# ── 도구 구현 ────────────────────────────────────────────
def tool_query_table(args):
    """운영서버 테이블 조회 → 요약 텍스트."""
    table = str(args.get("table", "")).strip().upper()
    if not table:
        return "table 인자가 필요합니다."
    rows = min(int(args.get("rows", 2000) or 2000), MAX_ROWS)
    where = args.get("where") or None
    return ss.query_summary(table, rows, where=where)   # 항상 운영


def tool_read_source(args):
    """ABAP 소스를 읽는다. 프로그램 → 인클루드 → 테이블 DDL 순으로 시도한다.

    운영서버에서 읽는다. 개발서버 코드는 아직 이관 전이라 실제 돌아가는 것과
    다를 수 있고, 분석 대상은 지금 운영에서 도는 코드다.
    """
    name = str(args.get("name", "")).strip().upper()
    if not name:
        return "name 인자가 필요합니다."
    srv = prod()
    lname = name.lower()
    for path in (f"/sap/bc/adt/programs/programs/{lname}/source/main",
                 f"/sap/bc/adt/programs/includes/{lname}/source/main",
                 f"/sap/bc/adt/ddic/tables/{lname}/source/main"):
        resp = srv.get(path, headers={"Accept": "*/*"})
        if resp.ok and resp.text.strip():
            text = resp.text
            # 프롬프트에 통째로 싣지 않도록 상한을 둔다(비용·컨텍스트 보호)
            if len(text) > 60000:
                text = text[:60000] + "\n... (이하 생략 — 더 필요하면 범위를 좁혀 다시 요청하세요)"
            kind = path.split("/")[-4]          # programs | includes | tables
            return f"[{name}] {kind}\n\n{text}"
    return f"{name} 소스를 찾지 못했습니다 (프로그램·인클루드·테이블 DDL 모두 없음)."


def tool_search_object(args):
    """이름만 알고 타입을 모를 때. quickSearch 로 타입·패키지를 찾는다."""
    query = str(args.get("query", "")).strip()
    if not query:
        return "query 인자가 필요합니다."
    srv = prod()
    resp = srv.get(
        "/sap/bc/adt/repository/informationsystem/search",
        params={"operation": "quickSearch", "query": query, "maxResults": 20,
                "sap-client": srv.client},
        headers={"Accept": "*/*"},
    )
    if not resp.ok:
        return f"검색 실패 ({resp.status_code})"
    import xml.etree.ElementTree as ET
    root = ET.fromstring(resp.text)
    A = "{http://www.sap.com/adt/core}"
    lines = []
    for ref in root.iter(f"{A}objectReference"):
        lines.append("  {:<32} {:<10} {:<12} {}".format(
            ref.get(f"{A}name", ""), ref.get(f"{A}type", ""),
            ref.get(f"{A}packageName", ""), (ref.get(f"{A}description", "") or "")[:40]))
    if not lines:
        return f"'{query}' 검색 결과 없음."
    return f"[검색: {query}] {len(lines)}건\n  {'이름':<30} {'타입':<10} {'패키지':<12} 설명\n" + "\n".join(lines)


def _freestyle(sql, rows=200):
    """datapreview 로 자유 SELECT 를 돌린다. 쓰기는 가드가 막는다."""
    srv = prod()
    resp = srv.post(
        "/sap/bc/adt/datapreview/freestyle",
        params={"rowNumber": rows, "sap-client": srv.client},
        headers={"Content-Type": "text/plain; charset=utf-8", "Accept": "*/*"},
        data=sql.encode("utf-8"),
    )
    if not resp.ok:
        raise RuntimeError(f"쿼리 실패 ({resp.status_code}): {resp.text[:400]}")
    return eo.parse_datapreview(resp.text)


def _fmt_table(columns, rows, limit=60):
    if not rows:
        return "(결과 없음)"
    w = [max(len(c), *(len(str(r[i])) for r in rows[:limit])) for i, c in enumerate(columns)]
    w = [min(x, 28) for x in w]
    out = ["  " + " | ".join(c[:w[i]].ljust(w[i]) for i, c in enumerate(columns))]
    out.append("  " + "-+-".join("-" * x for x in w))
    for r in rows[:limit]:
        out.append("  " + " | ".join(str(r[i])[:w[i]].ljust(w[i]) for i in range(len(columns))))
    if len(rows) > limit:
        out.append(f"  … {len(rows) - limit}행 더 있음")
    return "\n".join(out)


def tool_count_rows(args):
    """전체 건수. 행을 가져오지 않으므로 2,000행 상한과 무관하다."""
    table = str(args.get("table", "")).strip().upper()
    if not table:
        return "table 인자가 필요합니다."
    where = (args.get("where") or "").strip()
    sql = f"SELECT COUNT(*) AS CNT FROM {table}"
    if where:
        sql += f" WHERE {where}"
    cols, rows = _freestyle(sql, rows=1)
    cnt = rows[0][0] if rows else "0"
    cond = f" (조건: {where})" if where else ""
    return f"[{table}] 총 {int(str(cnt).strip() or 0):,}건{cond}"


def tool_aggregate(args):
    """컬럼별 건수 집계. '상태값 분포', '월별 건수' 같은 질문에 쓴다."""
    table = str(args.get("table", "")).strip().upper()
    group_by = str(args.get("group_by", "")).strip()
    if not table or not group_by:
        return "table 과 group_by 인자가 필요합니다."
    where = (args.get("where") or "").strip()
    sql = f"SELECT {group_by}, COUNT(*) AS CNT FROM {table}"
    if where:
        sql += f" WHERE {where}"
    sql += f" GROUP BY {group_by} ORDER BY COUNT(*) DESCENDING"
    cols, rows = _freestyle(sql, rows=200)
    total = sum(int(str(r[-1]).strip() or 0) for r in rows)
    cond = f" (조건: {where})" if where else ""
    head = f"[{table}] {group_by} 별 건수 — {len(rows)}개 그룹 · 합계 {total:,}건{cond}"
    return head + "\n" + _fmt_table(cols, rows)


_FORBIDDEN = re.compile(
    r"(INSERT|UPDATE|DELETE|MODIFY|DROP|CREATE|ALTER|TRUNCATE|COMMIT|ROLLBACK|CALL)", re.I)


def tool_run_select(args):
    """집계·조인이 필요한 질문용 자유 SELECT. SELECT 외에는 거부한다."""
    sql = str(args.get("sql", "")).strip().rstrip(";")
    if not sql:
        return "sql 인자가 필요합니다."
    if not sql.upper().lstrip().startswith("SELECT"):
        return "SELECT 문만 실행할 수 있습니다."
    if _FORBIDDEN.search(sql) or ";" in sql:
        return "읽기 전용입니다 — 변경 구문이나 여러 문장은 실행할 수 없습니다."
    rows_cap = min(int(args.get("rows", 200) or 200), 500)
    cols, rows = _freestyle(sql, rows=rows_cap)
    return f"[쿼리] {len(rows)}행\n{sql}\n\n" + _fmt_table(cols, rows)


TOOLS = {
    "count_rows": tool_count_rows,
    "aggregate": tool_aggregate,
    "run_select": tool_run_select,
    "query_table": tool_query_table,
    "read_source": tool_read_source,
    "search_object": tool_search_object,
}

# 브라우저가 AI 에게 넘길 도구 정의(OpenAI 형식). 워커가 스스로 알려준다.
TOOL_SPECS = [
    {
        "type": "function",
        "function": {
            "name": "count_rows",
            "description": ("테이블의 전체 건수를 센다. 행을 가져오지 않아 2,000행 상한과 무관하다. "
                            "'몇 건인지' 묻는 질문에는 query_table 대신 반드시 이것을 쓴다."),
            "parameters": {
                "type": "object",
                "properties": {
                    "table": {"type": "string", "description": "테이블명"},
                    "where": {"type": "string", "description": "SQL WHERE 조건 (선택)"},
                },
                "required": ["table"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "aggregate",
            "description": ("컬럼별 건수를 집계한다. '상태값 분포', '월별 건수', '거래처별 건수' 같은 "
                            "질문에 쓴다. 전체를 대상으로 하므로 2,000행 상한과 무관하다."),
            "parameters": {
                "type": "object",
                "properties": {
                    "table": {"type": "string", "description": "테이블명"},
                    "group_by": {"type": "string",
                                 "description": "묶을 컬럼. 쉼표로 여러 개 가능 (예: ZBP_STATUS 또는 VKORG, ZBP_STATUS)"},
                    "where": {"type": "string", "description": "SQL WHERE 조건 (선택)"},
                },
                "required": ["table", "group_by"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_select",
            "description": ("자유 SELECT 를 실행한다. 조인이나 복잡한 집계가 필요할 때 쓴다. "
                            "SELECT 만 허용되고 변경 구문은 거부된다. 결과는 최대 500행."),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {"type": "string",
                            "description": "ABAP SQL SELECT 문. UP TO n ROWS 는 쓰지 않는다(rows 인자로 제어)"},
                    "rows": {"type": "integer", "description": "최대 행 수 (기본 200, 최대 500)"},
                },
                "required": ["sql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_table",
            "description": ("SAP 운영서버에서 테이블 데이터를 조회한다. 결과는 행 수·컬럼별 분포·"
                            "샘플 10행으로 요약되어 돌아온다. 개인정보 컬럼은 마스킹된다. "
                            "최대 2,000행만 읽으므로 전체 건수나 분포가 필요하면 "
                            "count_rows / aggregate 를 쓴다."),
            "parameters": {
                "type": "object",
                "properties": {
                    "table": {"type": "string", "description": "테이블명 (예: ZSDNT0110)"},
                    "where": {"type": "string", "description": "SQL WHERE 조건 (선택). 예: ERDAT >= '20260801'"},
                    "rows": {"type": "integer", "description": "최대 행 수 (기본 2000)"},
                },
                "required": ["table"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_source",
            "description": "ABAP 프로그램·인클루드·테이블 DDL 의 소스를 운영서버에서 읽는다.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string", "description": "오브젝트명 (예: ZSDNR0012)"}},
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_object",
            "description": ("이름 일부로 오브젝트를 검색해 타입·패키지·설명을 찾는다. "
                            "이름만 알고 무엇인지 모를 때 가장 먼저 쓴다. 와일드카드 * 사용 가능."),
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "검색어 (예: ZSDNR00*)"}},
                "required": ["query"],
            },
        },
    },
]


# ── HTTP ─────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # HTTPS 페이지가 사설망(127.0.0.1)을 부를 때 크롬이 요구한다
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/healthz"):
            return self._json(200, {"ok": True, "tools": list(TOOLS)})
        if self.path.startswith("/tools"):
            return self._json(200, {"tools": TOOL_SPECS})
        self._json(404, {"error": "GET /healthz 또는 /tools"})

    def do_POST(self):
        if not self.path.startswith("/tool"):
            return self._json(404, {"error": "POST /tool"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._json(400, {"error": f"본문을 읽지 못했습니다: {e}"})

        name = req.get("name")
        args = req.get("arguments") or {}
        if isinstance(args, str):
            try: args = json.loads(args)
            except Exception: args = {}
        fn = TOOLS.get(name)
        if not fn:
            return self._json(400, {"error": f"알 수 없는 도구: {name}"})

        print(f"  → {name}({json.dumps(args, ensure_ascii=False)[:120]})", flush=True)
        try:
            with _LOCK:
                result = fn(args)
            print(f"    ← {len(result):,}자", flush=True)
            return self._json(200, {"result": result})
        except Exception as e:
            traceback.print_exc()
            return self._json(200, {"result": f"조회 실패: {e}"})

    def log_message(self, *a):
        pass          # 기본 액세스 로그는 끄고 위에서 직접 찍는다


def main():
    port = PORT
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    sys.stdout.reconfigure(encoding="utf-8")

    print("─" * 56)
    print("  SAP 로컬 워커")
    print(f"  http://127.0.0.1:{port}")
    print(f"  도구: {', '.join(TOOLS)}")
    print("  브라우저가 이 주소로 SAP 조회를 요청합니다. 창을 켜두세요.")
    print("─" * 56)

    # 접속정보를 미리 읽어 설정 오류를 지금 드러낸다
    try:
        eo.load_env()
        print("  접속정보 확인 OK")
    except Exception as e:
        print(f"  ⚠ 접속정보 로드 실패: {e}")

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
