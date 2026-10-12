"""SAP 조회 MCP 서버 — Hermes 에이전트가 직접 쓰는 도구.

왜 MCP 인가
    목표 구조는 "에이전트가 스스로 SAP 을 조회하며 분석"이다. 그러려면 도구가
    에이전트 쪽에 등록돼 있어야 한다. MCP 로 만들어 두면 등록이 설정 한 줄이고,
    로컬에서 검증한 그대로 EC2 로 옮길 수 있다(경로만 바뀐다).

        로컬:  브라우저 → Lambda → 로컬 Hermes → 이 MCP → 사내망 SAP
        AWS :  브라우저 → Lambda → EC2 Hermes  → 이 MCP → 사내망 SAP (VPC)

등록 (~/.hermes/config.yaml)
    mcp_servers:
      sap:
        command: python
        args: ["C:/ABAP_NOL/sap_mcp.py"]

프로토콜은 JSON-RPC 2.0 over stdio 다. 의존성을 늘리지 않으려고 직접 구현했다.
stdout 은 프로토콜 전용이므로 로그는 전부 stderr 로 보낸다.

조회 로직은 sap_worker.py 를 그대로 재사용한다 — 운영 전용이고 쓰기는 차단돼 있다.
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

import json
import sys
import traceback

import sap_worker as W

PROTOCOL_DEFAULT = "2024-11-05"
SERVER_INFO = {"name": "sap-adt", "version": "1.0.0"}

# sap_worker 의 OpenAI 형식 도구 정의를 MCP 형식으로 옮긴다.
TOOLS = [
    {
        "name": spec["function"]["name"],
        "description": spec["function"]["description"],
        "inputSchema": spec["function"]["parameters"],
    }
    for spec in W.TOOL_SPECS
]


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply(req_id, result):
    send({"jsonrpc": "2.0", "id": req_id, "result": result})


def error(req_id, code, message):
    send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def handle(msg):
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}

    # 알림(id 없음)은 응답하지 않는다
    if req_id is None:
        if method == "notifications/initialized":
            log("초기화 완료")
        return

    if method == "initialize":
        ver = params.get("protocolVersion") or PROTOCOL_DEFAULT
        log(f"initialize (protocol {ver})")
        return reply(req_id, {
            "protocolVersion": ver,
            "capabilities": {"tools": {}},
            "serverInfo": SERVER_INFO,
        })

    if method == "tools/list":
        return reply(req_id, {"tools": TOOLS})

    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        fn = W.TOOLS.get(name)
        if not fn:
            return error(req_id, -32602, f"알 수 없는 도구: {name}")

        log(f"→ {name}({json.dumps(args, ensure_ascii=False)[:120]})")
        try:
            with W._LOCK:
                out = fn(args)
            log(f"  ← {len(out):,}자")
            return reply(req_id, {"content": [{"type": "text", "text": out}]})
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            # 도구 실패는 프로토콜 오류가 아니라 "실패한 결과"로 돌려준다.
            # 그래야 모델이 다른 방법을 찾아볼 수 있다.
            return reply(req_id, {
                "content": [{"type": "text", "text": f"조회 실패: {e}"}],
                "isError": True,
            })

    if method == "ping":
        return reply(req_id, {})

    return error(req_id, -32601, f"지원하지 않는 메서드: {method}")


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    log(f"SAP MCP 서버 시작 — 도구 {len(TOOLS)}개: {', '.join(t['name'] for t in TOOLS)}")
    try:
        import explore_objects as eo
        eo.load_env()
        log("접속정보 확인 OK (운영 전용 · 쓰기 차단)")
    except Exception as e:
        log(f"⚠ 접속정보 로드 실패: {e}")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            log(f"JSON 파싱 실패: {e}")
            continue
        try:
            handle(msg)
        except Exception:
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
