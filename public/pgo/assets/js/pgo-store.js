/**
 * 보관함 저장소 — localStorage 우선, PGO_API_BASE 가 설정돼 있으면 서버(RDS)로 전환.
 *
 * 서버 모드일 때 쓰는 엔드포인트 (lambda/pgo.js 참고):
 *   GET    {base}/pgo/box?key={deviceKey}
 *   POST   {base}/pgo/box            { key, entry }
 *   DELETE {base}/pgo/box/{id}?key={deviceKey}
 *
 * 로그인 대신 브라우저마다 발급하는 deviceKey 로 보관함을 구분한다.
 * 키를 아는 사람은 그 보관함을 볼 수 있으므로 민감한 정보는 넣지 않는다.
 */
(function (global) {
  'use strict';

  const LS_BOX = 'pgo.box.v1';
  const LS_KEY = 'pgo.deviceKey.v1';

  function apiBase() {
    return (global.PGO_API_BASE || '').replace(/\/+$/, '');
  }
  const isRemote = () => !!apiBase();

  /** 브라우저별 보관함 식별자 (없으면 생성) */
  function deviceKey() {
    let k = null;
    try { k = localStorage.getItem(LS_KEY); } catch (e) { /* 프라이빗 모드 등 */ }
    if (!k) {
      k = (crypto.randomUUID ? crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(36).slice(2));
      try { localStorage.setItem(LS_KEY, k); } catch (e) { /* 저장 불가여도 진행 */ }
    }
    return k;
  }

  // ── localStorage 구현 ──────────────────────────────────────
  function lsRead() {
    try { return JSON.parse(localStorage.getItem(LS_BOX) || '[]'); }
    catch (e) { return []; }
  }
  function lsWrite(list) {
    try { localStorage.setItem(LS_BOX, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }

  // ── 서버 구현 ─────────────────────────────────────────────
  async function req(path, opts) {
    const res = await fetch(apiBase() + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, opts));
    if (!res.ok) throw new Error(`서버 오류 (HTTP ${res.status})`);
    return res.json();
  }

  // ── 공개 API ──────────────────────────────────────────────
  async function list() {
    if (!isRemote()) return lsRead();
    const data = await req(`/pgo/box?key=${encodeURIComponent(deviceKey())}`);
    return data.entries || [];
  }

  async function add(entry) {
    const row = Object.assign({
      id: null,
      poke_key: null, nickname: '',
      cp: null, hp: null, level: null,
      iv_atk: null, iv_def: null, iv_sta: null,
      memo: '',
      created_at: new Date().toISOString(),
    }, entry);

    if (!isRemote()) {
      const listNow = lsRead();
      row.id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      listNow.unshift(row);
      if (!lsWrite(listNow)) throw new Error('브라우저 저장소에 쓸 수 없습니다.');
      return row;
    }

    const data = await req('/pgo/box', {
      method: 'POST',
      body: JSON.stringify({ key: deviceKey(), entry: row }),
    });
    return data.entry;
  }

  async function remove(id) {
    if (!isRemote()) {
      lsWrite(lsRead().filter(r => String(r.id) !== String(id)));
      return;
    }
    await req(`/pgo/box/${encodeURIComponent(id)}?key=${encodeURIComponent(deviceKey())}`,
      { method: 'DELETE' });
  }

  async function clear() {
    if (!isRemote()) { lsWrite([]); return; }
    const entries = await list();
    for (const e of entries) await remove(e.id);
  }

  global.PGOStore = {
    list, add, remove, clear, deviceKey,
    get mode() { return isRemote() ? 'server' : 'local'; },
  };
})(window);
