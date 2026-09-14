// Universal save / load / share for feature pages.
// Each page defines:
//   window.getMenuData()  → returns serializable state object
//   window.setMenuData(d) → restores state from object d

const DM_API = 'https://erilyjnp21.execute-api.ap-southeast-2.amazonaws.com';

const DM_MENU_KEY = (() => {
  const m = window.location.pathname.match(/\/features\/(?:[^/]+)\/([^/]+)\//);
  return m ? m[1] : null;
})();

function _dmToken() { return localStorage.getItem('token'); }

document.addEventListener('DOMContentLoaded', () => {
  if (!DM_MENU_KEY) return;
  _dmInjectHeader();
  _dmInjectUI();
  const share = new URLSearchParams(window.location.search).get('share');
  if (share) _dmLoadShared(share);
});

function _dmInjectHeader() {
  const inner = document.querySelector('.header-inner');
  if (!inner) return;
  const wrap = document.createElement('div');
  wrap.className = 'dm-actions';
  wrap.innerHTML = `
    <button class="dm-hbtn" onclick="dmSave()">💾 저장</button>
    <button class="dm-hbtn" onclick="dmLoad()">🗂 불러오기</button>
    <button class="dm-hbtn" onclick="dmShareNow()">🔗 공유</button>
  `;
  inner.appendChild(wrap);
}

function _dmInjectUI() {
  document.body.insertAdjacentHTML('beforeend', `
    <div class="dm-overlay" id="dmSaveOverlay" onclick="if(event.target===this)dmCloseSave()">
      <div class="dm-modal">
        <h3>💾 버전 저장</h3>
        <input class="dm-input" id="dmSaveTitle" type="text" placeholder="저장 제목 (예: 2025년 1분기)" maxlength="100"
          onkeydown="if(event.key==='Enter')dmConfirmSave();if(event.key==='Escape')dmCloseSave();" />
        <div class="dm-modal-btns">
          <button onclick="dmCloseSave()">취소</button>
          <button class="primary" onclick="dmConfirmSave()">저장</button>
        </div>
      </div>
    </div>
    <div class="dm-overlay" id="dmLoadOverlay" onclick="if(event.target===this)dmCloseLoad()">
      <div class="dm-modal dm-wide">
        <h3>🗂 버전 불러오기</h3>
        <div class="dm-warn">⚠️ 불러오면 현재 입력된 데이터가 모두 초기화됩니다.</div>
        <div class="dm-list" id="dmList"></div>
        <div class="dm-modal-btns"><button onclick="dmCloseLoad()">닫기</button></div>
      </div>
    </div>
    <div id="dmToast" class="dm-toast"></div>
  `);
}

/* ── Save ─────────────────────────────────────────────────── */
function dmSave() {
  if (!_dmToken()) { dmToast('로그인이 필요합니다.', 'error'); return; }
  document.getElementById('dmSaveTitle').value = '';
  document.getElementById('dmSaveOverlay').classList.add('open');
  setTimeout(() => document.getElementById('dmSaveTitle').focus(), 50);
}
function dmCloseSave() { document.getElementById('dmSaveOverlay').classList.remove('open'); }

let _dmSaving = false;
async function dmConfirmSave() {
  if (_dmSaving) return;
  const title = document.getElementById('dmSaveTitle').value.trim();
  if (!title) { dmToast('제목을 입력하세요.', 'error'); return; }
  _dmSaving = true;
  const saveBtn = document.querySelector('#dmSaveOverlay .primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '저장 중...'; }
  const data = window.getMenuData ? window.getMenuData() : {};
  try {
    const res = await fetch(DM_API + '/data/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _dmToken() },
      body: JSON.stringify({ menu_key: DM_MENU_KEY, title, data }),
    });
    const d = await res.json();
    if (!res.ok) {
      if (d.limitExceeded) {
        dmCloseSave();
        dmToast(d.error, 'error');
        setTimeout(() => dmLoad(), 300);
        return;
      }
      dmToast(d.error || '저장 실패', 'error'); return;
    }
    dmCloseSave();
    dmToast('저장되었습니다.', 'success');
  } catch { dmToast('서버 연결 오류', 'error'); }
  finally {
    _dmSaving = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '저장'; }
  }
}

/* ── Load ─────────────────────────────────────────────────── */
async function dmLoad() {
  if (!_dmToken()) { dmToast('로그인이 필요합니다.', 'error'); return; }
  document.getElementById('dmList').innerHTML = '<div class="dm-empty">불러오는 중...</div>';
  document.getElementById('dmLoadOverlay').classList.add('open');
  try {
    const res = await fetch(DM_API + '/data/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _dmToken() },
      body: JSON.stringify({ menu_key: DM_MENU_KEY }),
    });
    const d = await res.json();
    if (!res.ok) { document.getElementById('dmList').innerHTML = '<div class="dm-empty">목록 조회 실패</div>'; return; }
    _dmRenderList(d.list);
  } catch { document.getElementById('dmList').innerHTML = '<div class="dm-empty">서버 연결 오류</div>'; }
}
function dmCloseLoad() { document.getElementById('dmLoadOverlay').classList.remove('open'); }

function _dmRenderList(list) {
  const el = document.getElementById('dmList');
  if (!list?.length) { el.innerHTML = '<div class="dm-empty">저장된 버전이 없습니다.</div>'; return; }
  const rows = list.map(v => {
    const dt = new Date(v.created_at).toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    return `<div class="dm-ver" id="dmv${v.id}">
      <input type="checkbox" class="dm-ver-chk" data-id="${v.id}" onchange="dmOnChkChange()">
      <span class="dm-ver-title">${_dmEsc(v.title)}</span>
      <span class="dm-ver-date">${dt}</span>
      <button class="dm-vbtn" onclick="dmLoadVer(${v.id})">불러오기</button>
      <button class="dm-vbtn share" onclick="dmShareVer(${v.id},this)">🔗 공유</button>
      <button class="dm-vbtn del" onclick="dmDelVer(${v.id},this)">삭제</button>
    </div>`;
  }).join('');
  el.innerHTML = `
    <div class="dm-list-toolbar">
      <label class="dm-chkall-label"><input type="checkbox" id="dmChkAll" onchange="dmToggleAllChk(this)"> 전체선택</label>
      <button class="dm-vbtn del" id="dmDelSelBtn" onclick="dmDelSelected()" disabled>선택 삭제</button>
    </div>
    ${rows}
  `;
}

function dmToggleAllChk(chk) {
  document.querySelectorAll('.dm-ver-chk').forEach(c => c.checked = chk.checked);
  dmOnChkChange();
}

function dmOnChkChange() {
  const checked = document.querySelectorAll('.dm-ver-chk:checked');
  const all = document.querySelectorAll('.dm-ver-chk');
  const btn = document.getElementById('dmDelSelBtn');
  const allChk = document.getElementById('dmChkAll');
  if (btn) {
    btn.disabled = checked.length === 0;
    btn.textContent = checked.length > 0 ? `선택 삭제 (${checked.length}개)` : '선택 삭제';
  }
  if (allChk) {
    allChk.checked = all.length > 0 && checked.length === all.length;
    allChk.indeterminate = checked.length > 0 && checked.length < all.length;
  }
}

async function dmDelSelected() {
  const checked = [...document.querySelectorAll('.dm-ver-chk:checked')];
  if (!checked.length) return;
  if (!confirm(`선택한 ${checked.length}개 버전을 삭제하시겠습니까?`)) return;
  const ids = checked.map(c => parseInt(c.dataset.id));
  const btn = document.getElementById('dmDelSelBtn');
  if (btn) { btn.disabled = true; btn.textContent = '삭제 중...'; }
  try {
    await Promise.all(ids.map(id =>
      fetch(DM_API + '/data/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _dmToken() },
        body: JSON.stringify({ id }),
      })
    ));
    ids.forEach(id => document.getElementById('dmv' + id)?.remove());
    dmToast(`${ids.length}개 버전이 삭제됐습니다.`, 'success');
    if (!document.querySelector('#dmList .dm-ver'))
      document.getElementById('dmList').innerHTML = '<div class="dm-empty">저장된 버전이 없습니다.</div>';
    else dmOnChkChange();
  } catch {
    dmToast('삭제 중 오류가 발생했습니다.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '선택 삭제'; }
  }
}

async function dmLoadVer(id) {
  if (!confirm('현재 데이터가 초기화됩니다. 계속하시겠습니까?')) return;
  try {
    const res = await fetch(DM_API + '/data/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _dmToken() },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    if (!res.ok) { dmToast(d.error || '불러오기 실패', 'error'); return; }
    if (window.setMenuData) window.setMenuData(d.data);
    dmCloseLoad();
    dmToast('불러왔습니다.', 'success');
  } catch { dmToast('서버 연결 오류', 'error'); }
}

async function dmDelVer(id, btn) {
  if (!confirm('이 버전을 삭제하시겠습니까?')) return;
  try {
    const res = await fetch(DM_API + '/data/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _dmToken() },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) { dmToast('삭제 실패', 'error'); return; }
    document.getElementById('dmv' + id)?.remove();
    dmToast('삭제되었습니다.', 'success');
    if (!document.querySelector('#dmList .dm-ver'))
      document.getElementById('dmList').innerHTML = '<div class="dm-empty">저장된 버전이 없습니다.</div>';
    else dmOnChkChange();
  } catch { dmToast('서버 연결 오류', 'error'); }
}

/* ── Share ────────────────────────────────────────────────── */
async function dmShareVer(id, btn) {
  btn.disabled = true; btn.textContent = '생성 중...';
  try {
    const res = await fetch(DM_API + '/data/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _dmToken() },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    if (!res.ok) { dmToast(d.error || '공유 링크 생성 실패', 'error'); return; }
    const url = `${location.origin}${location.pathname}?share=${d.token}`;
    await navigator.clipboard.writeText(url);
    dmToast('공유 링크가 복사됐습니다.', 'success');
  } catch { dmToast('링크 생성 오류', 'error'); }
  finally { btn.disabled = false; btn.textContent = '🔗 공유'; }
}

async function _dmLoadShared(token) {
  try {
    const res = await fetch(DM_API + '/data/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      _dmBlockPage(res.status === 404
        ? { icon: '🔗', title: '유효하지 않은 공유 링크입니다', desc: '공유가 취소됐거나 링크가 만료됐습니다.' }
        : { icon: '⚠️', title: '링크 조회 중 오류가 발생했습니다', desc: '잠시 후 다시 시도해주세요.' }
      );
      return;
    }
    const d = await res.json();
    if (window.setMenuData) window.setMenuData(d.data);
    document.body.insertAdjacentHTML('afterbegin',
      `<div class="dm-share-banner">👁 공유된 버전을 보는 중입니다 · 수정 후 저장하면 별도 버전으로 저장되며, 공유자의 내용은 변경되지 않습니다. 공유가 필요하면 버전을 저장한 뒤 공유 링크를 다시 공유해주세요.&nbsp;&nbsp;<a href="${location.pathname}">내 데이터로 돌아가기</a></div>`
    );
  } catch {
    _dmBlockPage({ icon: '⚠️', title: '서버에 연결할 수 없습니다', desc: '네트워크 상태를 확인해주세요.' });
  }
}

function _dmBlockPage({ icon, title, desc }) {
  document.body.insertAdjacentHTML('afterbegin', `
    <div class="dm-block-page">
      <div class="dm-block-box">
        <div class="dm-block-icon">${icon}</div>
        <div class="dm-block-title">${title}</div>
        <div class="dm-block-desc">${desc}</div>
        <a class="dm-block-btn" href="${location.pathname}">페이지로 돌아가기</a>
      </div>
    </div>
  `);
  document.body.style.overflow = 'hidden';
}

/* ── Share Now ────────────────────────────────────────────── */
async function dmShareNow() {
  if (!_dmToken()) { dmToast('로그인이 필요합니다.', 'error'); return; }
  const data = window.getMenuData ? window.getMenuData() : {};
  dmToast('공유 링크 생성 중...', 'info');
  try {
    const res = await fetch(DM_API + '/data/share-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _dmToken() },
      body: JSON.stringify({ menu_key: DM_MENU_KEY, data }),
    });
    const d = await res.json();
    if (!res.ok) { dmToast(d.error || '공유 링크 생성 실패', 'error'); return; }
    const url = `${location.origin}${location.pathname}?share=${d.token}`;
    await navigator.clipboard.writeText(url);
    dmToast('공유 링크가 복사됐습니다.', 'success');
  } catch { dmToast('오류가 발생했습니다.', 'error'); }
}

/* ── Toast ────────────────────────────────────────────────── */
function dmToast(msg, type = 'info') {
  const el = document.getElementById('dmToast');
  if (!el) return;
  el.textContent = msg;
  el.className = `dm-toast show ${type}`;
  clearTimeout(el._dmT);
  el._dmT = setTimeout(() => { el.className = 'dm-toast'; }, 2800);
}

function _dmEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
