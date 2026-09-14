const API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';

let conversation           = [];
let isSending              = false;
let shareToken             = null;
let isSharedMode           = false;
let sharedSummaryId        = null;   // 공유 링크가 가리키는 버전 ID
let sharedSummaryTitle     = null;   // 공유 버전 제목
let sharedSummaryEditLocked= false;  // 공유 버전 편집 잠금 여부
let loadedSummaryId        = null;   // 현재 로드된 버전 ID (소유자)
let loadedSummaryTitle     = null;   // 현재 로드된 버전 제목
let loadedFileIds          = [];     // 현재 로드된 버전의 파일 ID 목록
let _renameId              = null;
let _checkedIds            = new Set();
let _fileModalSummaryId    = null;
let _loadedConvLen         = 0;
let pendingFiles           = [];   // 버전 저장 전 첨부 대기 파일 { name, type, data, size }
let instructions           = '';   // AI 지침 (시스템 프롬프트)

/* ── 초기화 ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('chatInput');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  instructions = localStorage.getItem('wk_ai_instructions') || '';
  updateInstrBtn();

  const sp    = new URLSearchParams(location.search);
  const token = sp.get('share');
  if (token) {
    shareToken   = token;
    isSharedMode = true;
    document.getElementById('shareBanner').style.display = '';
    initSharedMode(token);
  } else if (!localStorage.getItem('token')) {
    showLoginNotice();
  } else {
    appendWelcome();
    input.focus();
  }
});

async function initSharedMode(token) {
  // 공유 모드: 버튼 전체 제거 — 질의만, DB 저장 없음
  ['btnSave','btnLoad','btnView','btnInstr','btnFile','btnShare','btnClear'].forEach(id =>
    document.getElementById(id)?.remove()
  );
  const topbarActions = document.querySelector('.chat-topbar-actions');
  if (topbarActions) topbarActions.style.display = 'none';

  try {
    const res = await apiFetch('/ai/summary/get', { by_token: true, share_token: token });
    if (res.ok) {
      const data = await res.json();
      sharedSummaryId    = data.id;
      sharedSummaryTitle = data.title;
      // AI 컨텍스트로만 로드 (화면 표시 + 파일 ID 수집)
      loadSummaryAsContext(data);
      await loadFileIdsForContext(data.id);
    } else { appendWelcome(); }
  } catch { appendWelcome(); }
  document.getElementById('chatInput').focus();
}

/* ── API 헬퍼 ─────────────────────────────────────────────── */
function apiFetch(path, body) {
  const token = localStorage.getItem('token');
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return fetch(API + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
}

/* ── 채팅 전송 ────────────────────────────────────────────── */
async function sendMessage() {
  if (isSending) return;
  const input = document.getElementById('chatInput');
  const text  = input.value.trim();
  if (!text) return;

  if (!isSharedMode && !localStorage.getItem('token')) { showLoginNotice(); return; }

  appendMessage('user', text);
  input.value = '';
  input.style.height = 'auto';
  conversation.push({ role: 'user', content: text });

  const loadingId = appendLoading();
  setSending(true);

  try {
    // DB 파일 (버전 로드) + 소유자 pending 파일 (공유 모드는 파일 없음)
    const inlineFiles = isSharedMode ? [] : pendingFiles.map(f => ({
      filename: f.name, content_type: f.type, data: f.data
    }));
    const reqBody = {
      messages: conversation,
      ...(instructions && !isSharedMode ? { system_prompt: instructions } : {}),
      ...(isSharedMode && shareToken ? { share_token: shareToken } : {}),
      ...(loadedFileIds.length ? { file_ids: loadedFileIds } : {}),
      ...(inlineFiles.length   ? { inline_files: inlineFiles } : {}),
    };
    const res  = await apiFetch('/ai/chat', reqBody);
    removeLoading(loadingId);
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401 && !isSharedMode) showLoginNotice();
      else appendError(data.error || '오류가 발생했습니다.');
      conversation.pop(); return;
    }
    appendMessage('assistant', data.content);
    conversation.push({ role: 'assistant', content: data.content });
  } catch (err) {
    removeLoading(loadingId);
    appendError('서버 연결 오류: ' + err.message);
    conversation.pop();
  } finally {
    setSending(false);
    document.getElementById('chatInput').focus();
  }
}

function clearChat() {
  if (conversation.length > 0 && !confirm('대화 내용을 모두 삭제하시겠습니까?')) return;
  conversation = [];
  loadedSummaryId = null; loadedSummaryTitle = null; loadedFileIds = [];
  document.getElementById('chatMessages').innerHTML = '';
  appendWelcome();
}

/* ── 저장 모달 ────────────────────────────────────────────── */
function openSaveModal() {
  if (!conversation.filter(m => m.role === 'user').length) { aiToast('대화 내용이 없습니다.', 'error'); return; }

  // ── 공유 모드: 편집잠금 체크 후 확인 팝업
  if (isSharedMode) {
    if (!sharedSummaryId) { aiToast('공유 정보를 찾을 수 없습니다.', 'error'); return; }
    if (sharedSummaryEditLocked) { aiToast('이 버전은 편집이 잠금되어 있습니다.', 'error'); return; }
    openModal('aiShareSaveModal');
    return;
  }

  if (!localStorage.getItem('token')) { showLoginNotice(); return; }

  // ── 소유자 모드
  const wrap = document.getElementById('saveUpdateWrap');
  if (loadedSummaryId && loadedSummaryTitle) {
    document.getElementById('saveLoadedTitle').textContent = loadedSummaryTitle;
    document.getElementById('saveTitleInput').value = loadedSummaryTitle;
    document.getElementById('modeUpdate').checked = true;
    wrap.style.display = '';
  } else {
    document.getElementById('saveTitleInput').value = '';
    wrap.style.display = 'none';
  }
  openModal('aiSaveModal');
  setTimeout(() => document.getElementById('saveTitleInput').focus(), 50);
}

async function confirmShareSave() {
  const btn = document.getElementById('confirmShareSaveBtn');
  btn.disabled = true; btn.textContent = '저장 중...';
  try {
    // 1. 대화 요약 저장
    const res  = await apiFetch('/ai/summary/save', {
      title: sharedSummaryTitle,
      messages: conversation,
      share_token: shareToken,
    });
    const data = await res.json();
    if (!res.ok) { aiToast(data.error || '저장 실패', 'error'); return; }

    // 2. 대기 중인 파일을 공유 버전에 업로드
    let pfUploaded = 0;
    if (pendingFiles.length > 0) {
      const pf = [...pendingFiles]; pendingFiles = [];
      for (const f of pf) {
        const r = await apiFetch('/ai/summary/file/upload', {
          summary_id: sharedSummaryId,
          filename: f.name, content_type: f.type, data: f.data,
          share_token: shareToken,
        }).catch(() => null);
        if (r?.ok) pfUploaded++;
      }
    }

    closeModal('aiShareSaveModal');
    aiToast(pfUploaded > 0 ? `저장됐습니다. 파일 ${pfUploaded}개 업로드됨` : '저장됐습니다.', 'success');
  } catch { aiToast('서버 연결 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '확인'; }
}

async function confirmSave() {
  const title = document.getElementById('saveTitleInput').value.trim();
  if (!title) { aiToast('제목을 입력하세요.', 'error'); return; }

  const isUpdate = loadedSummaryId && document.getElementById('modeUpdate')?.checked;
  const btn = document.getElementById('confirmSaveBtn');
  btn.disabled = true; btn.textContent = '저장 중...';

  try {
    const res  = await apiFetch('/ai/summary/save', {
      title,
      messages: conversation,
      ...(isUpdate ? { update_id: loadedSummaryId } : {}),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.limitExceeded) { aiToast(data.error, 'error'); closeModal('aiSaveModal'); openLoadModal(); }
      else aiToast(data.error || '저장 실패', 'error');
      return;
    }
    if (data.id) { loadedSummaryId = data.id; loadedSummaryTitle = data.title || title; }
    _loadedConvLen = conversation.length;

    // pending 파일 있으면 새 버전에 업로드
    let pfUploaded = 0;
    if (pendingFiles.length > 0 && data.id) {
      const pf = [...pendingFiles]; pendingFiles = [];
      for (const f of pf) {
        const r = await apiFetch('/ai/summary/file/upload', {
          summary_id: data.id, filename: f.name, content_type: f.type, data: f.data
        }).catch(() => null);
        if (r?.ok) pfUploaded++;
      }
    }

    closeModal('aiSaveModal');
    const base = isUpdate ? '기존 버전이 업데이트됐습니다.' : '요약이 저장됐습니다.';
    aiToast(pfUploaded > 0 ? `${base} 파일 ${pfUploaded}개 업로드됨` : base, 'success');
  } catch { aiToast('서버 연결 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '저장'; }
}

/* ── 불러오기 모달 ────────────────────────────────────────── */
async function openLoadModal() {
  if (!isSharedMode && !localStorage.getItem('token')) { showLoginNotice(); return; }
  _checkedIds.clear();
  document.getElementById('summaryList').innerHTML = '<div class="ai-empty">불러오는 중...</div>';
  openModal('aiLoadModal');
  await loadSummaryList();
}

async function loadSummaryList() {
  try {
    const res  = await apiFetch('/ai/summary/list',
      isSharedMode && shareToken ? { share_token: shareToken } : {});
    const data = await res.json();
    if (!res.ok) { document.getElementById('summaryList').innerHTML = `<div class="ai-empty">${escHtml(data.error)}</div>`; return; }
    renderSummaryList(data.list, data.is_owner);
  } catch { document.getElementById('summaryList').innerHTML = '<div class="ai-empty">서버 오류</div>'; }
}

function renderSummaryList(list, isOwner) {
  const el = document.getElementById('summaryList');
  if (!list?.length) { el.innerHTML = '<div class="ai-empty">저장된 요약이 없습니다.</div>'; updateToolbar(); return; }

  el.innerHTML = list.map(item => {
    const dt = new Date(item.created_at).toLocaleString('ko-KR', { year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    const editLock = item.is_edit_locked;
    const fileInfo = item.file_count > 0 ? `<span class="file-badge">📎${item.file_count}</span>` : '';
    return `<div class="ai-list-row" id="srow${item.id}">
      <input type="checkbox" class="ai-row-chk" data-id="${item.id}" onchange="onRowCheck(this)">
      <div class="ai-row-info" onclick="loadSummaryById(${item.id})">
        <span class="ai-row-title">${escHtml(item.title)}${fileInfo}</span>
        <span class="ai-row-meta">${escHtml(item.user_email)} · ${dt}</span>
      </div>
      <div class="ai-row-actions">
        <button class="ai-sm-btn view"  title="내용 조회"  onclick="viewSummary(${item.id})">👁</button>
        <button class="ai-sm-btn file"  title="파일 관리"  onclick="openFileModal(${item.id},'${escHtml(item.title).replace(/'/g,"\\'")}')">📎</button>
        ${isOwner ? `<button class="ai-sm-btn" title="제목 변경" onclick="openRenameModal(${item.id},'${escHtml(item.title).replace(/'/g,"\\'")}')">✏️</button>` : ''}
        ${isOwner ? `<button class="ai-sm-btn ${editLock?'lock-on':''}" title="${editLock?'편집잠금 해제':'편집잠금'}" onclick="toggleLock(${item.id},${!editLock},'edit')">✏️🔒</button>` : ''}
        ${isOwner ? `<button class="ai-sm-btn share" title="공유 링크" onclick="shareSummary(${item.id},this)">🔗</button>` : ''}
        ${isOwner ? `<button class="ai-sm-btn danger" title="삭제" onclick="deleteSingle(${item.id})">🗑</button>` : ''}
      </div>
    </div>`;
  }).join('');
  updateToolbar();
}

function onRowCheck(chk) {
  const id = parseInt(chk.dataset.id);
  if (chk.checked) _checkedIds.add(id); else _checkedIds.delete(id);
  updateToolbar();
}
function toggleAllCheck(mc) {
  document.querySelectorAll('.ai-row-chk').forEach(c => {
    c.checked = mc.checked;
    const id = parseInt(c.dataset.id);
    if (mc.checked) _checkedIds.add(id); else _checkedIds.delete(id);
  });
  updateToolbar();
}
function updateToolbar() {
  const n   = _checkedIds.size;
  const del = document.getElementById('btnDelSel');
  const mrg = document.getElementById('btnMergeSel');
  if (del) { del.disabled = n === 0; del.textContent = n > 0 ? `선택 삭제(${n})` : '선택 삭제'; }
  if (mrg) { mrg.disabled = n < 2;  mrg.textContent = n >= 2 ? `합치기(${n})` : '합치기'; }
  const all = document.querySelectorAll('.ai-row-chk');
  const mc  = document.getElementById('chkAll');
  if (mc) { mc.checked = all.length > 0 && n === all.length; mc.indeterminate = n > 0 && n < all.length; }
}

/* ── 불러오기 컨텍스트 ────────────────────────────────────── */
async function loadSummaryById(id) {
  try {
    const res  = await apiFetch('/ai/summary/get',
      { id, ...(isSharedMode && shareToken ? { share_token: shareToken } : {}) });
    if (!res.ok) { aiToast('불러오기 실패', 'error'); return; }
    const data = await res.json();
    loadSummaryAsContext(data);
    // 파일 목록도 로드
    await loadFileIdsForContext(id);
    closeModal('aiLoadModal');
    aiToast(`"${data.title}" 불러왔습니다.`, 'success');
  } catch { aiToast('서버 연결 오류', 'error'); }
}

async function loadFileIdsForContext(summaryId) {
  try {
    const res  = await apiFetch('/ai/summary/file/list',
      { summary_id: summaryId, ...(isSharedMode && shareToken ? { share_token: shareToken } : {}) });
    if (res.ok) {
      const data = await res.json();
      loadedFileIds = (data.files || []).map(f => f.id);
      if (loadedFileIds.length) {
        const tag = document.createElement('div');
        tag.className = 'context-loaded';
        tag.innerHTML = `<div class="context-badge">📎 파일 ${loadedFileIds.length}개 AI 분석 연결됨</div>`;
        document.getElementById('chatMessages').appendChild(tag);
        scrollToBottom();
      }
    }
  } catch {}
}

function loadSummaryAsContext(summary) {
  conversation = [];
  loadedSummaryId    = summary.id;
  loadedSummaryTitle = summary.title;
  loadedFileIds      = [];
  document.getElementById('chatMessages').innerHTML = '';
  const ctx = `[이전 대화 요약 — ${new Date(summary.created_at).toLocaleDateString('ko-KR')}]\n\n${summary.content}`;
  conversation.push({ role:'user', content:`[시스템 컨텍스트: 이전 대화 요약]\n${ctx}\n\n이 맥락을 기억하고 이어서 대화해주세요.` });
  conversation.push({ role:'assistant', content:`네, 이전 대화 요약을 확인했습니다. 이어서 도움드리겠습니다!` });
  _loadedConvLen = conversation.length; // 로드 시점 기록

  const wrap = document.createElement('div');
  wrap.className = 'context-loaded';
  wrap.innerHTML = `<div class="context-badge">📋 <strong>${escHtml(summary.title)}</strong> 컨텍스트 로드됨</div>`;
  document.getElementById('chatMessages').appendChild(wrap);
  scrollToBottom();
}

/* ── 내용 조회 ────────────────────────────────────────────── */
async function viewSummary(id) {
  try {
    const res  = await apiFetch('/ai/summary/get',
      { id, ...(isSharedMode && shareToken ? { share_token: shareToken } : {}) });
    const data = await res.json();
    if (!res.ok) { aiToast(data.error || '조회 실패', 'error'); return; }
    document.getElementById('viewModalTitle').textContent = `📄 ${data.title}`;
    document.getElementById('viewContent').innerHTML = renderContent(data.content);
    openModal('aiViewModal');
  } catch { aiToast('서버 연결 오류', 'error'); }
}

/* ── 삭제 ────────────────────────────────────────────────── */
async function deleteSingle(id) {
  if (!confirm('이 요약을 삭제하시겠습니까?')) return;
  await doDelete([id]);
}
async function deleteSelected() {
  const ids = [..._checkedIds];
  if (!ids.length) return;
  if (!confirm(`선택한 ${ids.length}개를 삭제하시겠습니까?`)) return;
  await doDelete(ids);
}
async function doDelete(ids) {
  try {
    const res  = await apiFetch('/ai/summary/delete', { ids });
    const data = await res.json();
    if (!res.ok) { aiToast(data.error || '삭제 실패', 'error'); return; }
    _checkedIds.clear();
    aiToast('삭제됐습니다.', 'success');
    await loadSummaryList();
  } catch { aiToast('서버 연결 오류', 'error'); }
}

/* ── 제목 변경 ───────────────────────────────────────────── */
function openRenameModal(id, title) {
  _renameId = id;
  document.getElementById('renameTitleInput').value = title;
  openModal('aiRenameModal');
  setTimeout(() => document.getElementById('renameTitleInput').focus(), 50);
}
async function confirmRename() {
  const title = document.getElementById('renameTitleInput').value.trim();
  if (!title) { aiToast('제목을 입력하세요.', 'error'); return; }
  try {
    const res  = await apiFetch('/ai/summary/rename', { id: _renameId, title });
    const data = await res.json();
    if (!res.ok) { aiToast(data.error || '실패', 'error'); return; }
    closeModal('aiRenameModal');
    if (_renameId === loadedSummaryId) loadedSummaryTitle = title;
    aiToast('제목이 변경됐습니다.', 'success');
    await loadSummaryList();
  } catch { aiToast('서버 연결 오류', 'error'); }
}

/* ── 지침 설정 ───────────────────────────────────────────── */
function openInstrModal() {
  document.getElementById('instrInput').value = instructions;
  updateInstrMeta();
  openModal('aiInstrModal');
  setTimeout(() => document.getElementById('instrInput').focus(), 50);
}
function saveInstructions() {
  const val = document.getElementById('instrInput').value.trim();
  instructions = val;
  localStorage.setItem('wk_ai_instructions', val);
  updateInstrBtn();
  closeModal('aiInstrModal');
  aiToast(val ? '지침이 저장됐습니다.' : '지침이 초기화됐습니다.', 'success');
}
function clearInstructions() {
  document.getElementById('instrInput').value = '';
  updateInstrMeta();
}
function updateInstrBtn() {
  const btn = document.getElementById('btnInstr');
  if (btn) {
    btn.classList.toggle('instr-active', !!instructions);
    btn.title = instructions ? `지침 적용 중: ${instructions.slice(0,40)}…` : '지침 없음';
  }
}
function updateInstrMeta() {
  const val = document.getElementById('instrInput')?.value || '';
  const el  = document.getElementById('instrMeta');
  if (el) el.textContent = val ? `${val.length}자` : '';
}
document.addEventListener('input', e => {
  if (e.target.id === 'instrInput') updateInstrMeta();
});

/* ── 상단 공유 버튼 ──────────────────────────────────────── */
async function topbarShare() {
  if (!localStorage.getItem('token')) { showLoginNotice(); return; }
  if (!loadedSummaryId) {
    aiToast('요약/저장 버튼을 눌러 먼저 저장해주세요.', 'info'); return;
  }
  if (conversation.length > _loadedConvLen) {
    aiToast('추가된 대화가 있습니다. 저장 버튼을 먼저 눌러 저장 후 공유해주세요.', 'info'); return;
  }
  const btn = document.getElementById('btnShare');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const res  = await apiFetch('/ai/summary/share', { id: loadedSummaryId });
    const data = await res.json();
    if (!res.ok) { aiToast(data.error || '실패', 'error'); return; }
    const url = `${location.origin}${location.pathname}?share=${data.token}`;
    await navigator.clipboard.writeText(url).catch(() => {});
    aiToast('공유 링크가 복사됐습니다! 🔗', 'success');
  } catch { aiToast('서버 연결 오류', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🔗 공유'; } }
}

/* ── 잠금 (편집잠금 ✏️🔒) ─────────────────────────────────── */
async function toggleLock(id, toLock, type) {
  try {
    const res  = await apiFetch('/ai/summary/lock', { id, locked: toLock, lock_type: type });
    const data = await res.json();
    if (!res.ok) { aiToast(data.error || '실패', 'error'); return; }
    const label = type === 'edit' ? '편집잠금' : '삭제잠금';
    aiToast(toLock ? `${label} 설정됐습니다.` : `${label} 해제됐습니다.`, 'success');
    await loadSummaryList();
  } catch { aiToast('서버 연결 오류', 'error'); }
}

/* ── 공유 ────────────────────────────────────────────────── */
async function shareSummary(id, btn) {
  btn.disabled = true;
  try {
    const res  = await apiFetch('/ai/summary/share', { id });
    const data = await res.json();
    if (!res.ok) { aiToast(data.error || '실패', 'error'); return; }
    const url = `${location.origin}${location.pathname}?share=${data.token}`;
    await navigator.clipboard.writeText(url).catch(() => {});
    aiToast('공유 링크가 복사됐습니다.', 'success');
  } catch { aiToast('서버 연결 오류', 'error'); }
  finally { btn.disabled = false; }
}

/* ── 합치기 ──────────────────────────────────────────────── */
function openMergeModal() {
  if (_checkedIds.size < 2) { aiToast('2개 이상 선택하세요.', 'error'); return; }
  document.getElementById('mergeTitleInput').value = '';
  openModal('aiMergeModal');
  setTimeout(() => document.getElementById('mergeTitleInput').focus(), 50);
}
async function confirmMerge() {
  const title = document.getElementById('mergeTitleInput').value.trim();
  if (!title) { aiToast('제목을 입력하세요.', 'error'); return; }
  const btn = document.getElementById('confirmMergeBtn');
  btn.disabled = true; btn.textContent = '합치는 중...';
  try {
    const res  = await apiFetch('/ai/summary/merge', {
      ids: [..._checkedIds], title,
      ...(isSharedMode && shareToken ? { share_token: shareToken } : {})
    });
    const data = await res.json();
    if (!res.ok) { aiToast(data.error || '실패', 'error'); return; }
    closeModal('aiMergeModal');
    _checkedIds.clear();
    aiToast('합치기 완료!', 'success');
    await loadSummaryList();
  } catch { aiToast('서버 연결 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '합치기'; }
}

/* ── 메인화면 내용 조회 ──────────────────────────────────── */
function viewLoadedSummary() {
  if (!loadedSummaryId) { aiToast('불러온 버전이 없습니다.', 'info'); return; }
  viewSummary(loadedSummaryId);
}

/* ── 메인화면 파일 버튼 ──────────────────────────────────── */
function openMainFileModal() {
  if (!localStorage.getItem('token')) { showLoginNotice(); return; }
  // 버전 없어도 파일 첨부 가능 — pending 파일로 관리
  openFileModal(loadedSummaryId, loadedSummaryTitle || '');
}

/* ── 파일 관리 ───────────────────────────────────────────── */
async function openFileModal(summaryId, title) {
  _fileModalSummaryId = summaryId || null;
  document.getElementById('fileModalTitle').textContent =
    title || (_fileModalSummaryId ? '' : '대기 중 파일 (저장 시 자동 업로드)');
  document.getElementById('fileList').innerHTML = '<div class="ai-empty">불러오는 중...</div>';
  openModal('aiFileModal');
  await refreshFileList(); // DB 파일 + pending 파일 통합 표시
}

function _fmtSize(bytes) {
  return bytes > 1024*1024 ? `${(bytes/1024/1024).toFixed(1)}MB` : `${(bytes/1024).toFixed(0)}KB`;
}

async function refreshFileList() {
  const el = document.getElementById('fileList');
  const canDelete = !isSharedMode && !!localStorage.getItem('token');
  let parts = [];

  // DB 파일 목록
  if (_fileModalSummaryId) {
    try {
      const res  = await apiFetch('/ai/summary/file/list',
        { summary_id: _fileModalSummaryId, ...(isSharedMode && shareToken ? { share_token: shareToken } : {}) });
      const data = await res.json();
      if (res.ok && data.files?.length) {
        parts = data.files.map(f => `<div class="file-row">
          <span class="file-name">${escHtml(f.filename)}</span>
          <span class="file-size">${_fmtSize(f.file_size)}</span>
          <button class="ai-sm-btn download" title="다운로드"
                  onclick="downloadFile(${f.id},'${escHtml(f.filename).replace(/'/g,"\\'")}')">⬇</button>
          ${canDelete ? `<button class="ai-sm-btn danger" title="삭제" onclick="deleteFile(${f.id})">🗑</button>` : ''}
        </div>`);
      }
    } catch {}
  }

  // pending 파일 (공유 모드 포함)
  if (pendingFiles.length) {
    parts = parts.concat(pendingFiles.map((f, i) => `<div class="file-row pending-file">
      <span class="file-name">⏳ ${escHtml(f.name)}</span>
      <span class="file-size">${_fmtSize(f.size)}</span>
      <button class="ai-sm-btn danger" title="삭제" onclick="removePendingFile(${i})">🗑</button>
    </div>`));
  }

  el.innerHTML = parts.length
    ? parts.join('')
    : `<div class="ai-empty">파일 없음${!_fileModalSummaryId || isSharedMode ? '<br><small style="color:#6b7280">저장 시 업로드됩니다</small>' : ''}</div>`;
}

async function downloadFile(fileId, filename) {
  try {
    const res  = await apiFetch('/ai/summary/file/get',
      { file_id: fileId, ...(isSharedMode && shareToken ? { share_token: shareToken } : {}) });
    const data = await res.json();
    if (!res.ok) { aiToast(data.error || '다운로드 실패', 'error'); return; }
    const bytes = atob(data.data);
    const arr   = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const blob  = new Blob([arr], { type: data.content_type || 'application/octet-stream' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { aiToast('다운로드 오류', 'error'); }
}

function copyViewContent() {
  const raw = document.getElementById('viewContent').innerText || '';
  navigator.clipboard.writeText(raw).then(() => aiToast('복사됐습니다.', 'success')).catch(() => {});
}

async function handleFileSelect() {
  const input = document.getElementById('fileInput');
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;

  // 공유 모드 또는 버전 없으면 pending (저장 시 업로드)
  const usePending = !_fileModalSummaryId || isSharedMode;

  for (const file of files) {
    if (file.size > 3 * 1024 * 1024) { aiToast(`${file.name}: 3MB 초과`, 'error'); continue; }
    const b64 = await fileToBase64(file);

    if (usePending) {
      // 버전 없음 → 대기 파일로 저장
      pendingFiles.push({ name: file.name, type: file.type || 'application/octet-stream', data: b64, size: file.size });
      aiToast(`${file.name} 추가됨 (저장 시 업로드)`, 'success');
    } else {
      // 버전 있음 → 즉시 업로드
      try {
        const res = await apiFetch('/ai/summary/file/upload', {
          summary_id: _fileModalSummaryId,
          filename: file.name,
          content_type: file.type || 'application/octet-stream',
          data: b64,
          ...(isSharedMode && shareToken ? { share_token: shareToken } : {}),
        });
        const d = await res.json();
        if (!res.ok) { aiToast(d.error || '업로드 실패', 'error'); continue; }
        aiToast(`${file.name} 업로드 완료`, 'success');
      } catch { aiToast(`${file.name} 업로드 오류`, 'error'); }
    }
  }

  if (usePending) {
    refreshPendingFileList();
  } else {
    await refreshFileList();
    if (!isSharedMode) await loadSummaryList();
  }
}

function refreshPendingFileList() { refreshFileList(); }

async function handleFolderSelect() {
  const input = document.getElementById('folderInput');
  const all   = [...input.files];
  input.value = '';
  if (!all.length) return;

  const SUPPORTED = ['.txt','.md','.csv','.json','.pdf','.png','.jpg','.jpeg',
                     '.webp','.gif','.xlsx','.xls','.html','.htm','.js','.ts',
                     '.py','.java','.css','.xml','.yaml','.yml','.sh'];
  const MAX_PER_FOLDER = 30;
  const MAX_FILE_SIZE  = 3 * 1024 * 1024;

  const valid = all.filter(f => {
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    return SUPPORTED.includes(ext) && f.size <= MAX_FILE_SIZE;
  }).slice(0, MAX_PER_FOLDER);

  if (!valid.length) { aiToast('지원되는 파일이 없거나 모두 3MB 초과입니다.', 'error'); return; }

  const skipped  = all.length - valid.length;
  const usePending = !_fileModalSummaryId || isSharedMode;

  for (const file of valid) {
    const relPath = file.webkitRelativePath || file.name; // 폴더 경로 보존
    const b64     = await fileToBase64(file);
    if (usePending) {
      pendingFiles.push({ name: relPath, type: file.type || 'application/octet-stream', data: b64, size: file.size });
    } else {
      const res = await apiFetch('/ai/summary/file/upload', {
        summary_id: _fileModalSummaryId, filename: relPath,
        content_type: file.type || 'application/octet-stream', data: b64,
        ...(isSharedMode && shareToken ? { share_token: shareToken } : {}),
      }).catch(() => null);
      if (!res?.ok) { const d = await res?.json().catch(()=>{}); aiToast((d?.error)||`${relPath} 실패`,'error'); }
    }
  }

  const msg = `${valid.length}개 추가${skipped > 0 ? ` (${skipped}개 제외)` : ''}`;
  aiToast(msg + (usePending ? ' · 저장 시 업로드' : ''), 'success');
  if (usePending) refreshPendingFileList();
  else { await refreshFileList(); if (!isSharedMode) await loadSummaryList(); }
}

function removePendingFile(idx) {
  pendingFiles.splice(idx, 1);
  refreshPendingFileList();
}

async function deleteFile(fileId) {
  if (!confirm('이 파일을 삭제하시겠습니까?')) return;
  try {
    const res = await apiFetch('/ai/summary/file/delete', { file_id: fileId });
    const d   = await res.json();
    if (!res.ok) { aiToast(d.error || '삭제 실패', 'error'); return; }
    aiToast('삭제됐습니다.', 'success');
    await refreshFileList();
    await loadSummaryList();
    // 현재 로드된 버전의 파일이면 업데이트
    if (_fileModalSummaryId === loadedSummaryId)
      loadedFileIds = loadedFileIds.filter(id => id !== fileId);
  } catch { aiToast('서버 연결 오류', 'error'); }
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload  = () => res(reader.result.split(',')[1]);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

/* ── UI 공통 ─────────────────────────────────────────────── */
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function appendWelcome() {
  if (!document.getElementById('chatMessages').innerHTML)
    appendMessage('assistant', '안녕하세요! 무엇이든 물어보세요. 😊');
}
function appendMessage(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  wrap.innerHTML = `<div class="message-avatar">${role==='assistant'?'🤖':'👤'}</div><div class="message-bubble">${renderContent(content)}</div>`;
  document.getElementById('chatMessages').appendChild(wrap);
  scrollToBottom();
}
function appendLoading() {
  const id = 'ld-'+Date.now();
  const w  = document.createElement('div');
  w.id = id; w.className = 'message assistant';
  w.innerHTML = `<div class="message-avatar">🤖</div><div class="message-bubble"><div class="loading-dots"><span></span><span></span><span></span></div></div>`;
  document.getElementById('chatMessages').appendChild(w);
  scrollToBottom(); return id;
}
function removeLoading(id) { document.getElementById(id)?.remove(); }
function appendError(msg) {
  const w = document.createElement('div');
  w.className = 'message error';
  w.innerHTML = `<div class="message-bubble">⚠️ ${escHtml(msg)}</div>`;
  document.getElementById('chatMessages').appendChild(w);
  scrollToBottom();
}
function showLoginNotice() {
  document.getElementById('chatMessages').innerHTML = `<div class="login-notice">🔒 로그인 후 이용하거나, 공유 링크로 접속하세요.<br><a href="../../../index.html">메인에서 로그인</a></div>`;
  document.getElementById('sendBtn').disabled = document.getElementById('chatInput').disabled = true;
}
function setSending(f) {
  isSending = f;
  document.getElementById('sendBtn').disabled = document.getElementById('chatInput').disabled = f;
  document.getElementById('sendBtn').textContent = f ? '…' : '전송';
}
function scrollToBottom() { const e=document.getElementById('chatMessages'); e.scrollTop=e.scrollHeight; }
function aiToast(msg, type='info') {
  const el=document.getElementById('aiToast');
  el.textContent=msg; el.className=`ai-toast show ${type}`;
  clearTimeout(el._t); el._t=setTimeout(()=>el.className='ai-toast',2800);
}
function renderContent(text) {
  const e=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return e.replace(/```[\w]*\n?([\s\S]*?)```/g,'<pre><code>$1</code></pre>')
          .replace(/`([^`\n]+)`/g,'<code class="inline">$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>')
          .replace(/\*([^*\n]+)\*/g,'<em>$1</em>')
          .replace(/\n/g,'<br>');
}
function escHtml(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

window.getMenuData = () => ({ conversation, loadedSummaryId, loadedSummaryTitle });
window.setMenuData = d => {
  conversation = d.conversation || [];
  loadedSummaryId = d.loadedSummaryId || null;
  loadedSummaryTitle = d.loadedSummaryTitle || null;
  document.getElementById('chatMessages').innerHTML = '';
  if (!conversation.length) { appendWelcome(); return; }
  conversation.forEach(m => appendMessage(m.role, m.content));
};
