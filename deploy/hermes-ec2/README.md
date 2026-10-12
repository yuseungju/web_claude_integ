# Hermes 를 AWS EC2 에 올리기

`/sap` 이 쓰는 AI 백엔드다. 로컬 PC 를 꺼도 동작하게 하려고 EC2 에 둔다.

```
브라우저 → Amplify(/sap) → API Gateway → Lambda(sap.js)
                                             │ HTTP + X-Proxy-Token
                                             ▼
                              EC2 :8646  authproxy.js   (인증)
                                             ▼
                                   127.0.0.1:8645  hermes proxy
                                             ▼
                                        Nous Portal → 모델
```

**왜 authproxy 가 필요한가** — `hermes proxy` 는 "any bearer token" 을 받는다. 즉 자체
인증이 없다. 0.0.0.0 으로 열면 주소를 아는 누구나 이 계정으로 추론을 돌릴 수 있어서,
공개 포트는 authproxy 가 잡고 공유 비밀값이 맞을 때만 뒤로 넘긴다.

**대화 기억은 EC2 에 쌓인다** — Nous Portal 은 응답을 저장하지 않는다
(`previous_response_id is not supported: this gateway does not store responses`).
저장하는 쪽은 `hermes proxy` 다. 그래서 이 인스턴스가 곧 대화 메모리의 보관처다.
EC2 를 날리면 이어가던 대화도 끊긴다 — 메시지 사본은 RDS(`sap_messages`)에 따로 남는다.

---

## 1. EC2 인스턴스

| | |
|---|---|
| AMI | **Ubuntu 24.04 LTS (arm64)** — Hermes 의 Dockerfile 이 Debian 13 기반이라 데비안 계열이 안전하다 |
| 타입 | `t4g.small` (Hermes 는 Python 앱이라 1GB 는 빠듯하다) |
| 스토리지 | 20GB |
| 보안그룹 | 인바운드 **8646** 만 — 소스는 아래 참고. SSH 는 본인 IP 로 제한 |

**보안그룹 소스를 어떻게 잡나**

- Lambda 가 VPC 밖(현재 구성)이면 고정 IP 가 없다 → `0.0.0.0/0` 으로 열되
  **반드시 `PROXY_TOKEN` 으로 막는다**(authproxy 가 그 역할).
- 더 조이려면 Lambda 를 VPC 에 넣고 보안그룹끼리 허용한다. 그때는 RDS 접근 경로도
  같이 점검해야 한다.

---

## 2. Hermes 설치 + 로그인

```bash
sudo apt-get update && sudo apt-get install -y curl git

# 공식 설치 스크립트 (PC 에 설치된 것과 같은 경로다)
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
exec $SHELL -l          # PATH 반영

hermes --version
hermes portal          # Nous Portal OAuth 로그인 — 브라우저 코드 입력 방식
hermes proxy providers # nous 가 보이면 준비 완료
hermes proxy status
```

**ChatGPT 플랜으로 추론비를 커버하려면** 포털(브라우저)에서
`Account → Linked accounts → Continue with ChatGPT` 를 먼저 연결해 둔다.
연결은 Nous 계정에 묶이므로, EC2 의 Hermes 가 그 계정으로 로그인돼 있으면 적용된다.
(한도는 ChatGPT 플랜을 따르고, 도구·Hermes Cloud 는 별도 과금이다.)

---

## 3. 파일 배치 + 서비스 등록

```bash
# 이 디렉토리를 EC2 로 복사
scp -r deploy/hermes-ec2 ec2-user@<EC2>:/home/ubuntu/

cd /home/ubuntu/hermes-ec2
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 토큰 생성
vi .env            # PROXY_TOKEN 에 붙여넣기

sudo cp hermes-proxy.service authproxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-proxy authproxy
systemctl status hermes-proxy authproxy --no-pager
```

`hermes-proxy.service` 의 `ExecStart` 경로는 실제 설치 위치에 맞게 고친다
(`which hermes` 로 확인).

**확인**

```bash
curl -s localhost:8646/healthz                 # → ok
curl -s -X POST localhost:8646/v1/responses \
  -H 'Content-Type: application/json' -H "X-Proxy-Token: $(grep PROXY_TOKEN .env | cut -d= -f2)" \
  -d '{"input":"1+1?","store":true}' | head -c 300
```

---

## 4. Lambda 환경변수

```
HERMES_URL   = http://<EC2 퍼블릭 또는 사설 IP>:8646
PROXY_TOKEN  = (위에서 만든 값과 동일)
AI_MODEL     = (선택) 예: openai/gpt-5.3-codex — 비우면 hermes 기본 모델
```

---

## 5. 배포

```bash
git add -A && git commit -m "feat(sap): /sap 운영문의 AI — EC2 hermes proxy 연동"
git push
```

- GitHub Actions → `lambda/**` 배포
- Amplify → `dist/` 프론트 + `db/schema_all.sql` RDS 반영

---

## 6. 동작 확인

```
https://<Amplify 도메인>/sap/
```

1. 아무 질문 → 답변이 오면 전 구간 연결 완료
2. 이어서 "방금 말한 거 다시 설명해줘" → 메타줄에 **`이어진 대화`** 가 뜨면 연속성 OK
3. `GET /sap/health` → `{"hermes":"ok"}`
4. `GET /sap/usage?userKey=...` → 모델별 토큰·지연 집계

---

## 지금 범위에서 빠져 있는 것

- **SAP 조회** — 사내망이 막혀 있어 아직 도구를 붙이지 않았다. 조회가 필요한 질문이면
  AI 가 "어떤 테이블을 어떤 조건으로 조회해야 하는지"를 알려주고, 조회 없이 답할 수 있는
  질문(개념·ABAP 문법·붙여넣은 소스 분석·앞 대화)은 그대로 답한다.
  접근이 열리면 `sap_summary.py` 를 워커로 띄우고 도구로 등록한다.
- **HTTPS** — 현재 Lambda→EC2 구간이 평문 HTTP 다. 토큰으로 인증은 하지만 내용은
  가려지지 않는다. **ABAP 운영 소스를 넣기 전에** ALB+ACM 이나 Caddy 로 TLS 를 붙인다.
- **로그인 연동** — `userKey` 를 브라우저가 만들어 보낸다. 팀에 열 때는 기존 `/auth` 와 묶는다.
