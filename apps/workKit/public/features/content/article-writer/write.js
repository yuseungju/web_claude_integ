const API_BASE = 'https://nynhvk2xl3.execute-api.ap-southeast-2.amazonaws.com';

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || 'null'); }

async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  return res;
}

const LABELS = ['배경 / 발단', '주요 내용', '인터뷰 / 현장', '관련 자료', '결론 / 전망'];
const GUIDE_DEFAULTS = [
  '보통 뉴스 기사의 "본문"처럼 작성해주세요.',
  '보통 뉴스 기사의 "본문"처럼 작성해주세요.',
  '보통 뉴스 기사의 "인터뷰"처럼 작성해주세요.',
  '보통 뉴스 기사의 "참고자료"처럼 작성해주세요.',
  '보통 뉴스 기사의 "결론"처럼 작성해주세요.',
];
const HINTS  = [
  '이슈가 발생한 배경과 발단을 입력하세요',
  '핵심 사건이나 주요 내용을 입력하세요',
  '현장 취재, 인터뷰 내용을 입력하세요',
  '통계, 참고자료, 관련 데이터를 입력하세요',
  '결론, 전망, 향후 계획을 입력하세요',
];

const params      = new URLSearchParams(location.search);
const issueId     = params.get('id');
const isEditMode  = params.get('mode') === 'edit';
const isLoggedIn  = !!getToken();
const me          = getUser();

let isAuthor         = false;
let _currentIsDraft  = true;
let editableSections = [];
let editors          = [null, null, null, null, null];
let sectionsData     = ['', '', '', '', ''];
let guideData        = ['', '', '', '', ''];
let aiData           = ['', '', '', '', ''];
let visibleSections  = new Set([1]); // 기본 1개, 내용 있으면 추가
let hasImported        = false;
let articleStyleData   = '';
let userLabelDefaults  = ['', '', '', '', ''];
let relatedItemsCache  = [];
let editableRefLinks   = []; // { title, url }
let savedRefLinks      = []; // AI 이슈 생성 시 저장된 reference_links

if (!issueId) {
  if (!isLoggedIn) { location.href = 'index.html'; }
  else { isAuthor = true; editableSections = [1,2,3,4,5]; renderNewPage(); }
} else {
  loadIssue();
}

/* ── 신규 ── */
function renderNewPage() {
  visibleSections = new Set([1]);
  document.getElementById('pageTitle').textContent = '새 이슈';
  document.getElementById('titleArea').innerHTML =
    `<input id="titleInput" class="issue-title-input" placeholder="이슈 제목을 입력하세요" maxlength="200" />`;
  document.getElementById('issueSub').textContent = '';
  renderSections();
  renderActionBar();
  renderAiPanelActs();
}

/* ── 불러오기 ── */
async function loadIssue() {
  try {
    const res = await api('/issues/' + issueId);
    if (res.status === 403) { location.href = 'index.html'; return; }
    if (!res.ok) throw new Error();
    const { issue, sections, editors: eds = [null,null,null,null,null], sectionGuides: sg, sectionAiContents: sa } = await res.json();

    sectionsData = sections;
    guideData    = sg  || ['', '', '', '', ''];
    aiData       = sa  || ['', '', '', '', ''];
    // 내용 있는 섹션 자동 표시
    visibleSections = new Set([1]);
    for (let i = 1; i <= 4; i++) {
      if ((sections[i] || '').trim() || (sa && (sa[i] || '').trim())) visibleSections.add(i + 1);
    }
    editors      = eds;
    isAuthor     = isLoggedIn && me && issue.user_id === me.id;
    _currentIsDraft = !!issue.is_draft;

    if (!isAuthor && isLoggedIn && me) {
      editableSections = eds
        .map((e, i) => e && e.user_id === me.id ? i + 1 : null)
        .filter(Boolean);
    } else if (isAuthor) {
      editableSections = [1, 2, 3, 4, 5];
    }

    if (isEditMode && (isAuthor || editableSections.length)) {
      document.getElementById('pageTitle').textContent = '이슈 편집';
      document.getElementById('titleArea').innerHTML = isAuthor
        ? `<input id="titleInput" class="issue-title-input" value="${escHtml(issue.title)}" maxlength="200" />`
        : `<div class="issue-title-view">${escHtml(issue.title)}</div>`;
    } else {
      document.getElementById('pageTitle').textContent = '이슈 조회';
      document.getElementById('titleArea').innerHTML =
        `<div class="issue-title-view">${escHtml(issue.title)}</div>`;
    }

    document.getElementById('issueSub').textContent =
      `작성자: ${issue.author} · ${new Date(issue.created_at).toLocaleString('ko-KR', { year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false })} · 조회 ${issue.view_count ?? 0}`;

    // AI 생성 시 저장된 참고링크 보관 (검색 버튼 클릭 시 함께 표시)
    if (Array.isArray(issue.reference_links)) {
      savedRefLinks = issue.reference_links
        .filter(l => l.url)
        .map(l => ({ title: l.title || l.url, url: l.url, pubDate: l.pubDate || '' }));
    }
    if (isEditMode) {
      await loadSectionGuides();
      if (savedRefLinks.length) editableRefLinks = savedRefLinks.map(l => ({ ...l }));
    }
    renderTopActions(issue);
    if (!isEditMode) renderIssueReactBar(issue);
    renderRefLinks(issue.reference_links);
    renderSectionToolbar();
    renderSections();
    renderActionBar();

    // 기사 본문 로드
    const articleContent = issue.article_content || '';
    document.getElementById('aiBody').value = articleContent;
    renderAiPanelActs();

    if (isEditMode && isAuthor) loadCookie();
    if (!isEditMode) loadComments();
  } catch {
    showToast('이슈를 불러오지 못했습니다.', 'error');
  }
}

/* ── 상단 버튼 ── */
function renderTopActions(issue) {
  const div = document.getElementById('topActions');
  const btns = [];
  if (!isEditMode && issueId) {
    if (isAuthor || editableSections.length > 0) {
      btns.push(`<a href="write.html?id=${issueId}&mode=edit" class="btn primary" style="text-decoration:none">✏️ 편집</a>`);
    }
    if (isAuthor) {
      btns.push(`<button class="btn" style="border-color:#fca5a5;color:#dc2626" onclick="confirmDelete()">🗑 삭제</button>`);
    }
  }
  div.innerHTML = btns.join('');
}

function renderIssueReactBar(issue) {
  const bar = document.getElementById('issueReactBar');
  if (!bar) return;
  bar.style.display = 'flex';
  const likeClass    = issue.my_reaction === 'like'    ? ' active-like'    : '';
  const dislikeClass = issue.my_reaction === 'dislike' ? ' active-dislike' : '';
  bar.innerHTML = `
    <button class="react-btn${likeClass}"    id="issLikeBtn"    onclick="reactIssue('like')">👍 <span id="issLikes">${issue.likes || 0}</span></button>
    <button class="react-btn${dislikeClass}" id="issDislikeBtn" onclick="reactIssue('dislike')">👎 <span id="issDislikes">${issue.dislikes || 0}</span></button>`;
}

async function reactIssue(reaction) {
  if (!isLoggedIn) { openModal('login'); return; }
  try {
    const res = await api(`/issues/${issueId}/react`, { method: 'POST', body: JSON.stringify({ reaction }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('issLikes').textContent    = data.likes;
    document.getElementById('issDislikes').textContent = data.dislikes;
    document.getElementById('issLikeBtn').className    = `react-btn${data.my_reaction === 'like'    ? ' active-like'    : ''}`;
    document.getElementById('issDislikeBtn').className = `react-btn${data.my_reaction === 'dislike' ? ' active-dislike' : ''}`;
  } catch (e) { showToast(e.message || '처리 실패', 'error'); }
}

/* ── 섹션 가이드 (영구저장) ── */
async function loadSectionGuides() {
  if (!isLoggedIn) return;
  try {
    const [gRes, mRes] = await Promise.all([
      api('/mypage/section-guides'),
      api('/mypage'),
    ]);
    const gData = await gRes.json();
    const mData = await mRes.json();
    if (gRes.ok && Array.isArray(gData.guides)) guideData        = gData.guides;
    if (mRes.ok)                                articleStyleData = mData.article_style || '';
  } catch {}
  // 첫 작성자 가이드 표시
  showFirstTimeGuide();
}

function showFirstTimeGuide() {
  if (!isEditMode || !issueId) return;
  if (localStorage.getItem('guideNeverShow')) return; // 다시보지않기 체크한 경우만 제외
  const el = document.getElementById('firstTimeGuide');
  if (el) el.style.display = '';
}

function dismissGuide() {
  const el = document.getElementById('firstTimeGuide');
  if (el) el.style.display = 'none';
  const chk = document.getElementById('guideNeverCheck');
  if (chk?.checked) localStorage.setItem('guideNeverShow', '1');
}

/* ── AI 정리 미리보기 모달 ── */
let _previewArticle = '';

function openArticlePreviewModal(title, article) {
  _previewArticle = article;

  if (!document.getElementById('articlePreviewModal')) {
    const div = document.createElement('div');
    div.id = 'articlePreviewModal';
    div.className = 'modal-overlay';
    div.innerHTML = `
      <div class="modal-backdrop-click" onclick="closeArticlePreviewModal()"></div>
      <div class="modal-box" style="max-width:660px;padding:1.5rem 1.75rem">
        <button class="modal-close" onclick="closeArticlePreviewModal()">✕</button>
        <div style="font-size:.65rem;font-weight:700;color:var(--text-muted);letter-spacing:.05em;margin-bottom:.55rem">AI 정리 미리보기</div>
        <div id="previewArticleTitle" style="font-size:1.05rem;font-weight:900;color:var(--text-primary);line-height:1.4;margin-bottom:.65rem;padding-bottom:.6rem;border-bottom:2px solid var(--border)"></div>
        <div id="previewArticleBody" style="font-size:.82rem;line-height:1.9;color:var(--text-primary);white-space:pre-wrap;word-break:break-word;max-height:55vh;overflow-y:auto;padding-right:.25rem"></div>
        <div style="display:flex;justify-content:flex-end;gap:.45rem;margin-top:1rem;padding-top:.75rem;border-top:1px solid var(--border)">
          <button onclick="closeArticlePreviewModal()" style="padding:.45rem .9rem;border:1.5px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text-secondary);font-size:.82rem;font-weight:600;cursor:pointer;font-family:var(--font-sans)">닫기</button>
          <button onclick="copyArticlePreview()" style="padding:.45rem .9rem;border:1.5px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text-secondary);font-size:.82rem;font-weight:600;cursor:pointer;font-family:var(--font-sans)">📋 복사</button>
          <button onclick="applyArticlePreview()" style="padding:.45rem 1rem;border:none;border-radius:var(--radius-sm);background:var(--primary);color:#fff;font-size:.82rem;font-weight:700;cursor:pointer;font-family:var(--font-sans)">✅ 본문에 적용</button>
        </div>
      </div>`;
    document.body.appendChild(div);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeArticlePreviewModal(); });
  }

  document.getElementById('previewArticleTitle').textContent = title;
  document.getElementById('previewArticleBody').textContent  = article;
  document.getElementById('articlePreviewModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeArticlePreviewModal() {
  const m = document.getElementById('articlePreviewModal');
  if (m) m.classList.remove('open');
  document.body.style.overflow = '';
}

function copyArticlePreview() {
  if (!_previewArticle) return;
  navigator.clipboard.writeText(_previewArticle)
    .then(() => { showToast('복사됐습니다.', 'success'); })
    .catch(() => showToast('복사 실패', 'error'));
}

function applyArticlePreview() {
  if (!_previewArticle) return;
  document.getElementById('aiBody').value = _previewArticle;
  hasImported = true;
  closeArticlePreviewModal();
  updateAiBodyCounter(); // 글자수 갱신
  showToast('기사 본문에 적용됐습니다.', 'success');
}

/* ── 기사 스타일 모달 ── */
function openArticleStyleModal() {
  if (!document.getElementById('articleStyleModal')) {
    const div = document.createElement('div');
    div.id = 'articleStyleModal';
    div.className = 'modal-overlay';
    div.innerHTML = `
      <div class="modal-backdrop-click" onclick="closeArticleStyleModal()"></div>
      <div class="modal-box" style="max-width:640px">
        <button class="modal-close" onclick="closeArticleStyleModal()">✕</button>
        <div style="font-size:.95rem;font-weight:800;color:var(--text-primary);margin-bottom:.4rem">🎨 기사 완성본 스타일 지정</div>
        <p style="font-size:.74rem;color:var(--text-muted);margin-bottom:.7rem">완성된 기사 예시를 전부 붙여넣으세요. AI가 이 형식과 문체에 맞게 기사를 다듬습니다. 영구 저장됩니다.</p>
        <textarea id="articleStyleTA" style="width:100%;min-height:260px;padding:.75rem;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:.84rem;font-family:var(--font-sans);resize:vertical;outline:none;line-height:1.75;color:var(--text-primary);background:var(--bg);box-sizing:border-box" placeholder="완성된 기사 예시를 여기에 붙여넣으세요..."></textarea>
        <div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:.85rem">
          <button onclick="closeArticleStyleModal()" style="padding:.5rem 1rem;border:1.5px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text-secondary);font-size:.84rem;font-weight:600;cursor:pointer;font-family:var(--font-sans)">취소</button>
          <button onclick="saveArticleStyleModal()" style="padding:.5rem 1.1rem;border:none;border-radius:var(--radius-sm);background:var(--primary);color:#fff;font-size:.84rem;font-weight:700;cursor:pointer;font-family:var(--font-sans)">저장</button>
        </div>
      </div>`;
    document.body.appendChild(div);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeArticleStyleModal(); });
  }
  document.getElementById('articleStyleTA').value = articleStyleData;
  document.getElementById('articleStyleModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('articleStyleTA').focus(), 50);
}

function closeArticleStyleModal() {
  const m = document.getElementById('articleStyleModal');
  if (m) m.classList.remove('open');
  document.body.style.overflow = '';
}

async function saveArticleStyleModal() {
  const style = document.getElementById('articleStyleTA').value.trim();
  try {
    const res = await api('/mypage/article-style', {
      method: 'POST', body: JSON.stringify({ article_style: style }),
    });
    if (!res.ok) throw new Error();
    articleStyleData = style;
    // 버튼 상태 업데이트
    const btn = document.getElementById('btnGenerate');
    if (btn) {
      const styleBtn = btn.nextElementSibling;
      if (styleBtn) styleBtn.textContent = `🎨 스타일${style.length >= 4 ? ' ✓' : ''}`;
    }
    closeArticleStyleModal();
    showToast('스타일이 저장됐습니다.', 'success');
  } catch { showToast('저장 실패', 'error'); }
}

function _ensureGuideModal() {
  if (document.getElementById('guideModal')) return;
  const div = document.createElement('div');
  div.id = 'guideModal';
  div.className = 'modal-overlay';
  div.innerHTML = `
    <div class="modal-backdrop-click" onclick="closeGuideModal()"></div>
    <div class="modal-box" style="max-width:560px">
      <button class="modal-close" onclick="closeGuideModal()">✕</button>
      <div id="guideModalTitle" style="font-size:.95rem;font-weight:800;color:var(--text-primary);margin-bottom:.5rem"></div>
      <p style="font-size:.74rem;color:var(--text-muted);margin-bottom:.7rem">영구 저장되며 이후 기사 작성 시에도 자동 적용됩니다.</p>
      <textarea id="guideModalTA" style="width:100%;min-height:200px;padding:.75rem;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:.85rem;font-family:var(--font-sans);resize:vertical;outline:none;line-height:1.75;color:var(--text-primary);background:var(--bg);box-sizing:border-box" placeholder="AI가 이 섹션을 작성할 방향, 톤, 포함할 내용 등을 자세히 입력하세요..."></textarea>
      <div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:.85rem">
        <button onclick="closeGuideModal()" style="padding:.5rem 1rem;border:1.5px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text-secondary);font-size:.84rem;font-weight:600;cursor:pointer;font-family:var(--font-sans)">취소</button>
        <button onclick="saveGuideFromModal()" style="padding:.5rem 1.1rem;border:none;border-radius:var(--radius-sm);background:var(--primary);color:#fff;font-size:.84rem;font-weight:700;cursor:pointer;font-family:var(--font-sans)">저장</button>
      </div>
    </div>`;
  document.body.appendChild(div);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeGuideModal(); });
}

function openGuideModal(n) {
  _ensureGuideModal();
  const modal = document.getElementById('guideModal');
  document.getElementById('guideModalTitle').textContent = `섹션 ${n} 작성 가이드`;
  const savedGuide   = (guideData[n - 1] || '').trim();
  const defaultGuide = savedGuide || GUIDE_DEFAULTS[n - 1] || '';
  document.getElementById('guideModalTA').value = defaultGuide;
  modal.dataset.section = n;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('guideModalTA').focus(), 50);
}

function closeGuideModal() {
  const m = document.getElementById('guideModal');
  if (m) m.classList.remove('open');
  document.body.style.overflow = '';
}

async function saveGuideFromModal() {
  const modal = document.getElementById('guideModal');
  const n     = parseInt(modal.dataset.section);
  const guide = document.getElementById('guideModalTA').value.trim();
  if (guide.length < 5) { showToast('가이드는 5자 이상 입력해야 저장됩니다.', 'error'); return; }
  try {
    const res = await api('/mypage/section-guides', {
      method: 'POST', body: JSON.stringify({ section_no: n, guide }),
    });
    if (!res.ok) throw new Error();
    guideData[n - 1] = guide;
    const active = guide.length >= 4;
    const btn = document.getElementById(`btnGuide${n}`);
    if (btn) {
      btn.className = `btn-guide-open${active ? ' has-guide' : ''}`;
      btn.textContent = active ? '📝 가이드 설정됨' : '📝 작성 가이드 설정';
    }
    closeGuideModal();
    showToast('가이드가 저장됐습니다.', 'success');
  } catch { showToast('저장 실패', 'error'); }
}

/* ── 참고링크 편집 패널 ── */
function renderEditRefPanel() {
  const panel = document.getElementById('relatedPanel');
  if (!panel) return;
  panel.style.display = '';
  const listHtml = editableRefLinks.length
    ? `<ul class="ref-list" style="max-height:200px;overflow-y:auto;margin-bottom:.4rem">
        ${editableRefLinks.map((l, i) => `
          <li>
            <a href="${l.url.replace(/"/g,'&quot;')}" target="_blank" rel="noopener noreferrer">${escHtml(l.title || l.url)}</a>
            ${l.pubDate ? `<span style="font-size:.62rem;color:var(--text-muted);flex-shrink:0">${fmtPubDate(l.pubDate)}</span>` : ''}
            <button class="ref-del-btn" onclick="removeRefLink(${i})">✕</button>
          </li>`).join('')}
       </ul>`
    : `<div style="font-size:.74rem;color:var(--text-muted);padding:.3rem 0 .5rem">링크가 없습니다. 아래에서 직접 추가하세요.</div>`;
  panel.innerHTML = `
    <div class="related-panel-header">
      📎 참고링크 ${editableRefLinks.length ? `<span style="font-size:.68rem;background:var(--primary-light);color:var(--primary);padding:.05rem .35rem;border-radius:100px;font-weight:700">${editableRefLinks.length}건</span>` : ''}
    </div>
    ${listHtml}
    <div class="ref-edit-add">
      <input type="url" id="refUrlIn" class="ref-url-input" placeholder="https://... URL 직접 추가" />
      <input type="text" id="refTitleIn" class="ref-url-input" style="max-width:140px" placeholder="제목(선택)" />
      <button class="btn-ref-add" onclick="addManualRefLink()">+ 추가</button>
    </div>`;
  updateAutoFillBtnState();
}

function addManualRefLink() {
  const url   = document.getElementById('refUrlIn')?.value.trim();
  const title = document.getElementById('refTitleIn')?.value.trim();
  if (!url || !/^https?:\/\//i.test(url)) { showToast('올바른 URL을 입력하세요.', 'error'); return; }
  editableRefLinks.push({ title: title || url, url });
  renderEditRefPanel();
}

function removeRefLink(idx) {
  editableRefLinks.splice(idx, 1);
  renderEditRefPanel();
}

function updateAutoFillBtnState() {
  const btn = document.getElementById('btnAutoFill');
  if (!btn) return;
  const ok = editableRefLinks.length > 0;
  btn.disabled = !ok;
  btn.title = ok ? '' : '참고링크를 먼저 가져오세요';
}

function onSecInput(n) {
  const btn = document.getElementById(`btnAiSec${n}`);
  if (btn) btn.disabled = !document.getElementById(`sec${n}`)?.value.trim();
}

function addSection() {
  for (let n = 2; n <= 5; n++) {
    if (!visibleSections.has(n)) {
      visibleSections.add(n);
      saveSectionsSnapshot();
      renderSections();
      restoreSectionsSnapshot();
      return;
    }
  }
}

function deleteSection(n) {
  if (n <= 1) return;
  sectionsData[n - 1] = '';
  aiData[n - 1]       = '';
  guideData[n - 1]    = '';
  visibleSections.delete(n);
  saveSectionsSnapshot();
  renderSections();
  restoreSectionsSnapshot();
  showToast(`섹션 ${n} 내용이 삭제됐습니다.`, 'info');
}

async function saveSectionLabel(n) {
  const label = document.getElementById(`secLabel${n}`)?.value.trim();
  if (!label) return;
  try {
    const res = await api('/mypage/section-labels', {
      method: 'POST', body: JSON.stringify({ section_no: n, label }),
    });
    if (!res.ok) throw new Error();
    if (typeof userLabelDefaults !== 'undefined') userLabelDefaults[n - 1] = label;
    showToast(`섹션 ${n} 제목이 변경됐습니다.`, 'success');
  } catch {
    showToast('저장 실패', 'error');
  }
}

/* ── 섹션 툴바 (관련글 검색 + 자동채우기) ── */
function renderSectionToolbar() {
  const bar = document.getElementById('sectionToolbar');
  if (!bar) return;
  const editMode = isEditMode || !issueId;
  if (!editMode || !issueId) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `
    <button class="btn" id="btnAutoFill" onclick="autoFillSections()" disabled title="참고링크를 먼저 추가하세요">🤖 참고자료로 문단채우기</button>`;
  const note = document.getElementById('sectionNote');
  if (note) note.style.display = '';
  renderEditRefPanel();  // 참고링크 패널 자동 표시
  updateAutoFillBtnState();
}

async function autoFillSections() {
  const btn = document.getElementById('btnAutoFill');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 작성 중...'; }
  try {
    const res = await api(`/issues/${issueId}/auto-sections`, {
      method: 'POST',
      body: JSON.stringify({
        relatedItems: relatedItemsCache,
        links: editableRefLinks,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (!data.results?.length) { showToast(data.message || '참고할 내용이 없습니다.', 'info'); return; }
    for (const r of (data.results || [])) {
      const ta = document.getElementById(`sec${r.no}`);
      if (ta) ta.value = r.content;
      sectionsData[r.no - 1] = r.content;
      // labelsData 제거됨 — label 업데이트 불필요
      // 출처 링크 표시
      const srcDiv = document.getElementById(`secSrc${r.no}`);
      if (srcDiv) {
        const srcs = r.sources || [];
        if (srcs.length) {
          srcDiv.style.display = '';
          srcDiv.innerHTML = `<span class="sec-src-label">출처: </span>` +
            srcs.map(s => `<a href="${s.url.replace(/"/g,'&quot;')}" target="_blank" rel="noopener" class="sec-src-link" title="${escHtml(s.title)}">${escHtml(s.title || s.url)}</a>`).join('');
        } else {
          srcDiv.style.display = 'none';
          srcDiv.innerHTML = '';
        }
      }
      onSecInput(r.no); // 내용 채워졌으니 AI 버튼 활성화
    }
    showToast('섹션 자동채우기 완료!', 'success');
  } catch (e) {
    showToast(e.message || '자동채우기 실패', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 참고자료로 문단채우기'; }
  }
}


/* ── 섹션 AI 작성 ── */
async function aiWriteSection(n) {
  const content = document.getElementById(`sec${n}`)?.value || '';
  const guide   = guideData[n - 1] || (n === 1 ? '보통 기사의 "본문"처럼 변환해주세요.' : '');
  const label   = '';
  const btn     = document.getElementById(`btnAiSec${n}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  // 사이드 패널 전체 초기화 (복사·적용 버튼 포함)
  const side = document.getElementById(`aisec${n}`);
  if (side) side.innerHTML = `<div class="section-ai-content" id="aiSecContent${n}"><div class="ai-side-placeholder">⏳ AI가 작성 중...</div></div>`;
  try {
    const res = await api(`/issues/${issueId}/sections/${n}/ai-write`, {
      method: 'POST', body: JSON.stringify({ content, guide, label }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const side2 = document.getElementById(`aisec${n}`);
    if (side2) {
      side2.innerHTML = `
        <div class="section-ai-content" id="aiSecContent${n}">${escHtml(data.ai_content)}</div>
        <div class="sec-ai-btn-row">
          <button class="sec-ai-copy-btn"  onclick="copySectionAI(${n})">📋 복사</button>
          <button class="sec-ai-apply-btn" onclick="applySectionAI(${n})">✅ 적용</button>
        </div>`;
    }
    aiData[n - 1] = data.ai_content;
    showToast(`섹션 ${n} AI 작성 완료`, 'success');
  } catch (e) {
    const side2 = document.getElementById(`aisec${n}`);
    if (side2) side2.innerHTML = `<div class="section-ai-content" id="aiSecContent${n}"><div class="ai-side-placeholder">AI 작성 실패</div></div>`;
    showToast(e.message || 'AI 작성 실패', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ AI작성'; }
  }
}

function copySectionAI(n) {
  const el = document.getElementById(`aiSecContent${n}`);
  const text = el?.textContent?.trim() || '';
  if (!text) { showToast('복사할 내용이 없습니다.', 'error'); return; }
  navigator.clipboard.writeText(text)
    .then(() => showToast('복사됐습니다.', 'success'))
    .catch(() => showToast('복사 실패', 'error'));
}

function applySectionAI(n) {
  const text = document.getElementById(`aiSecContent${n}`)?.textContent?.trim() || '';
  if (!text) { showToast('적용할 내용이 없습니다.', 'error'); return; }
  const ta = document.getElementById(`sec${n}`);
  if (!ta || ta.readOnly) { showToast('편집 권한이 없는 섹션입니다.', 'error'); return; }
  ta.value = text;
  ta.focus();
  showToast(`섹션 ${n} 내용이 좌측에 적용됐습니다.`, 'success');
}

function fmtPubDate(str) {
  if (!str) return '';
  try {
    const d = new Date(str);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' });
  } catch { return ''; }
}

function renderRefLinks(links) {
  // 참고링크는 편집 모드(relatedPanel)에서만 표시 — 조회 모드에서는 숨김
  const panel = document.getElementById('refPanel');
  if (panel) panel.style.display = 'none';
}

async function confirmDelete() {
  if (!confirm('이 이슈를 삭제하시겠습니까?')) return;
  try {
    const res = await api(`/issues/${issueId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    location.href = 'index.html';
  } catch (e) { showToast(e.message || '삭제 실패', 'error'); }
}

/* ── 기사 본문 패널 버튼 ── */
function renderAiPanelActs() {
  const editMode = isEditMode || !issueId;
  const acts = document.getElementById('aiPanelActs');
  const panel = document.getElementById('aiPanel');
  const textarea = document.getElementById('aiBody');
  if (!acts || !panel || !textarea) return;

  textarea.readOnly = !editMode;

  // 조회 모드: 기사 본문을 진짜 기사 형식으로 표시
  if (!editMode) {
    const content = textarea.value.trim();
    if (!content) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    panel.classList.add('view-mode');
    textarea.style.display = 'none';

    const oldView = panel.querySelector('.article-view-body');
    if (oldView) oldView.remove();
    const viewDiv = document.createElement('div');
    viewDiv.className = 'article-view-body';
    viewDiv.textContent = content;
    panel.appendChild(viewDiv);

    acts.innerHTML = `<button class="btn-panel-sm" onclick="copyAI()">복사</button>`;
    return;
  }

  // 편집 모드: 가져오기 → AI 다듬기 + 스타일 지정 + 복사
  panel.style.display = '';
  const alreadyHasContent = !!textarea.value.trim();
  if (alreadyHasContent) hasImported = true;
  let html = `<button class="btn-panel-sm import" onclick="importSections()">📥 가져오기</button>`;
  if (isLoggedIn) {
    html += `<button class="btn-panel-sm" id="btnGenerate" onclick="generateArticle()" ${hasImported ? '' : 'disabled'} title="${hasImported ? '' : '가져오기 후 사용 가능'}">🤖 AI로 다듬기</button>`;
    html += `<button class="btn-panel-sm" onclick="openArticleStyleModal()" title="기사 완성본 스타일 지정">🎨 스타일${articleStyleData.trim().length >= 4 ? ' ✓' : ''}</button>`;
  }
  html += `<button class="btn-panel-sm" onclick="copyAI()">복사</button>`;
  acts.innerHTML = html;
}

/* ── 섹션 렌더링 ── */
function renderSections() {
  const editMode = isEditMode || !issueId;
  if (!editMode) {
    document.getElementById('sectionsWrap').style.display = 'none';
    return;
  }
  const orderedNums = [...visibleSections].sort((a, b) => a - b);
  let sectionsHtml = orderedNums.map(n => {
    const i        = n - 1;
    const editable = editableSections.includes(n);
    const editor       = editors[i];
    const isMyEdit     = !isAuthor && editable;
    const content      = sectionsData[i] || '';
    const guide        = guideData[i]    || '';
    const aiContent    = aiData[i]       || '';

    const editorZone = '';

    const myBadge = isMyEdit ? `<span class="my-sec-badge">내 편집 구역</span>` : '';
    const delBtn  = (editable && n > 1)
      ? `<button class="btn-hide-sec" onclick="deleteSection(${n})" title="내용 삭제 후 숨김">🗑 삭제</button>`
      : '';
    const hasGuide = guide.trim().length >= 5;
    const contentEmpty = !content.trim();
    const controlBar = editable
      ? `<div class="section-controls">
           <button class="btn-guide-open${hasGuide ? ' has-guide' : ''}" id="btnGuide${n}" onclick="openGuideModal(${n})">
             📝 ${hasGuide ? '가이드 설정됨' : '작성 가이드 설정'}
           </button>
           <button class="btn-ai-sec" id="btnAiSec${n}" onclick="aiWriteSection(${n})"
             ${contentEmpty ? 'disabled title="좌측 내용을 먼저 입력하세요"' : ''}>✨ AI작성</button>
         </div>` : '';

    const aiSide = `
      <div class="section-ai-side" id="aisec${n}">
        <div class="section-ai-content" id="aiSecContent${n}">${
          aiContent ? escHtml(aiContent) : '<div class="ai-side-placeholder">✨ AI작성 버튼으로 내용을 생성하세요</div>'
        }</div>
        ${aiContent ? `<div class="sec-ai-btn-row"><button class="sec-ai-copy-btn" onclick="copySectionAI(${n})">📋 복사</button><button class="sec-ai-apply-btn" onclick="applySectionAI(${n})">✅ 적용</button></div>` : ''}
        <div class="ai-side-hint">💡 AI 내용을 활용하려면 좌측에 붙여넣고 편집하세요</div>
      </div>`;

    const bodyHtml = editable
      ? `<div class="section-body-2col">
           <div style="display:flex;flex-direction:column;min-width:0;overflow:hidden">
             <textarea id="sec${n}" class="section-textarea" placeholder="작성 가이드에 맞는 내용을 작성해주세요." rows="8" oninput="onSecInput(${n})">${escHtml(content)}</textarea>
             <div class="sec-sources" id="secSrc${n}" style="display:none"></div>
           </div>
           ${aiSide}
         </div>`
      : `<div class="section-body-2col"><textarea id="sec${n}" class="section-textarea" readonly placeholder="작성 가이드에 맞는 내용을 작성해주세요." rows="8">${escHtml(content)}</textarea>${aiSide}</div>`;

    const edFormHtml = '';

    return `
      <div class="section-card">
        <div class="section-label">
          <span class="sec-num">${n}</span>
          ${myBadge}
          ${delBtn}
          ${editorZone}
        </div>
        ${edFormHtml}
        ${controlBar}
        ${bodyHtml}
      </div>`;
  }).join('');

  // 추가 버튼 (숨겨진 섹션이 있을 때만)
  const hasHidden = [2,3,4,5].some(n => !visibleSections.has(n));
  const canAdd    = editMode && hasHidden && (isAuthor || editableSections.length > 0);
  const addBtnHtml = canAdd
    ? `<div class="sec-add-row" onclick="addSection()">
         <button class="btn-add-sec" style="pointer-events:none">+ 문단 추가</button>
         <span style="font-size:.68rem;color:var(--text-muted);margin-left:auto">${visibleSections.size}/5</span>
       </div>`
    : '';

  document.getElementById('sectionsWrap').innerHTML = sectionsHtml + addBtnHtml;
}

/* ── 하단 액션바 ── */
function renderActionBar() {
  const bar      = document.getElementById('actionBar');
  const editMode = isEditMode || !issueId;
  if (!editMode) { bar.style.display = 'none'; return; }

  const canSave = isAuthor || editableSections.length > 0;
  if (!canSave) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';

  let html = '';
  html += `<div class="btn-spacer"></div>`;
  if (canSave) {
    html += `<button class="btn primary" id="btnSave" onclick="saveIssue(true)">💾 저장</button>`;
  }
  if (isAuthor && issueId) {
    const attCls = _currentIsDraft ? ' publish-need-attention' : '';
    html += `<button class="btn success${attCls}" id="btnComplete" onclick="saveIssue(false)">📢 게시하기</button>`;
  }
  bar.innerHTML = html;
}

/* ── 편집자 ── */
function toggleEditorForm(n) {
  const f = document.getElementById(`eform${n}`);
  if (!f) return;
  f.classList.toggle('open');
  if (f.classList.contains('open')) document.getElementById(`eEmail${n}`).focus();
}

async function assignEditor(n) {
  const email = document.getElementById(`eEmail${n}`)?.value.trim();
  if (!email) { showToast('이메일을 입력하세요.', 'error'); return; }
  try {
    const res = await api(`/issues/${issueId}/editors`, {
      method: 'POST',
      body: JSON.stringify({ section_no: n, email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    editors[n - 1] = data.editor;
    saveSectionsSnapshot();
    renderSections();
    restoreSectionsSnapshot();
    showToast(`섹션 ${n} 편집자: ${data.editor.name}`, 'success');
  } catch (e) { showToast(e.message || '지정 실패', 'error'); }
}

async function removeEditor(n) {
  try {
    const res = await api(`/issues/${issueId}/editors/${n}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    editors[n - 1] = null;
    saveSectionsSnapshot();
    renderSections();
    restoreSectionsSnapshot();
    showToast(`섹션 ${n} 편집자 해제`, 'success');
  } catch (e) { showToast(e.message || '해제 실패', 'error'); }
}

let _snap = [];
function saveSectionsSnapshot() { _snap = [1,2,3,4,5].map(i => document.getElementById(`sec${i}`)?.value || ''); }
function restoreSectionsSnapshot() { _snap.forEach((v, i) => { const el = document.getElementById(`sec${i+1}`); if (el) el.value = v; }); }

/* ── 임시저장 ── */
function tempSave() {
  if (!issueId) { showToast('먼저 저장하세요.', 'error'); return; }
  const d = { title: document.getElementById('titleInput')?.value, sections: getSections() };
  document.cookie = `draft_${issueId}=${encodeURIComponent(JSON.stringify(d))};max-age=86400;path=/`;
  showToast('임시저장됐습니다.', 'info');
}
function loadCookie() {
  if (!issueId) return;
  const m = document.cookie.match(new RegExp(`draft_${issueId}=([^;]+)`));
  if (!m) return;
  try {
    const d = JSON.parse(decodeURIComponent(m[1]));
    if (d.title) { const el = document.getElementById('titleInput'); if (el) el.value = d.title; }
    d.sections?.forEach((s, i) => { const el = document.getElementById(`sec${i+1}`); if (el && s) el.value = s; });
    showToast('임시저장 내용을 불러왔습니다.', 'info');
  } catch {}
}
function clearCookie() { if (issueId) document.cookie = `draft_${issueId}=;max-age=0;path=/`; }

function getSections() { return [1,2,3,4,5].map(i => document.getElementById(`sec${i}`)?.value || ''); }
function getArticleContent() { return document.getElementById('aiBody')?.value || ''; }

/* ── 저장/게시 ── */
async function saveIssue(isDraft = true) {
  if (!isDraft && getArticleContent().trim().length < 10) {
    showToast('기사 본문을 10자 이상 입력해야 게시할 수 있습니다.', 'error');
    return;
  }
  if (!isDraft && !confirm('게시하면 모든 사용자가 볼 수 있습니다. 계속하시겠습니까?')) return;
  const saveBtn    = document.getElementById('btnSave');
  const completeBtn = document.getElementById('btnComplete');
  const activeBtn  = isDraft ? saveBtn : completeBtn;
  if (activeBtn) { activeBtn.disabled = true; activeBtn.textContent = isDraft ? '저장 중...' : '처리 중...'; }
  try {
    if (isAuthor) {
      const title = document.getElementById('titleInput')?.value.trim();
      if (!title) { showToast('제목을 입력하세요.', 'error'); return; }
      if (!issueId) {
        const r = await api('/issues', { method: 'POST', body: JSON.stringify({ title }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        history.replaceState({}, '', `write.html?id=${d.issue.id}&mode=edit`);
        location.reload();
        return;
      }
      await api(`/issues/${issueId}`, { method: 'PUT', body: JSON.stringify({ title }) });
      const r2 = await api(`/issues/${issueId}/sections`, {
        method: 'POST',
        body: JSON.stringify({
          sections:   getSections(),
          guides:     [1,2,3,4,5].map(j => document.getElementById(`guide${j}`)?.value        || ''),
          labels:     [1,2,3,4,5].map(j => document.getElementById(`secLabel${j}`)?.value     || ''),
          aiContents: [1,2,3,4,5].map(j => document.getElementById(`aiSecContent${j}`)?.textContent?.trim() || ''),
          is_draft: isDraft,
          article_content: getArticleContent(),
        }),
      });
      if (!r2.ok) { const d2 = await r2.json(); throw new Error(d2.error); }
    } else {
      for (const n of editableSections) {
        const content = document.getElementById(`sec${n}`)?.value || '';
        const r = await api(`/issues/${issueId}/sections/${n}`, {
          method: 'PUT', body: JSON.stringify({ content }),
        });
        if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
      }
    }
    clearCookie();
    const msg = isDraft ? '저장됐습니다.' : '게시됐습니다. 모든 사용자에게 공개됩니다.';
    showToast(msg, 'success');
    setTimeout(() => location.href = `write.html?id=${issueId}`, 800);
  } catch (e) {
    showToast(e.message || '저장 실패', 'error');
  } finally {
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.textContent = isDraft ? '💾 저장' : '📢 게시하기';
    }
  }
}

/* ── 가져오기: 5개 섹션 → 기사 본문 ── */
function importSections() {
  const parts = getSections().filter(s => s.trim());
  if (!parts.length) { showToast('섹션 내용을 먼저 입력하세요.', 'error'); return; }
  document.getElementById('aiBody').value = parts.join('\n\n');
  hasImported = true;
  updateAiBodyCounter(); // 글자수 갱신
  showToast('섹션 내용을 가져왔습니다. AI로 다듬기 버튼이 활성화됐습니다.', 'success');
}

/* ── AI 정리 ── */
async function generateArticle() {
  const title = document.getElementById('titleInput')?.value.trim()
    || document.querySelector('.issue-title-view')?.textContent.trim();
  if (!title) { showToast('제목이 필요합니다.', 'error'); return; }

  const btn = document.getElementById('btnGenerate');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ AI 정리 중...'; }

  try {
    const sections = (isEditMode || !issueId) ? getSections() : sectionsData;
    const res = await api('/generate', {
      method: 'POST',
      body: JSON.stringify({ title, sections, content: document.getElementById('aiBody')?.value.trim() || '' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const previewTitle = document.getElementById('titleInput')?.value.trim()
      || document.querySelector('.issue-title-view')?.textContent.trim() || '';
    openArticlePreviewModal(previewTitle, data.article);
  } catch (e) {
    showToast('AI 정리 실패: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 AI 정리'; }
  }
}

async function copyAI() {
  const text = document.getElementById('aiBody')?.value || '';
  if (!text) { showToast('복사할 내용이 없습니다.', 'error'); return; }
  try { await navigator.clipboard.writeText(text); showToast('복사됐습니다.', 'success'); }
  catch { showToast('복사 실패', 'error'); }
}

/* ── 댓글 ── */
async function loadComments() {
  const sec = document.getElementById('commentsSection');
  if (!sec || !issueId) return;
  sec.style.display = '';
  try {
    const res = await api(`/issues/${issueId}/comments`);
    if (!res.ok) throw new Error();
    const { comments } = await res.json();
    renderCommentList(comments);
    renderCommentForm();
  } catch {
    document.getElementById('commentList').innerHTML = '<div class="empty-comments">댓글을 불러오지 못했습니다.</div>';
  }
}

function renderCommentList(comments) {
  document.getElementById('commentCountBadge').textContent = comments.length;
  document.getElementById('commentList').innerHTML = comments.length
    ? comments.map(renderCommentItem).join('')
    : '<div class="empty-comments">첫 댓글을 작성해보세요.</div>';
}

function renderCommentItem(c) {
  const date = new Date(c.created_at).toLocaleDateString('ko-KR', { year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const isMyComment  = isLoggedIn && me && c.user_id === me.id;
  const likeClass    = c.my_reaction === 'like'    ? ' active-like'    : '';
  const dislikeClass = c.my_reaction === 'dislike' ? ' active-dislike' : '';
  const delBtn = isMyComment
    ? `<button class="comment-del-btn" onclick="removeComment(${c.id})">삭제</button>` : '';
  return `
    <div class="comment-item" id="comment-${c.id}">
      <div class="comment-meta">
        <span class="comment-author">${escHtml(c.author)}</span>
        <span class="comment-date">${date}</span>
        ${delBtn}
      </div>
      <div class="comment-body">${escHtml(c.content)}</div>
      <div class="comment-actions">
        <button class="react-btn${likeClass}" onclick="reactComment(${c.id},'like')">👍 <span id="like-${c.id}">${c.likes}</span></button>
        <button class="react-btn${dislikeClass}" onclick="reactComment(${c.id},'dislike')">👎 <span id="dislike-${c.id}">${c.dislikes}</span></button>
      </div>
    </div>`;
}

function renderCommentForm() {
  const wrap = document.getElementById('commentFormWrap');
  if (!wrap) return;
  if (!isLoggedIn) {
    wrap.innerHTML = `<div class="comment-login-notice" onclick="openModal('login')">🔒 로그인하면 댓글을 작성할 수 있습니다</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="comment-form">
      <textarea id="commentInput" class="comment-textarea" placeholder="댓글을 입력하세요..." rows="3"></textarea>
      <div class="comment-submit-row">
        <button class="btn-comment-submit" id="btnCommentSubmit" onclick="submitComment()">댓글 등록</button>
      </div>
    </div>`;
}

async function submitComment() {
  const input = document.getElementById('commentInput');
  const content = input?.value.trim();
  if (!content) { showToast('댓글 내용을 입력하세요.', 'error'); return; }
  const btn = document.getElementById('btnCommentSubmit');
  btn.disabled = true; btn.textContent = '등록 중...';
  try {
    const res = await api(`/issues/${issueId}/comments`, { method: 'POST', body: JSON.stringify({ content }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    input.value = '';
    const list = document.getElementById('commentList');
    list.querySelector('.empty-comments')?.remove();
    list.insertAdjacentHTML('beforeend', renderCommentItem(data.comment));
    const badge = document.getElementById('commentCountBadge');
    badge.textContent = parseInt(badge.textContent || '0') + 1;
    showToast('댓글이 등록됐습니다.', 'success');
  } catch (e) { showToast(e.message || '등록 실패', 'error'); }
  finally { btn.disabled = false; btn.textContent = '댓글 등록'; }
}

async function reactComment(commentId, reaction) {
  if (!isLoggedIn) { openModal('login'); return; }
  try {
    const res = await api(`/comments/${commentId}/react`, { method: 'POST', body: JSON.stringify({ reaction }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById(`like-${commentId}`).textContent    = data.likes;
    document.getElementById(`dislike-${commentId}`).textContent = data.dislikes;
    const item = document.getElementById(`comment-${commentId}`);
    const [likeBtn, dislikeBtn] = item.querySelectorAll('.react-btn');
    likeBtn.className    = `react-btn${data.my_reaction === 'like'    ? ' active-like'    : ''}`;
    dislikeBtn.className = `react-btn${data.my_reaction === 'dislike' ? ' active-dislike' : ''}`;
  } catch (e) { showToast(e.message || '처리 실패', 'error'); }
}

async function removeComment(commentId) {
  if (!confirm('댓글을 삭제하시겠습니까?')) return;
  try {
    const res = await api(`/comments/${commentId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById(`comment-${commentId}`)?.remove();
    const badge = document.getElementById('commentCountBadge');
    badge.textContent = Math.max(0, parseInt(badge.textContent || '1') - 1);
    if (!document.querySelector('.comment-item')) {
      document.getElementById('commentList').innerHTML = '<div class="empty-comments">첫 댓글을 작성해보세요.</div>';
    }
    showToast('댓글이 삭제됐습니다.', 'success');
  } catch (e) { showToast(e.message || '삭제 실패', 'error'); }
}

/* ── 기사 본문 글자수 ── */
const AI_BODY_BASE = 800;   // 일반 기사 기준 글자수
const AI_BODY_WARN = Math.round(AI_BODY_BASE * 1.2);  // 960
const AI_BODY_OVER = Math.round(AI_BODY_BASE * 2.0);  // 1600

function updateAiBodyCounter() {
  const text = document.getElementById('aiBody')?.value || '';
  const len  = text.length;
  const el   = document.getElementById('aiBodyCounter');
  const btn  = document.getElementById('btnGenerate');
  if (!el) return;

  if (len >= AI_BODY_OVER) {
    el.className = 'ai-body-counter over';
    el.textContent = `${len.toLocaleString()}자 ⚠ 권장량(${AI_BODY_BASE}자) 2배 초과 — 글자수를 줄이세요`;
    if (btn) { btn.disabled = true; btn.title = '글자수가 너무 많습니다. 줄여주세요.'; }
  } else if (len >= AI_BODY_WARN) {
    el.className = 'ai-body-counter warn';
    el.textContent = `${len.toLocaleString()}자 (권장 ${AI_BODY_BASE}자 기준 1.2배 초과)`;
    if (btn) { btn.disabled = !hasImported; btn.title = ''; }
  } else {
    el.className = 'ai-body-counter';
    el.textContent = `${len.toLocaleString()}자`;
    if (btn) { btn.disabled = !hasImported; btn.title = hasImported ? '' : '가져오기 후 사용 가능'; }
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
let toastTimer;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = `toast ${type}`, 2800);
}
