"""SAP ADT REST API를 통한 오브젝트/데이터 조회 스크립트.

역할 분리:
  - DDL/구조 조회 : 항상 개발서버 -> src/{package}/{TABLE}.ddl.txt
  - 데이터 조회   : 기본 운영서버, --dev-data 옵션 시 개발서버 -> data/{package}/{TABLE}.xlsx
                    (테이블당 파일 1개, 조회할 때마다 덮어씀 - 이력 누적 안 함)

사용법:
  python explore_objects.py TABLE_NAME [ROW_COUNT] [--dev-data] [--where "SQL조건"] [--refresh]

--refresh 를 주지 않으면 src/{package}/{TABLE}.ddl.txt 가 이미 있을 때 개발서버 DDL 조회(quickSearch+source)를
건너뛰고 로컬 파일을 그대로 사용한다 (데이터 조회는 매번 새로 수행됨 - 데이터는 캐시 대상이 아님).
"""
import sys
import os
import re
import glob
import warnings
import xml.etree.ElementTree as ET

import requests
import openpyxl

warnings.filterwarnings("ignore", message="Unverified HTTPS request")

ENV_CANDIDATES = [".env", "접속정보.env"]


def load_env():
    path = next((p for p in ENV_CANDIDATES if os.path.exists(p)), None)
    if not path:
        raise FileNotFoundError("접속정보.env (또는 .env) 파일을 찾을 수 없습니다.")
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()

    sections = []
    current = {}
    for raw in lines:
        line = raw.strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not key or not value:
            continue
        if key in current:
            sections.append(current)
            current = {}
        current[key] = value
    if current:
        sections.append(current)

    if len(sections) < 2:
        raise ValueError("접속정보 파일에서 개발/운영 두 섹션을 찾지 못했습니다.")
    return sections[0], sections[1]


class AdtSession:
    """개발/운영 공용 ADT 세션. base_url + scheme fallback(https->http) 처리."""

    def __init__(self, base_url, user, password, client):
        self.user = user
        self.password = password
        self.client = client
        self.session = requests.Session()
        self.session.auth = (user, password)
        self.session.verify = False
        self.base_url = base_url.rstrip("/")
        self.csrf_token = None
        self._negotiate()

    def _try_discovery(self, base_url):
        return self.session.get(
            f"{base_url}/sap/bc/adt/discovery",
            params={"sap-client": self.client},
            headers={"X-CSRF-Token": "Fetch"},
            timeout=30,
        )

    def _negotiate(self):
        try:
            resp = self._try_discovery(self.base_url)
        except requests.exceptions.SSLError:
            if self.base_url.startswith("https://"):
                self.base_url = "http://" + self.base_url[len("https://"):]
                resp = self._try_discovery(self.base_url)
            else:
                raise
        self.csrf_token = resp.headers.get("X-CSRF-Token")
        if not self.csrf_token:
            raise RuntimeError(
                f"CSRF 토큰을 획득하지 못했습니다 (status={resp.status_code})."
            )

    def get(self, path, **kwargs):
        return self.session.get(f"{self.base_url}{path}", timeout=60, **kwargs)

    def post(self, path, **kwargs):
        headers = kwargs.pop("headers", {})
        headers.setdefault("X-CSRF-Token", self.csrf_token)
        url = f"{self.base_url}{path}"
        resp = self.session.post(url, headers=headers, timeout=60, **kwargs)

        # CSRF 토큰은 세션과 함께 만료된다. 세션을 오래 들고 쓰면 조회가 전부
        # 403 "CSRF token validation failed" 로 막히는데, 토큰만 다시 받으면 된다.
        # 여기서 처리해야 freestyle·where-used 등 POST 를 쓰는 모든 조회가 함께 산다.
        if resp.status_code == 403 and self._csrf_expired(resp):
            self._negotiate()
            headers["X-CSRF-Token"] = self.csrf_token
            resp = self.session.post(url, headers=headers, timeout=60, **kwargs)
        return resp

    @staticmethod
    def _csrf_expired(resp):
        """토큰 만료인지 권한 부족인지 가린다. 권한 문제면 다시 받아도 소용없다."""
        if str(resp.headers.get("x-csrf-token", "")).lower() == "required":
            return True
        return "csrf" in (resp.text or "")[:300].lower()


def find_package(dev, table):
    resp = dev.get(
        "/sap/bc/adt/repository/informationsystem/search",
        params={"operation": "quickSearch", "query": f"{table}*", "maxResults": 10, "sap-client": dev.client},
        headers={"Accept": "*/*"},
    )
    resp.raise_for_status()
    ns = {"adtcore": "http://www.sap.com/adt/core"}
    root = ET.fromstring(resp.text)
    for ref in root.iter("{http://www.sap.com/adt/core}objectReference"):
        name = ref.get("{http://www.sap.com/adt/core}name", "")
        if name.upper() == table.upper():
            return ref.get("{http://www.sap.com/adt/core}packageName", "UNKNOWN")
    return "UNKNOWN"


def find_local_ddl(table):
    """이미 받아둔 DDL이 있으면 (package, path)를 반환, 없으면 (None, None)."""
    matches = glob.glob(os.path.join("src", "*", f"{table}.ddl.txt"))
    if not matches:
        return None, None
    path = matches[0]
    package = os.path.basename(os.path.dirname(path))
    return package, path


def fetch_ddl(dev, table):
    resp = dev.get(f"/sap/bc/adt/ddic/tables/{table}/source/main", headers={"Accept": "*/*"})
    resp.raise_for_status()
    return resp.text


def fetch_data(server, table, row_count, where=None):
    # rowNumber 파라미터가 "INTO TABLE @DATA(...) UP TO n ROWS"를 자동 추가하므로
    # 쿼리 텍스트에 UP TO 절을 직접 넣으면 문법 오류(400)가 난다.
    query = f"SELECT * FROM {table}"
    if where:
        query += f" WHERE {where}"
    resp = server.post(
        "/sap/bc/adt/datapreview/freestyle",
        params={"rowNumber": row_count, "sap-client": server.client},
        headers={"Content-Type": "text/plain; charset=utf-8", "Accept": "*/*"},
        data=query.encode("utf-8"),
    )
    if not resp.ok:
        raise RuntimeError(f"data query failed ({resp.status_code}): {resp.text[:2000]}")
    return resp.text


NS_DP = "http://www.sap.com/adt/dataPreview"


def parse_datapreview(xml_text):
    """datapreview XML은 컬럼 단위(세로) 구조: <columns><metadata name=.../><dataSet><data/>...</dataSet></columns> 반복."""
    root = ET.fromstring(xml_text)
    columns = []
    column_values = []
    for col in root.findall(f"{{{NS_DP}}}columns"):
        meta = col.find(f"{{{NS_DP}}}metadata")
        name = meta.get(f"{{{NS_DP}}}name")
        dataset = col.find(f"{{{NS_DP}}}dataSet")
        values = [d.text if d.text is not None else "" for d in dataset.findall(f"{{{NS_DP}}}data")]
        columns.append(name)
        column_values.append(values)

    row_count = len(column_values[0]) if column_values else 0
    rows = [[column_values[c][r] for c in range(len(columns))] for r in range(row_count)]
    return columns, rows


def save_ddl(package, table, ddl_text):
    out_dir = os.path.join("src", package)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{table}.ddl.txt")
    # newline="" : 서버가 이미 \r\n을 포함해서 반환하므로 텍스트 모드 변환으로 인한 \r\r\n 중복을 방지
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        f.write(ddl_text)
    return out_path


def save_xlsx(package, table, columns, rows):
    # 테이블당 파일 1개만 유지 - 조회할 때마다 같은 경로에 덮어쓴다 (이력 누적 안 함).
    # 코드 분석 시에는 이 파일이 곧 "가장 최근" 데이터다.
    out_dir = os.path.join("data", package)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{table}.xlsx")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(columns)
    for row in rows:
        ws.append(row)
    wb.save(out_path)
    return out_path


def main():
    if len(sys.argv) < 2:
        print("사용법: python explore_objects.py TABLE_NAME [ROW_COUNT] [--dev-data] [--where \"조건\"] [--refresh]")
        sys.exit(1)

    table = sys.argv[1].upper()
    row_count = 2000
    use_dev_data = "--dev-data" in sys.argv
    refresh = "--refresh" in sys.argv
    where = None

    args = sys.argv[2:]
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--dev-data", "--refresh"):
            i += 1
            continue
        if a == "--where":
            where = args[i + 1]
            i += 2
            continue
        if a.isdigit():
            row_count = int(a)
        i += 1

    dev_cfg, prod_cfg = load_env()

    dev = None
    package, cached_path = (None, None) if refresh else find_local_ddl(table)

    if package:
        print(f"[package] {package} (로컬 캐시)")
        print(f"[ddl] 로컬 파일 재사용 -> {cached_path} (서버 조회 생략, --refresh로 강제 갱신 가능)")
    else:
        dev = AdtSession(dev_cfg["URL"], dev_cfg["SAP_USER"], dev_cfg["SAP_PASSWORD"], dev_cfg["SAP_CLIENT"])
        package = find_package(dev, table)
        print(f"[package] {package}")

        ddl_text = fetch_ddl(dev, table)
        ddl_path = save_ddl(package, table, ddl_text)
        print(f"[ddl] saved -> {ddl_path}")

    if use_dev_data and dev is None:
        dev = AdtSession(dev_cfg["URL"], dev_cfg["SAP_USER"], dev_cfg["SAP_PASSWORD"], dev_cfg["SAP_CLIENT"])

    data_server = dev if use_dev_data else AdtSession(
        prod_cfg["SAP_HOST"], prod_cfg["SAP_USER"], prod_cfg["SAP_PASSWORD"], prod_cfg["SAP_CLIENT"]
    )

    xml_text = fetch_data(data_server, table, row_count, where=where)
    columns, rows = parse_datapreview(xml_text)
    xlsx_path = save_xlsx(package, table, columns, rows)
    print(f"[data] {len(rows)} rows -> {xlsx_path}")


if __name__ == "__main__":
    main()
