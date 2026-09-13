/**
 * 배틀 퀴즈 — 랜덤 두 마리 중 누가 이길지 맞히고, 정답 이유를 타입 상성으로 설명한다.
 *
 * 승패는 pgo-core 의 duel() 로 판정한다. 두 마리 모두 레벨 40 · 개체값 15/15/15 로 두고
 * 서로에게 가장 잘 통하는 기술 조합을 골라, 상대를 먼저 쓰러뜨리는 쪽이 이긴다.
 */
(function () {
  'use strict';

  const P = window.PGO, UI = window.PGOUI;
  const $ = id => document.getElementById(id);
  const LS = 'pgo.battle.score.v1';
  // 조사 처리는 리뷰 모듈 것을 재사용한다 ('눈설왕가' 같은 오문 방지)
  const josa = (w, k) => (window.PGOReview ? window.PGOReview.josa(w, k) : w);

  let cur = null;        // { duel 결과 }
  let answered = false;

  // ── 점수 ────────────────────────────────────────────────────
  const zero = { right: 0, total: 0, streak: 0, best: 0 };
  function loadScore() {
    try { return Object.assign({}, zero, JSON.parse(localStorage.getItem(LS) || '{}')); }
    catch (e) { return Object.assign({}, zero); }
  }
  function saveScore(s) {
    try { localStorage.setItem(LS, JSON.stringify(s)); } catch (e) { /* 저장 못 해도 진행 */ }
  }
  let score = loadScore();

  function renderScore() {
    $('scoreRight').textContent = score.right;
    $('scoreTotal').textContent = score.total;
    $('scoreRate').textContent = score.total ? `${Math.round(score.right / score.total * 100)}%` : '—';
    $('scoreStreak').textContent = score.streak;
    $('scoreBest').textContent = score.best;
  }

  // ── 문제 만들기 ──────────────────────────────────────────────
  /** 후보 풀 — '잘 알려진'은 최종진화형 위주로 좁혀 이름이 낯설지 않게 한다 */
  function pool() {
    const mode = $('pool').value;
    const base = P.pokemon.filter(p => p.r && p.rating && p.rating.dps > 0);
    if (mode === 'legend') return base.filter(p => p.c !== 0);
    if (mode === 'famous') {
      return base.filter(p =>
        (!p.ev || p.ev.length === 0) &&        // 더 진화하지 않는 최종형
        p.tier <= 2 &&                          // 버림 등급 제외
        p.g <= 5);                              // 1~5세대 (친숙한 쪽)
    }
    return base;
  }

  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  function makeQuestion() {
    const list = pool();
    if (list.length < 2) return null;

    const level = $('level').value;
    // 난이도에 맞는 대결이 나올 때까지 몇 번 굴려 본다 (무한 루프 방지 상한)
    let fallback = null;
    for (let i = 0; i < 300; i++) {
      const a = pick(list);
      let b = pick(list);
      if (a.idx === b.idx) continue;
      if (a.d === b.d) continue;                 // 같은 종의 다른 폼끼리는 제외

      const d = P.duel(a, b);
      if (!d.winner) continue;                   // 무승부는 문제로 내지 않는다
      fallback = fallback || d;

      if (level === 'easy'   && d.margin >= 0.35) return d;
      if (level === 'normal' && d.margin >= 0.08) return d;
      if (level === 'hard'   && d.margin <= 0.12) return d;
    }
    return fallback;
  }

  // ── 렌더 ────────────────────────────────────────────────────
  function side(p, which) {
    const t = P.tier(p);
    return `<button class="pgo-fighter" data-side="${which}" data-idx="${p.idx}">
      ${UI.imgTag(p, 'pgo-fighter-img')}
      <div class="pgo-fighter-name">${UI.esc(p.n)}</div>
      <div class="pgo-fighter-types">${p.t.map(UI.typeBadge).join('')}</div>
      <div class="pgo-fighter-stats">
        <span>공 <b>${p.go.atk}</b></span>
        <span>방 <b>${p.go.def}</b></span>
        <span>체 <b>${p.go.sta}</b></span>
      </div>
      <span class="pgo-tier-tag t${t.id}">${UI.esc(t.ko)}</span>
    </button>`;
  }

  function renderQuestion() {
    answered = false;
    $('answer').innerHTML = '';
    $('next').hidden = true;
    cur = makeQuestion();
    if (!cur) {
      $('vs').innerHTML = '<div class="pgo-empty">조건에 맞는 대결을 만들지 못했습니다. 난이도나 후보 범위를 바꿔 보세요.</div>';
      return;
    }
    $('vs').innerHTML = `
      ${side(cur.a, 'a')}
      <div class="pgo-vs-mark">VS</div>
      ${side(cur.b, 'b')}`;
    highlightMatrix();
  }

  /** 배율을 방어 타입별로 쪼개 설명한다: 바위 → 불꽃 1.6배 × 비행 1.6배 = 2.56배 */
  function breakdown(moveType, defTypes) {
    const parts = defTypes.map(t => {
      const m = P.db.chart[moveType][t];
      return `${P.typeName(t)} ${UI.multText(m)}`;
    });
    const total = P.effectiveness(moveType, defTypes);
    return {
      total,
      text: defTypes.length > 1
        ? `${parts.join(' × ')} = ${UI.multText(total)}`
        : `${parts[0]}`,
    };
  }

  function attackLine(atk, from, to) {
    if (!atk.fast || !atk.charged) {
      return `<div class="pgo-why-row">${UI.esc(josa(from.n, '은는'))} 쓸 만한 공격 기술이 없습니다.</div>`;
    }
    const bf = breakdown(atk.fast.t, to.t);
    const bc = breakdown(atk.charged.t, to.t);
    const stabF = from.t.includes(atk.fast.t);
    const stabC = from.t.includes(atk.charged.t);
    const verdict = m => m > 1.01 ? '<b class="good">잘 통함</b>'
      : m < 0.4 ? '<b class="bad">거의 안 통함</b>'
      : m < 0.99 ? '<b class="bad">잘 안 통함</b>' : '등배';

    return `<div class="pgo-why-block">
      <div class="pgo-why-head">
        ${UI.imgTag(from, 'pgo-why-img')}
        <b>${UI.esc(from.n)}</b> → <b>${UI.esc(to.n)}</b>
        <span class="pgo-why-dps">${atk.dps.toFixed(1)} DPS</span>
      </div>
      <div class="pgo-why-row">
        <span class="pgo-why-k">속공</span>
        ${UI.typeBadge(atk.fast.t)} ${UI.esc(atk.fast.n)}${stabF ? '<span class="pgo-stab">자속 1.2배</span>' : ''}
        <span class="pgo-why-calc">${UI.esc(bf.text)}</span> ${verdict(bf.total)}
      </div>
      <div class="pgo-why-row">
        <span class="pgo-why-k">차지</span>
        ${UI.typeBadge(atk.charged.t)} ${UI.esc(atk.charged.n)}${stabC ? '<span class="pgo-stab">자속 1.2배</span>' : ''}
        <span class="pgo-why-calc">${UI.esc(bc.text)}</span> ${verdict(bc.total)}
      </div>
    </div>`;
  }

  /** 속공·차지 중 상대에게 가장 잘 들어가는(또는 가장 막히는) 기술을 고른다 */
  function edge(atk, defTypes, pickMax) {
    const moves = [atk.fast, atk.charged].filter(Boolean);
    if (!moves.length) return null;
    return moves
      .map(mv => ({ mv, eff: P.effectiveness(mv.t, defTypes) }))
      .reduce((best, c) => (pickMax ? c.eff > best.eff : c.eff < best.eff) ? c : best);
  }

  /** 왜 이겼는지 한 문장으로 */
  function summary(d) {
    const w = d.winner, l = (w === d.a) ? d.b : d.a;
    const wAtk = (w === d.a) ? d.atkA : d.atkB;
    const lAtk = (w === d.a) ? d.atkB : d.atkA;
    // 이긴 쪽은 가장 잘 통한 기술, 진 쪽은 가장 막힌 기술을 근거로 든다
    const wBest = edge(wAtk, l.t, true);
    const lWorst = edge(lAtk, w.t, false);

    const bits = [];
    if (wBest && wBest.eff > 1.01) {
      bits.push(`<b>${UI.esc(w.n)}</b>의 ${P.typeName(wBest.mv.t)} 공격(${UI.esc(wBest.mv.n)})이 <b class="good">${UI.multText(wBest.eff)}</b>로 잘 들어가고`);
    }
    if (lWorst && lWorst.eff < 0.99) {
      bits.push(`<b>${UI.esc(l.n)}</b>의 ${P.typeName(lWorst.mv.t)} 공격은 <b class="bad">${UI.multText(lWorst.eff)}</b>로 막힙니다`);
    }
    if (!bits.length) {
      const atkGap = w.go.atk - l.go.atk;
      bits.push(atkGap > 0
        ? `상성은 비슷하지만 <b>${UI.esc(w.n)}</b>의 공격 종족값이 ${atkGap} 높습니다`
        : `상성은 비슷하지만 <b>${UI.esc(w.n)}</b>${josa(w.n, '이가').slice(-1)} 더 단단해서 오래 버팁니다`);
    }
    const gap = d.margin >= 0.35 ? '일방적입니다' : d.margin >= 0.12 ? '분명한 차이입니다' : '아슬아슬합니다';
    return `${bits.join(', ')}. 승부는 ${gap}`;
  }

  function renderAnswer(chosen) {
    const d = cur;
    const correct = (chosen === d.winner);
    const wTtk = (d.winner === d.a) ? d.ttkA : d.ttkB;
    const lTtk = (d.winner === d.a) ? d.ttkB : d.ttkA;

    score.total += 1;
    if (correct) { score.right += 1; score.streak += 1; score.best = Math.max(score.best, score.streak); }
    else { score.streak = 0; }
    saveScore(score);
    renderScore();

    document.querySelectorAll('.pgo-fighter').forEach(el => {
      const p = UI.byId(el.dataset.idx);
      el.classList.add(p === d.winner ? 'win' : 'lose');
      if (p === chosen) el.classList.add('chosen');
    });

    $('answer').innerHTML = `
      <div class="pgo-verdict ${correct ? 'ok' : 'ng'}">
        <span class="pgo-verdict-mark">${correct ? '○' : '✕'}</span>
        <div>
          <div class="pgo-verdict-title">
            ${correct ? '정답' : '오답'} — 이기는 쪽은 <b>${UI.esc(d.winner.n)}</b>
          </div>
          <div class="pgo-verdict-sub">${summary(d)}</div>
        </div>
      </div>

      <div class="pgo-why">
        ${attackLine(d.atkA, d.a, d.b)}
        ${attackLine(d.atkB, d.b, d.a)}
      </div>

      <div class="pgo-kv" style="margin-top:.9rem">
        <div class="pgo-kv-item">
          <span class="pgo-kv-k">${UI.esc(josa(d.winner.n, '이가'))} 쓰러뜨리는 데</span>
          <span class="pgo-kv-v">${wTtk === Infinity ? '—' : wTtk.toFixed(1) + '초'}</span>
        </div>
        <div class="pgo-kv-item">
          <span class="pgo-kv-k">상대가 쓰러뜨리는 데</span>
          <span class="pgo-kv-v">${lTtk === Infinity ? '—' : lTtk.toFixed(1) + '초'}</span>
        </div>
        <div class="pgo-kv-item"><span class="pgo-kv-k">승부 격차</span><span class="pgo-kv-v">${Math.round(d.margin * 100)}%</span></div>
      </div>

      <div class="pgo-note" style="margin-top:.9rem">
        카드를 누르면 그 포켓몬의 상세를 볼 수 있습니다. 아래 상성표에서 이번 문제에 나온 타입이 노랗게 표시됩니다.
      </div>`;
    $('next').hidden = false;
  }

  // ── 상성표 (문제에 나온 타입 강조) ───────────────────────────
  function renderMatrix() {
    const types = P.types;
    $('matrix').innerHTML = `<thead><tr>
      <th class="corner"><span>공격 \\ 방어</span></th>
      ${types.map(t => `<th class="colhead" data-t="${t.id}">
        <span class="pgo-type" style="background:${P.typeColor(t.id)}">${UI.esc(t.ko)}</span></th>`).join('')}
    </tr></thead><tbody>${types.map(atk => `<tr data-t="${atk.id}">
      <th class="rowhead" data-t="${atk.id}">
        <span class="pgo-type" style="background:${P.typeColor(atk.id)}">${UI.esc(atk.ko)}</span></th>
      ${types.map(def => {
        const m = P.db.chart[atk.id][def.id];
        return `<td class="c pgo-mult ${UI.multClass(m)}" data-m="${m}"
          data-a="${atk.id}" data-d="${def.id}">${UI.multText(m)}</td>`;
      }).join('')}
    </tr>`).join('')}</tbody>`;
  }

  function highlightMatrix() {
    const m = $('matrix');
    m.querySelectorAll('.hl, .hl-soft').forEach(el => el.classList.remove('hl', 'hl-soft'));
    if (!cur) return;
    const involved = new Set([...cur.a.t, ...cur.b.t]);
    involved.forEach(t => {
      m.querySelectorAll(`.colhead[data-t="${t}"], .rowhead[data-t="${t}"]`)
        .forEach(el => el.classList.add('hl'));
    });
    // 두 포켓몬 타입이 서로 맞부딪히는 칸
    cur.a.t.forEach(at => cur.b.t.forEach(dt => {
      m.querySelectorAll(`td[data-a="${at}"][data-d="${dt}"], td[data-a="${dt}"][data-d="${at}"]`)
        .forEach(el => el.classList.add('hl-soft'));
    }));
  }

  // ── 부트 ────────────────────────────────────────────────────
  function boot() {
    renderScore();
    renderMatrix();
    renderQuestion();

    $('vs').addEventListener('click', e => {
      const btn = e.target.closest('.pgo-fighter');
      if (!btn) return;
      const p = UI.byId(btn.dataset.idx);
      if (answered) { UI.openDetail(p); return; }   // 정답 공개 뒤에는 상세 보기
      answered = true;
      renderAnswer(p);
    });

    $('next').addEventListener('click', renderQuestion);
    ['level', 'pool'].forEach(id => $(id).addEventListener('change', renderQuestion));
    $('reset').addEventListener('click', () => {
      score = Object.assign({}, zero);
      saveScore(score);
      renderScore();
    });

    // 키보드: ← → 로 고르고, 스페이스/엔터로 다음 문제
    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' && !answered) { answered = true; renderAnswer(cur.a); }
      else if (e.key === 'ArrowRight' && !answered) { answered = true; renderAnswer(cur.b); }
      else if ((e.key === 'Enter' || e.key === ' ') && answered) { e.preventDefault(); renderQuestion(); }
    });
  }

  UI.boot(boot);
})();
