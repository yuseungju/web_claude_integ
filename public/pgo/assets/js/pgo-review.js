/**
 * 평가 리뷰 생성기 — "왜 좋은지 / 왜 나쁜지"를 계산된 수치에서 뽑아 문장으로 만든다.
 *
 * 추측이나 고정 문구가 아니라 전부 실제 값(종족값 순위, 실기술 DPS, 자속 여부,
 * 타입 상성, 진화 잠재력)에서 근거를 끌어온다. pgo-core.js 이후에 로드된다.
 *
 * 진화 전 포켓몬은 보유 판정이 최종진화 기준이므로, 장단점도 최종진화형을 대상으로
 * 뽑고 현재 상태는 따로 메모에 적는다. 그래야 등급과 설명이 어긋나지 않는다.
 */
(function (global) {
  'use strict';

  const P = global.PGO;

  // ── 한국어 조사 처리 ────────────────────────────────────────
  const NUM_BATCHIM = { 0: true, 1: true, 3: true, 6: true, 7: true, 8: true,
                        2: false, 4: false, 5: false, 9: false };

  /** 마지막 글자에 받침이 있는지 (없으면 null) */
  function batchim(word) {
    const s = String(word).trim();
    if (!s) return null;
    const ch = s[s.length - 1];
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const jong = (code - 0xac00) % 28;
      return { has: jong !== 0, rieul: jong === 8 };
    }
    if (ch >= '0' && ch <= '9') {
      const has = NUM_BATCHIM[Number(ch)];
      // 일(1) · 칠(7) · 팔(8) 은 ㄹ받침이라 '으로'가 아니라 '로'를 쓴다
      return { has, rieul: ch === '1' || ch === '7' || ch === '8' };
    }
    return null;
  }

  /** josa('종족값 300', '은는') -> '종족값 300은' */
  function josa(word, kind) {
    const b = batchim(word);
    const pick = (withB, withoutB) => `${word}${b === null ? withB : (b.has ? withB : withoutB)}`;
    switch (kind) {
      case '은는': return pick('은', '는');
      case '이가': return pick('이', '가');
      case '을를': return pick('을', '를');
      case '와과': return pick('과', '와');
      case '로':   // ㄹ받침은 '로', 그 외 받침은 '으로'
        if (b === null) return `${word}로`;
        return `${word}${b.has && !b.rieul ? '으로' : '로'}`;
      default: return word;
    }
  }

  const pct = (rank, total) => (rank && total ? Math.max(1, Math.round(rank / total * 100)) : null);
  const fmt = n => Number(n).toLocaleString('ko-KR');

  function stabInfo(p) {
    const r = p.rating;
    return {
      fast: !!(r.fast && p.t.includes(r.fast.t)),
      charged: !!(r.charged && p.t.includes(r.charged.t)),
    };
  }

  function typeInfo(p) {
    const prof = P.defenseProfile(p.t);
    const weak = [], resist = [], doubleWeak = [], doubleResist = [];
    Object.entries(prof).forEach(([id, m]) => {
      const t = Number(id);
      if (m > 2) doubleWeak.push(t);
      else if (m > 1.01) weak.push(t);
      if (m < 0.4) doubleResist.push(t);
      else if (m < 0.99) resist.push(t);
    });
    return { weak, resist, doubleWeak, doubleResist,
      weakCount: weak.length + doubleWeak.length,
      resistCount: resist.length };
  }

  const names = ids => ids.map(P.typeName).join('·');

  /** 한 마리를 대상으로 장단점을 뽑는다 (진화 판정과 무관한 순수 평가) */
  function analyse(p) {
    const total = P.totals.overall || 1;
    const r = p.rating;
    const stab = stabInfo(p);
    const ti = typeInfo(p);
    const pros = [], cons = [];

    const atkPct = pct(p.rank.atk, total);
    const dpsPct = pct(p.rank.dps, total);
    const bulkPct = pct(p.rank.bulk, total);

    // ── 좋은 이유 ──
    if (p.rank.atk && atkPct <= 10) {
      pros.push(`공격 ${josa('종족값 ' + p.s[0], '은는')} 전체 ${fmt(p.rank.atk)}위(상위 ${atkPct}%). 때리는 힘 자체가 최상급이다.`);
    }
    if (p.rank.dps && p.rank.dps <= 60) {
      pros.push(`실제 기술 수치까지 넣은 DPS ${josa(r.dps.toFixed(1), '로')} 전체 ${fmt(p.rank.dps)}위. 종족값만 좋은 게 아니라 기술이 받쳐준다.`);
    }
    if (stab.fast && stab.charged) {
      pros.push(`최적 조합 ${josa(r.fast.n + '+' + r.charged.n, '이가')} 둘 다 자속이라 1.2배 보정을 온전히 받는다.`);
    }
    if (p.rank.bulk && bulkPct <= 10) {
      pros.push(`방어 ${p.s[1]} · 체력 ${josa(String(p.s[2]), '로')} 내구가 전체 ${fmt(p.rank.bulk)}위(상위 ${bulkPct}%). 잘 안 죽어서 회복 아이템이 덜 든다.`);
    }
    if (ti.weakCount <= 2) {
      pros.push(`약점이 ${ti.weakCount}개(${names([...ti.doubleWeak, ...ti.weak]) || '없음'})뿐이라 상대를 가리지 않고 데려갈 수 있다.`);
    }
    if (ti.doubleResist.length) {
      pros.push(`${names(ti.doubleResist)} 공격을 2중 반감(0.39배)한다. 해당 타입 보스전에서 특히 오래 버틴다.`);
    }
    if (ti.resistCount >= 6) {
      pros.push(`저항하는 타입이 ${ti.resistCount}개나 돼서 받는 피해가 전반적으로 적다.`);
    }
    p.t.forEach(ty => {
      const rk = p.rank.byType && p.rank.byType[ty];
      if (rk === 1) pros.push(`${P.typeName(ty)} 타입 전체 1위. 이 타입이 필요할 때 첫 번째 선택지다.`);
      else if (rk && rk <= 5) pros.push(`${P.typeName(ty)} 타입 중 ${rk}위.`);
    });
    if (p.c !== 0 && p.rank.classRank && p.rank.classRank <= 10) {
      pros.push(`${P.className(p.c)} 계열 안에서 ${p.rank.classRank}위 / ${fmt(p.rank.classTotal)}종.`);
    }

    // ── 나쁜 이유 ──
    if (p.rank.atk && atkPct >= 70) {
      cons.push(`공격 ${josa('종족값 ' + p.s[0], '은는')} 하위 ${101 - atkPct}% 수준. 화력 밑천이 없어 뭘 배워도 한계가 있다.`);
    }
    if (p.rank.dps && dpsPct >= 70) {
      cons.push(`DPS ${josa(r.dps.toFixed(1), '로')} 전체 ${fmt(p.rank.dps)}위. 레이드에 넣으면 시간만 끈다.`);
    }
    if (r.fast && r.charged && !stab.fast && !stab.charged) {
      cons.push('가장 좋은 조합조차 자속기가 하나도 없어 1.2배 보정을 못 받는다.');
    } else if (r.fast && !stab.fast) {
      cons.push(`속공 ${josa(r.fast.n, '이가')} 비자속이라 평타 화력이 깎인다.`);
    }
    if (ti.doubleWeak.length) {
      cons.push(`${names(ti.doubleWeak)}에 2.56배로 얻어맞는다. 해당 타입 보스 앞에서는 즉사한다.`);
    }
    if (ti.weakCount >= 5) {
      cons.push(`약점이 ${ti.weakCount}개(${names([...ti.doubleWeak, ...ti.weak])})라 쓸 자리를 고르기 어렵다.`);
    }
    if (p.rank.bulk && bulkPct >= 75) {
      cons.push(`내구가 전체 ${fmt(p.rank.bulk)}위로 물몸이다. 한두 방에 정리된다.`);
    }
    if (r.fast && r.charged && r.fast.e) {
      const n = Math.ceil(r.charged.e / r.fast.e);
      const cycle = (n * r.fast.d + r.charged.d) / 1000;
      if (cycle >= 8) {
        cons.push(`차지기 ${josa(r.charged.n, '을를')} 한 번 쓰려면 속공을 ${n}번 넣어야 해서 회전이 ${cycle.toFixed(1)}초로 느리다.`);
      }
    }
    if (p.rank.sta && pct(p.rank.sta, total) <= 15 && atkPct >= 60) {
      cons.push(`체력 ${josa(String(p.s[2]), '은는')} 상위권인데 공격이 따라주지 않는다. 맞아주기만 하고 딜이 안 나온다.`);
    }
    if (!r.fast || !r.charged) {
      cons.push('공격 기술 데이터가 없어 전투에 쓸 수 없다.');
    }

    return { pros, cons, ti, stab, atkPct, dpsPct, bulkPct };
  }

  /**
   * @returns {{ line, pros, cons, notes, basis }}
   *   basis — 장단점을 어느 폼 기준으로 뽑았는지
   */
  function of(p) {
    const inherited = !!(p.potential && p.potential.inherited);
    const target = inherited ? p.potential.src : p;      // 평가 대상
    const a = analyse(target);
    const t = P.tier(p);
    const notes = [];

    if (inherited) {
      const total = P.totals.overall || 1;
      const selfPct = pct(p.rank.dps, total);
      const selfStat = `${P.displayName(p)} 자체는 DPS ${p.rating.dps.toFixed(1)}, 전체 ${fmt(p.rank.dps)}위 / ${fmt(total)}종`;
      // 원래도 강한 종(메가 보유 최종형 등)에 "지금은 못 쓴다"고 붙으면 틀린 말이 된다
      notes.push(`아래 장단점은 <b>${P.displayName(target)}</b> 기준이다. `
        + (selfPct !== null && selfPct <= 25
            ? `${selfStat} 수준이라 이 상태로도 충분히 쓸 만하다. 위 평가는 더 강해졌을 때 기준이다.`
            : `${selfStat}. 지금 데리고 다닐 물건은 아니라 <b>진화가 전제</b>다.`));
    } else if (target.mg && target.mg.length) {
      notes.push('메가진화까지 포함한 평가다. 메가는 일시적이라 상시 전력으로 보려면 한 단계 낮춰 생각하는 게 맞다.');
    }
    if (p.ev && p.ev.length && !inherited) {
      notes.push('더 진화할 수 있지만, 진화해도 지금보다 나아지지 않는다.');
    }

    // ── 한줄평 ──
    // 등급만으로는 상위권이 전부 같은 문장이 되므로, 그 개체를 가장 잘 설명하는
    // 사실 한두 개(타입 1위 / DPS 순위 / 내구 / 약점)를 앞에 붙여 구분되게 한다.
    const facts = [];
    const leadType = p.t.concat(target.t)
      .find(ty => (target.rank.byType && target.rank.byType[ty]) === 1);
    if (leadType) facts.push(`${P.typeName(leadType)} 타입 1위`);

    if (target.rank.dps && target.rank.dps <= 10) facts.push(`전체 DPS ${target.rank.dps}위`);
    else if (target.rank.dps && target.rank.dps <= 60) facts.push('상위권 화력');

    if (target.rank.bulk && a.bulkPct <= 5) facts.push('최상급 내구');
    else if (target.rank.bulk && a.bulkPct <= 15) facts.push('든든한 내구');

    if (a.ti.doubleWeak.length) facts.push(`${names(a.ti.doubleWeak)}에 2.56배 취약`);
    else if (a.ti.weakCount <= 2) facts.push(`약점 ${a.ti.weakCount}개`);

    if (a.atkPct !== null && a.atkPct >= 80) facts.push('화력 자체가 부족');

    const advice = t.id === 0 ? '자원을 몰아줘도 아깝지 않다.'
      : t.id === 1 ? '한 자리 값은 한다.'
      : t.id === 2 ? '대체재가 없을 때 쓴다.'
      : '사탕으로 돌린다.';

    let line = facts.length ? `${facts.slice(0, 2).join(' · ')} — ${advice}`
      : (t.id <= 1 ? `종합 성능 상위권. ${advice}` : `전투에 쓸 값어치가 없다. ${advice}`);
    if (inherited) line += ` (${P.displayName(target)}까지 키운다는 전제)`;

    // 특징이 두드러지지 않아 항목이 안 잡히는 경우, 판정 근거를 요약해 최소 한 줄은 남긴다
    const totalP = P.totals.potential || P.totals.overall || 1;
    if (t.id >= 2 && !a.cons.length) {
      a.cons.push(`끝까지 키워도 잠재력이 전체 ${fmt(p.potentialRank)}위 / ${fmt(totalP)}종 수준이다. 특별히 못하는 건 없지만 굳이 고를 이유도 없다.`);
    }
    if (t.id <= 1 && !a.pros.length) {
      a.pros.push(`잠재력 전체 ${fmt(p.potentialRank)}위 / ${fmt(totalP)}종. 한 방향으로 튀지는 않아도 종합 성능이 상위권이다.`);
    }

    return { line, pros: a.pros, cons: a.cons, notes, basis: target, inherited };
  }

  global.PGOReview = { of, josa };
})(window);
