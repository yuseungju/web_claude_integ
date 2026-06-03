# 뉴스 제보 / 기사 작성 플랫폼 — 전체 기술 스펙

## 1. 프로젝트 개요

**서비스명**: 뉴스 제보 / 기사 작성  
**용도**: 기자/작성자가 이슈를 등록하고, 섹션별로 기사를 작성·AI로 정리하여 완성 기사를 게시하는 웹 플랫폼  
**배포**: AWS Amplify (정적 프론트), AWS Lambda + API Gateway (백엔드), PostgreSQL RDS, S3 (미사용 → 제거됨)

---

## 2. 기술 스택

| 레이어 | 기술 |
|--------|------|
| 프론트엔드 | 순수 HTML/CSS/JS (프레임워크 없음), 3개 페이지 |
| 백엔드 | AWS Lambda (Node.js 24), 단일 함수, API Gateway HTTP API |
| DB | PostgreSQL (AWS RDS), SSL 연결 |
| AI | Anthropic Claude API (Haiku 4.5, Sonnet 4.6) |
| 인증 | JWT (bcryptjs, jsonwebtoken), localStorage |
| 배포 | GitHub → AWS Amplify 자동배포 (프론트), GitHub Actions → Lambda (백엔드) |

### 환경변수 (Lambda)
```
DB_HOST, DB_NAME, DB_USER, DB_PASSWORD
JWT_SECRET
ANTHROPIC_API_KEY
```

---

## 3. DB 스키마

```sql
-- 사용자
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  writing_style TEXT DEFAULT '',       -- AI 생성 시 참고 (현재 UI 미노출)
  article_style TEXT DEFAULT '',       -- 기사 완성본 스타일 (AI 다듬기 참고)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 이슈(기사 주제)
CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category VARCHAR(50) DEFAULT '문화',  -- 분류
  is_draft BOOLEAN DEFAULT TRUE,
  article_content TEXT DEFAULT '',      -- 완성 기사 본문
  view_count INT DEFAULT 0,
  reference_links JSONB DEFAULT '[]',  -- AI 이슈만들기 시 RSS 참고링크
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 섹션 (이슈당 5개 고정)
CREATE TABLE issue_sections (
  issue_id INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  section_no INT NOT NULL CHECK (section_no BETWEEN 1 AND 5),
  content TEXT DEFAULT '',
  guide TEXT DEFAULT '',        -- 섹션별 작성 가이드 (영구저장)
  ai_content TEXT DEFAULT '',   -- AI 작성 결과 (우측 미리보기)
  label TEXT DEFAULT '',        -- 섹션 커스텀 제목
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (issue_id, section_no)
);

-- 섹션 편집자 지정
CREATE TABLE issue_section_editors (
  issue_id INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  section_no INT NOT NULL,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, section_no)
);

-- 조회 기록 (계정당 1회)
CREATE TABLE issue_views (
  issue_id INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (issue_id, user_id)
);

-- 이슈 좋아요/싫어요
CREATE TABLE issue_reactions (
  issue_id INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction VARCHAR(10) NOT NULL CHECK (reaction IN ('like','dislike')),
  PRIMARY KEY (issue_id, user_id)
);

-- 댓글
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  issue_id INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 댓글 좋아요/싫어요
CREATE TABLE comment_reactions (
  comment_id INT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction VARCHAR(10) NOT NULL CHECK (reaction IN ('like','dislike')),
  PRIMARY KEY (comment_id, user_id)
);

-- 사용자별 섹션 가이드 (영구저장)
CREATE TABLE user_section_guides (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_no INT NOT NULL CHECK (section_no BETWEEN 1 AND 5),
  guide TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, section_no)
);

-- 사용자별 섹션 제목 기본값 (기사 완료 시 저장)
CREATE TABLE user_section_labels (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_no INT NOT NULL CHECK (section_no BETWEEN 1 AND 5),
  label TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, section_no)
);

-- 링크 북마크 폴더
CREATE TABLE link_folders (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 링크 북마크
CREATE TABLE link_bookmarks (
  id SERIAL PRIMARY KEY,
  folder_id INT NOT NULL REFERENCES link_folders(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT DEFAULT '',
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. 페이지 구성

### 4-1. issues.html — 이슈 목록 (메인 페이지)

**레이아웃**
- 상단 헤더: 로고(클릭 시 목록으로), 오른쪽 로그인/로그아웃
- 툴바: 분류 select + AI 이슈 만들기 버튼 + 이슈 만들기 버튼
- 필터바: 제목검색, 작성일, 작성자, 분류, [내가 작성한 글] [작성중인 글] [편집 배정된 글] 토글, 초기화, 검색
- 베스트 글 섹션 (좋아요 최다 글들, 첫 페이지만)
- 테이블: 번호·제목·분류·조회+좋아요·작성자·작성일·상태·편집/삭제

**기능 상세**
- 비로그인: 완료된 이슈만 조회
- 로그인: 완료 + 본인 작성 + 편집 배정된 초안 조회
- 필터: 제목 키워드(ILIKE), 작성일(DATE 일치), 작성자(ILIKE), 분류(= 일치)
- 토글 필터:
  - 내가 작성한 글: user_id = 본인
  - 작성중인 글: is_draft = true
  - 편집 배정된 글: issue_section_editors에 본인 user_id 있는 이슈
- 페이징: 30건/페이지, 전체 건수 역순 번호
- 작성일: `26. 06. 03. 14:25:37` 형식 (초까지)
- 작성자 클릭: 해당 작성자 필터 자동 적용
- 제목 hover: title 속성으로 전체 제목 툴팁
- 제목이 draft이면 링크가 `?mode=edit`으로 바로 편집 진입
- 좋아요 많으면 행 연한파랑, 싫어요 많으면 연한주황, 방금 생성하면 연한남색
- 베스트 글: 좋아요 최다건수 동점 전체 표시

**AI 이슈 만들기**
1. 클릭 → 인라인 입력창 (버튼 비활성화)
2. 제목 입력 → AI 저장:
   - Haiku: 제목에서 핵심 명사 4개 추출
   - Google News RSS 검색 (최신순 25건)
   - 결과 없으면 에러 토스트, 이슈 미생성
   - Haiku: 제목 다듬기 (실패 메시지 반환 시 원본 유지)
   - 이슈 저장 + reference_links 저장
3. 생성 후 "방금 작성" 배지 표시

**일반 이슈 만들기**
- 인라인 입력창에서 제목 입력 → 저장 (AI 없음, 참고링크 없음)

---

### 4-2. write.html — 이슈 편집/조회

#### 조회 모드 (`?id=N`)
- 상단: 이슈 제목 (0.98rem)
- 작성자, 작성일시(초포함), 조회수 표시
- 이슈 좋아요/싫어요 버튼 (👍/👎, 토글, 로그인 필요)
- 작성자/편집권한자에게 편집 버튼 노출
- 작성자에게 삭제 버튼 노출
- 기사 본문: 완성 텍스트를 기사 형식으로 표시 (섹션 없음, textarea 아님)
- 조회 시 로그인 유저 view_count +1 (계정당 1회)
- 하단 댓글 섹션

#### 편집 모드 (`?id=N&mode=edit` 또는 신규 `?없음`)

**상단 영역**
- 이슈 제목 입력 (작성자만), 작성자 정보
- 편집 시 로그인 유저는 조회수+1 (이미 처리됨)

**참고자료 패널 (편집 모드)**
- `savedRefLinks` (reference_links): 편집 진입 시 자동 로드, 편집 가능 목록으로 표시
- 각 링크 ✕ 삭제 가능
- URL 직접 추가 (제목 선택 입력)
- 참고링크 없으면 섹션 자동채우기 버튼 비활성

**섹션 툴바 (편집 모드)**
- 🤖 섹션 자동채우기: 참고링크 URL 실제 조회 → 섹션 내용 일괄 생성 (Haiku)
  - 참고링크 없으면 비활성
  - 결과 없으면 "참고할 내용이 없습니다" 토스트

**섹션 카드 5개**  
각 섹션 구조:
```
[섹션 번호] [섹션 제목 (편집 가능 input, Enter키 저장)] [편집자 지정 영역(작성자만)]
[섹션 컨트롤바: 📝 작성 가이드 설정 버튼 | ✨ AI작성 버튼] ← 편집 가능 섹션만
[2칸 레이아웃]
  좌측: 내용 입력 textarea (rows=8, 내용 없으면 AI작성 비활성)
  우측: AI 작성 결과 (height 195px 고정, scroll)
        [📋 복사] [✅ 적용] 버튼
        하단: "💡 AI 내용을 활용하려면 좌측에 붙여넣고 편집하세요"
        자동채우기 후: 출처 링크 표시
[편집자 지정 폼 (작성자만)]
```

**섹션 관련 AI 기능**
- 작성 가이드 팝업: 긴 텍스트 입력, 영구 저장 (user_section_guides), 4자 이상 = "설정됨" 표시
- ✨ AI작성 (Sonnet, max_tokens 800): 좌측내용 + 가이드 + 마이페이지 스타일 반영
  - 재클릭 시 우측 패널 전체 초기화
- 섹션 제목 Enter: user_section_labels 즉시 저장, 토스트 표시
- 편집자 지정: 이메일로 사용자 검색 후 섹션 배정

**하단 액션바**
- 📌 임시저장: is_draft=true, 섹션+가이드+라벨+AI내용+guides 저장
- ✅ 기사 작성 완료: is_draft=false, 기사본문 10자 이상 필요, 섹션 라벨 user_section_labels에 저장

**기사 본문 패널 (✨ 기사 본문)**
- 헤더에 실시간 글자수 표시
  - 기준 800자: ~960자 회색, 961~1119자 주황, 1120자+ 빨강+AI비활성
- 버튼들 (편집 모드):
  - 📥 가져오기: 5섹션 내용 합쳐서 textarea에 입력 → AI 다듬기 버튼 활성
  - 🤖 AI로 다듬기: 가져오기 후에만 활성, 클릭 시 미리보기 팝업 표시 (본문 수정 안 함)
  - 🎨 스타일: 기사 완성본 스타일 입력 팝업 (영구저장, AI 다듬기 시 반영)
  - 복사 버튼
- rows=30, min-height 780px, resize vertical

**AI 다듬기 미리보기 팝업**
- 팝업에 제목 + 다듬어진 기사 표시 (0.82rem 소형 글자, 55vh scroll)
- 닫기 / 📋 복사 / ✅ 본문에 적용
- 본문에 적용 시 textarea 업데이트 + 글자수 갱신

**AI 다듬기 모델 (generateArticle)**
- 다듬기 모드 (content 전달): Haiku, max_tokens 6000
  - 원고 내용 유지, 맞춤법·문법·표현만 교정
  - article_style 반영 (글 구조·분량·톤)
- 섹션 기반 생성: Sonnet, max_tokens 3000

**조회 모드에서 기사 본문**
- textarea 대신 styled div로 기사 텍스트 표시

**댓글 섹션 (조회 모드)**
- 댓글 목록: 작성자, 날짜시간(초포함), 내용
- 각 댓글 좋아요/싫어요 (토글, 활성 시 색상 변경)
- 본인 댓글 삭제
- 댓글 등록 (로그인 필요, 미로그인 시 클릭하면 로그인 모달)

---

### 4-3. mypage.html — 마이페이지

**프로필**
- 이름, 이메일 표시

**내 기사 링크 (북마크)**
- + 폴더 만들기 → 인라인 이름 입력 → 생성
- 폴더 목록 (클릭으로 펼치기/접기)
- 각 폴더: 폴더명, 링크 수, 🗑 폴더 삭제 (링크 일괄 삭제)
- 폴더 내 링크: URL + 제목 + ✕ 삭제
- 링크 추가: URL 입력 + 제목(선택) + 추가 버튼

---

## 5. 인증 시스템

**로그인 모달 (auth.js)**
- 모든 페이지 상단에 로그인/로그아웃 버튼
- 클릭 시 모달 팝업 (동적 CSS+HTML 주입)
- 로그인 탭 / 회원가입 탭
- 회원가입: 이름, 이메일(중복확인), 비밀번호(8자+대소문자+숫자 규칙 표시), 비밀번호 확인
- 로그인 후 토큰(JWT 7일) + user 정보 localStorage 저장
- 비로그인 접근 시 `openLoginModal()` 호출

---

## 6. Lambda API 엔드포인트 목록

### 인증
- `POST /auth/register` — 회원가입
- `POST /auth/login` — 로그인
- `POST /auth/check-email` — 이메일 중복확인

### 이슈
- `GET /issues` — 목록 조회 (q, author, date, category, mine, draft, edit, page 파라미터)
- `POST /issues` — 이슈 생성 (title, category)
- `GET /issues/:id` — 단건 조회 (조회수 처리, 섹션+편집자+좋아요 반환)
- `PUT /issues/:id` — 제목 수정
- `DELETE /issues/:id` — 삭제 (작성자만)
- `POST /issues/:id/sections` — 섹션 일괄 저장 (sections, guides, labels, aiContents, is_draft, article_content)
- `PUT /issues/:id/sections/:n` — 단일 섹션 저장 (편집자용)
- `POST /issues/:id/editors` — 편집자 지정 (email, section_no)
- `DELETE /issues/:id/editors/:n` — 편집자 해제
- `POST /issues/:id/react` — 이슈 좋아요/싫어요 (like/dislike 토글)
- `POST /issues/:id/search-related` — 제목 키워드로 관련 최신글 검색 (Haiku 키워드 추출 + RSS)
- `POST /issues/:id/auto-sections` — 참고링크 기반 섹션 자동채우기 (Haiku)

### AI
- `POST /topics/ai` — AI 이슈 만들기 (userTitle 입력 → Haiku 키워드 추출 → RSS → Haiku 제목 다듬기 → 저장)
- `POST /generate` — AI 기사 생성/다듬기 (content 있으면 Haiku 다듬기, 없으면 Sonnet 생성)
- `POST /issues/:id/sections/:n/ai-write` — 섹션 AI 작성 (Sonnet)

### 댓글
- `GET /issues/:id/comments` — 댓글 목록 (좋아요/내 반응 포함)
- `POST /issues/:id/comments` — 댓글 작성
- `DELETE /comments/:id` — 댓글 삭제
- `POST /comments/:id/react` — 댓글 좋아요/싫어요

### 마이페이지
- `GET /mypage` — 프로필 + article_style
- `POST /mypage/article-style` — 기사 스타일 저장
- `GET /mypage/section-guides` — 섹션 가이드 목록
- `POST /mypage/section-guides` — 섹션 가이드 저장
- `GET /mypage/section-labels` — 섹션 제목 기본값
- `POST /mypage/section-labels` — 섹션 제목 개별 저장

### 북마크
- `GET /bookmarks` — 폴더 + 링크 목록
- `POST /bookmarks/folders` — 폴더 생성
- `DELETE /bookmarks/folders/:id` — 폴더 삭제 (링크 cascade)
- `POST /bookmarks/folders/:id/links` — 링크 추가
- `DELETE /bookmarks/links/:id` — 링크 삭제

---

## 7. AI 기능 상세

### 모델 사용 현황
| 기능 | 모델 | max_tokens |
|------|------|-----------|
| 섹션별 AI작성 | claude-sonnet-4-6 | 800 |
| 기사 AI 다듬기 | claude-haiku-4-5-20251001 | 6000 |
| 섹션 자동채우기 | claude-haiku-4-5-20251001 | 1500 |
| AI 이슈 키워드 추출 | claude-haiku-4-5-20251001 | 40 |
| AI 이슈 제목 다듬기 | claude-haiku-4-5-20251001 | 80 |
| 관련글 키워드 추출 | claude-haiku-4-5-20251001 | 40 |
| 관련글 관련이유 생성 | (현재 제거됨) | — |

### AI 이슈 만들기 프로세스
1. 사용자 제목 입력
2. Haiku → 핵심 명사 4개 추출
3. Google News RSS 검색 (`https://news.google.com/rss/search?q={keywords}&hl=ko&gl=KR&ceid=KR:ko`)
4. 결과 없으면 422 에러 반환 (이슈 미생성)
5. Haiku → 제목 다듬기 (실패메시지 패턴 감지 시 원본 유지)
6. 이슈 저장 + reference_links에 RSS 결과 저장

### 기사 AI 다듬기 규칙
- 원고 내용(사실·정보) 절대 삭제 금지
- 맞춤법·문법·어색한 표현만 수정
- article_style 반영: 글 구조·분량·톤·문체

### 섹션 AI작성 (Sonnet)
- 좌측 작성자 메모 + 사용자 저장 가이드 + 마이페이지 writing_style + 기사 제목 기반
- 저장된 가이드 없으면 전달된 가이드 사용

### 섹션 자동채우기 (Haiku)
- 참고링크 URL 최대 4개 실제 조회 (각 3초 타임아웃, 병렬)
- HTML 파싱하여 텍스트 추출 (최대 1200자/URL)
- 내용 조회 성공한 링크만 출처(sources)로 기록
- 결과를 각 섹션 하단에 출처 링크로 표시
- 참고링크 없거나 내용 없으면 "참고할 내용이 없습니다" 반환

---

## 8. UX/UI 규칙

### 색상 시스템 (CSS 변수)
```css
--primary: #4f46e5
--primary-dark: #3730a3
--primary-light: #eef2ff
--success: #10b981
--success-light: #d1fae5
--danger: #ef4444
--danger-light: #fee2e2
--warning: #f59e0b
--warning-light: #fef3c7
--text-primary: #1e293b
--text-secondary: #64748b
--text-muted: #94a3b8
--border: #e2e8f0
--bg: #f8fafc
--bg-card: #ffffff
```

### 레이아웃
- 최대 너비: `max-width: 92%; width: 92%`
- 컨테이너 padding: `1.25rem 1rem`
- 헤더: 보라색 sticky (`--primary`)

### 토스트 알림
- 하단 중앙 플로팅
- success(초록)/error(빨강)/info(파랑) 3종
- 2.8초 자동 사라짐, `\n` → `<br>` 지원

### 이슈 목록 테이블
- `table-layout: fixed`, 가로스크롤 없음
- 편집/삭제 버튼: 아이콘만 (✏️ 🗑)
- 좋아요많음: 연한파랑 / 싫어요많음: 연한주황 / 방금생성: 연한남색

### 분류 목록
`['문화', '정치', '경제', '사회', '스포츠', '연예', 'IT/과학', '국제', '교육', '건강']`

---

## 9. 주요 비즈니스 로직

### 초안(is_draft) 접근 권한
- 비로그인: 완료 글만 조회 가능
- 로그인: 완료 + 본인 초안 + 편집 배정된 초안 조회
- 초안 제목 클릭 → `?mode=edit` 직접 진입

### 섹션 편집 권한
- 작성자: 전체 5섹션 편집 가능
- 편집자: 배정된 섹션만 편집 가능
- 편집자 지정은 작성자만 가능

### 기사 작성 완료 조건
- 기사 본문 10자 이상 필수
- 완료 시: is_draft=false + 섹션 라벨 user_section_labels에 저장

### 조회수
- 로그인 사용자만 카운트
- issue_views 테이블에 (issue_id, user_id) 유일 → 계정당 1회

### 좋아요/싫어요 토글
- 같은 반응 재클릭 → 취소
- 다른 반응 클릭 → 전환

---

## 10. 파일 구조

```
project/
├── public/
│   ├── index.html          # issues.html로 리다이렉트
│   ├── issues.html         # 이슈 목록 (메인)
│   ├── write.html          # 이슈 편집/조회
│   ├── mypage.html         # 마이페이지
│   └── assets/
│       ├── css/
│       │   └── common.css  # 공통 스타일 (헤더, 푸터, 토스트 등)
│       └── js/
│           └── auth.js     # 인증 (API 상수, 토큰, 로그인 모달, 헤더 렌더)
├── lambda/
│   ├── index.js            # Lambda 핸들러 전체
│   └── package.json        # pg, bcryptjs, jsonwebtoken, @anthropic-ai/sdk
└── .github/
    └── workflows/
        └── deploy-lambda.yml   # lambda/** 변경 시 자동 배포
```

### auth.js 주요 함수
- `const API = 'https://{API_GATEWAY_URL}'`
- `getToken()`, `getUser()` — localStorage
- `api(path, options)` — Authorization 헤더 자동 첨부
- `renderHeader(containerSelector)` — 로그인 상태에 따른 헤더 렌더
- `openLoginModal()`, `closeLoginModal()` — 로그인 팝업
- `logout()` — 토큰 삭제 후 issues.html로

---

## 11. 하단 문구
`핫이슈 조회 · Powered by 유승주`

---

## 12. 복제 시 체크리스트

1. AWS Lambda 함수 생성 (Node.js 24, 타임아웃 120초)
2. API Gateway HTTP API 연결 (`ANY /{proxy+}`)
3. 환경변수 설정 (DB_HOST, DB_NAME, DB_USER, DB_PASSWORD, JWT_SECRET, ANTHROPIC_API_KEY)
4. PostgreSQL RDS 생성, 위 스키마 전체 실행
5. AWS Amplify에 GitHub 저장소 연결 (public/ 폴더 기준)
6. `auth.js`의 `API` 상수를 실제 API Gateway URL로 변경
7. GitHub Actions에 Lambda ARN/배포 설정 추가
8. Lambda에 RDS 접근을 위한 보안그룹 설정
