"""조회 결과를 AI에 넣을 수 있는 크기로 요약한다.

2,000행을 그대로 프롬프트에 넣으면 약 50,000 토큰이다. 같은 내용을 행 수·컬럼 분포·
샘플로 압축하면 1,000 토큰 안쪽이고, 원인 분석에 필요한 정보는 거의 다 남는다.
(토큰이 비용의 대부분을 차지하므로 이 함수가 운영비를 좌우한다.)

explore_objects.py 의 세션/조회 로직을 그대로 재사용하며, 그 파일은 건드리지 않는다.

사용:
    python sap_summary.py TABLE [행수] [--where "조건"] [--dev]

    from sap_summary import query_summary
    text = query_summary("ZSDNT0110", 2000, where="ERDAT >= '20260801'")
"""
import re
import sys
import collections

import explore_objects as eo

# CLAUDE.md: 개인식별정보로 보이는 컬럼은 마스킹해서 보여준다
PII_RE = re.compile(r"NAME\d?$|^NAME|EMAIL|SMTP|TEL$|TELF|MOBILE|PHONE|JUMIN|BIRTH", re.I)

DATE_RE = re.compile(r"^\d{8}$")
TS_RE = re.compile(r"^\d{14}(\d{1,7})?$")   # YYYYMMDDHHMMSS (+ TIMESTAMPL 소수부)
NUM_RE = re.compile(r"^-?\d+(\.\d+)?-?$")

MAX_SAMPLE = 10          # 샘플로 보여줄 행 수
MAX_SAMPLE_COLS = 10     # 샘플 표에 넣을 컬럼 수
LOW_CARD = 8             # 고유값이 이 이하면 값 분포를 전부 보여준다
CELL_W = 16


def mask(v):
    v = str(v)
    if len(v) <= 2:
        return "*" * len(v)
    return v[0] + "*" * (len(v) - 2) + v[-1]


def _num(v):
    """ABAP 수치는 음수 부호가 뒤에 붙는다(1234-). 파이썬 숫자로 바꾼다."""
    s = str(v).strip()
    if not s:
        return None
    neg = s.endswith("-")
    if neg:
        s = s[:-1]
    try:
        n = float(s)
    except ValueError:
        return None
    return -n if neg else n


def _fmt(n):
    if n == int(n):
        return f"{int(n):,}"
    return f"{n:,.2f}"


def _col_summary(name, values):
    """컬럼 하나를 한 줄로 요약. 분석에 쓸모없는 줄은 None 을 돌려 생략한다."""
    nonblank = [v for v in values if str(v).strip() not in ("", "00000000", "0")]
    total = len(values)

    # 전부 비어 있는 컬럼 — ABAP 원인 분석에서 가장 중요한 단서 중 하나
    if not nonblank:
        return f"{name:<14} (전 행 공백/0)"

    uniq = collections.Counter(str(v).strip() for v in nonblank)
    blanks = total - len(nonblank)
    blank_note = f" · 공백 {blanks}건" if blanks else ""

    # 날짜 (YYYYMMDD)
    if all(DATE_RE.match(str(v).strip()) for v in nonblank):
        lo, hi = min(uniq), max(uniq)
        return f"{name:<14} {lo}~{hi} · 고유 {len(uniq)}{blank_note}"

    # 타임스탬프 (YYYYMMDDHHMMSS). 합계를 내면 무의미한 숫자가 나오므로 범위로 본다.
    if all(TS_RE.match(str(v).strip()) for v in nonblank):
        lo, hi = min(uniq), max(uniq)
        fmt = lambda t: f"{t[:4]}-{t[4:6]}-{t[6:8]} {t[8:10]}:{t[10:12]}"
        return f"{name:<14} {fmt(lo)}~{fmt(hi)} · 고유 {len(uniq)}{blank_note}"

    if PII_RE.search(name):
        return f"{name:<14} 고유 {len(uniq)}건 (개인정보 — 값 생략){blank_note}"

    # 선행 0이 붙은 값은 금액이 아니라 코드/키다(VBELN 001234000, KUNNR 0001000123).
    # 합계를 내면 무의미하므로 범위·고유 개수로만 요약한다.
    is_code = any(len(k) > 1 and k[0] == "0" for k in uniq)

    # 고유값이 적으면 분포를 전부 보여준다 (상태코드·구분자 등)
    if len(uniq) <= LOW_CARD:
        dist = ", ".join(f"{k}({c})" for k, c in uniq.most_common())
        return f"{name:<14} {dist}{blank_note}"

    if is_code:
        top, cnt = uniq.most_common(1)[0]
        return (f"{name:<14} 코드/키 · 고유 {len(uniq)}건 · {min(uniq)}~{max(uniq)}"
                f" · 최빈 {top}({cnt}){blank_note}")

    # 수치
    nums = [_num(v) for v in nonblank]
    if all(n is not None for n in nums) and any(n != 0 for n in nums):
        return (f"{name:<14} 합계 {_fmt(sum(nums))} · 평균 {_fmt(sum(nums)/len(nums))}"
                f" · 최대 {_fmt(max(nums))} · 최소 {_fmt(min(nums))}{blank_note}")

    top, cnt = uniq.most_common(1)[0]
    return f"{name:<14} 고유 {len(uniq)}건 · 최빈 {top}({cnt}){blank_note}"


def summarize(table, columns, rows, row_limit=None, where=None):
    """조회 결과 → AI 프롬프트용 요약 텍스트."""
    n = len(rows)
    out = []

    head = f"[{table}] {n:,}행"
    if row_limit and n >= row_limit:
        head += f" (조회 상한 {row_limit:,} 도달 — 실제 더 있을 수 있음)"
    if where:
        head += f" · 조건: {where}"
    out.append(head)

    if n == 0:
        out.append("조회 결과 없음.")
        return "\n".join(out)

    out.append(f"컬럼 {len(columns)}개: " + ", ".join(columns))
    out.append("")
    out.append("컬럼별 분포")
    for i, c in enumerate(columns):
        line = _col_summary(c, [r[i] for r in rows])
        if line:
            out.append("  " + line)

    # 샘플 행
    keep = list(range(min(len(columns), MAX_SAMPLE_COLS)))
    pii = {i for i in keep if PII_RE.search(columns[i])}

    def cell(r, i):
        v = str(rows[r][i])
        if i in pii and v.strip():
            v = mask(v)
        return v[:CELL_W - 1] + "…" if len(v) > CELL_W else v

    widths = [max(len(columns[i]), *(len(cell(r, i)) for r in range(min(n, MAX_SAMPLE))))
              for i in keep]
    widths = [min(w, CELL_W) for w in widths]

    out.append("")
    out.append(f"샘플 {min(n, MAX_SAMPLE)}행"
               + (f" (컬럼 {len(columns) - len(keep)}개 생략)" if len(columns) > len(keep) else ""))
    out.append("  " + " | ".join(columns[i][:widths[k]].ljust(widths[k]) for k, i in enumerate(keep)))
    for r in range(min(n, MAX_SAMPLE)):
        out.append("  " + " | ".join(cell(r, i).ljust(widths[k]) for k, i in enumerate(keep)))

    return "\n".join(out)


_SESSIONS = {}


def _session(dev=False):
    """세션을 재사용한다. 도구를 여러 번 부를 때마다 로그인하면 느리다."""
    key = "dev" if dev else "prod"
    if key not in _SESSIONS:
        dev_cfg, prod_cfg = eo.load_env()
        if dev:
            c = dev_cfg
            _SESSIONS[key] = eo.AdtSession(c["URL"], c["SAP_USER"], c["SAP_PASSWORD"], c["SAP_CLIENT"])
        else:
            c = prod_cfg
            _SESSIONS[key] = eo.AdtSession(c["SAP_HOST"], c["SAP_USER"], c["SAP_PASSWORD"], c["SAP_CLIENT"])
    return _SESSIONS[key]


def query_summary(table, rows=2000, where=None, dev=False):
    """운영(기본)/개발 서버를 조회해 요약 텍스트를 돌려준다. 세션 만료 시 1회 재시도."""
    table = table.upper()
    try:
        xml = eo.fetch_data(_session(dev), table, rows, where=where)
    except Exception:
        _SESSIONS.pop("dev" if dev else "prod", None)
        xml = eo.fetch_data(_session(dev), table, rows, where=where)
    cols, data = eo.parse_datapreview(xml)
    return summarize(table, cols, data, row_limit=rows, where=where)


def main():
    if len(sys.argv) < 2:
        print('사용법: python sap_summary.py TABLE [행수] [--where "조건"] [--dev]')
        sys.exit(1)
    table = sys.argv[1]
    args = sys.argv[2:]
    rows, where, dev = 2000, None, "--dev" in args
    i = 0
    while i < len(args):
        if args[i] == "--where":
            where = args[i + 1]; i += 2; continue
        if args[i].isdigit():
            rows = int(args[i])
        i += 1

    text = query_summary(table, rows, where=where, dev=dev)
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)
    print()
    print(f"--- 요약 길이 {len(text):,}자 (대략 {len(text)//2:,} 토큰) ---")


if __name__ == "__main__":
    main()
