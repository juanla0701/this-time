// ocrConsensus.js
// 같은 영역을 전처리 방식이 다른 이미지(A: 평탄화 회색조, B: Otsu 이진화, C: 진한 글자만)로 읽은
// OCR 결과 여러 개를 줄 단위로 맞춰 놓고, 낱말 단위 투표로 가장 믿을 만한 한 줄을 고른다.
//
//  1) 기준 결과: 줄별 신뢰도와 "한국어다움"(한글·숫자·일반 문장부호 비율)이 가장 높은 변형
//  2) 줄 맞추기: 다른 변형의 줄을 기준 줄과 글자 유사도로 순서대로 정렬 (없는 줄은 사이에 끼워 넣음)
//  3) 낱말 투표: 낱말 수가 같으면 자리마다 다수결 → 동점이면 문서 전체 어휘에 더 자주 나온 낱말,
//     그다음 줄 신뢰도. 낱말 수가 다르면 다른 결과들과 가장 많이 일치하는 줄을 통째로 고른다.
//  4) 한 변형에서만 나온 줄은 신뢰도·한국어다움이 충분할 때만 남긴다 (뒷면 비침·얼룩 잡음 억제)
// 결과에는 줄마다 어느 변형이 동의했는지(agree)와 다른 후보(alternatives)를 남겨 디버그 화면에서 볼 수 있다.
window.OcrConsensus = (function () {
  const OK_PUNCT = /[.,·ㆍ:;()\[\]‘’“”'"\-~?!/%○●•▪■□★☆※<>「」『』…]/;

  /** 한국어 문장다움 0~1: 한글·숫자·일반 문장부호 비율. 영문이 한글 사이에 섞이면 감점. */
  function quality(text) {
    const s = String(text || "").replace(/\s+/g, "");
    if (!s) return 0;
    let good = 0;
    let latin = 0;
    for (const ch of s) {
      if (/[가-힣0-9]/.test(ch)) good++;
      else if (OK_PUNCT.test(ch)) good += 0.6;
      else if (/[A-Za-z]/.test(ch)) {
        latin++;
        good++;
      }
    }
    const hangul = (s.match(/[가-힣]/g) || []).length;
    let q = good / s.length;
    // 한글 문장 사이에 영문 몇 글자가 섞인 것은 OCR 오인식의 전형 (영문 문장 자체는 감점하지 않음)
    if (hangul >= 3 && latin && latin < hangul) q -= Math.min(0.5, (latin / s.length) * 2.5);
    return Math.max(0, Math.min(1, q));
  }

  function lineScore(l) {
    const c = Math.max(0, Math.min(100, Number(l.confidence) || 0)) / 100;
    return c * 0.5 + quality(l.text) * 0.5;
  }

  function sim(a, b) {
    return TextAnalysis.similarity(a, b);
  }

  function tokens(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean);
  }

  /** 문서 전체 OCR 글에서 낱말 빈도 (조사를 뗀 형태 기준). */
  function buildLexicon(texts) {
    const lex = new Map();
    for (const t of texts) {
      for (const tok of tokens(t)) {
        const stem = TextAnalysis.stripParticle(tok);
        if (stem.length < 2 || !/[가-힣]/.test(stem)) continue;
        lex.set(stem, (lex.get(stem) || 0) + 1);
      }
    }
    return lex;
  }

  /**
   * 기준 줄 목록(groups)에 다른 변형의 줄을 순서를 지키며 맞춘다 (편집 거리식 동적 계획법).
   * 맞는 짝: 유사도 0.35 이상. 짝이 없는 줄은 앞뒤 위치를 지켜 새 그룹으로 끼운다.
   */
  function alignInto(groups, lines, variant) {
    const n = groups.length;
    const m = lines.length;
    const GAP = 0.0;
    const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1=대각 2=위(그룹만) 3=왼쪽(줄만)
    for (let i = 1; i <= n; i++) move[i][0] = 2;
    for (let j = 1; j <= m; j++) move[0][j] = 3;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const s = sim(groups[i - 1].rep, lines[j - 1].text);
        let best = -1;
        let mv = 0;
        if (s >= 0.35) {
          best = score[i - 1][j - 1] + s;
          mv = 1;
        }
        if (score[i - 1][j] + GAP > best) {
          best = score[i - 1][j] + GAP;
          mv = 2;
        }
        if (score[i][j - 1] + GAP > best) {
          best = score[i][j - 1] + GAP;
          mv = 3;
        }
        score[i][j] = best;
        move[i][j] = mv;
      }
    }
    // 역추적
    const pairs = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      const mv = move[i][j];
      if (mv === 1) {
        pairs.push({ g: i - 1, l: j - 1 });
        i--;
        j--;
      } else if (mv === 2) {
        pairs.push({ g: i - 1, l: -1 });
        i--;
      } else {
        pairs.push({ g: -1, l: j - 1 });
        j--;
      }
    }
    pairs.reverse();
    const out = [];
    for (const p of pairs) {
      if (p.g >= 0) {
        const g = groups[p.g];
        if (p.l >= 0) g.members.push({ variant, ...lines[p.l] });
        out.push(g);
      } else {
        const l = lines[p.l];
        out.push({ rep: l.text, members: [{ variant, ...l }], base: false });
      }
    }
    return out;
  }

  /** 한 그룹(같은 줄을 여러 변형이 읽은 것)에서 최종 한 줄을 고른다. */
  function vote(group, lexicon) {
    const cands = group.members;
    if (cands.length === 1) {
      return { text: cands[0].text, confidence: cands[0].confidence, from: cands[0].variant, method: "단독", alternatives: [] };
    }
    const toks = cands.map((c) => tokens(c.text));
    const counts = toks.map((t) => t.length);
    const sameLen = counts.every((c) => c === counts[0]);
    const alternatives = cands.map((c) => ({ variant: c.variant, text: c.text, confidence: Math.round(c.confidence) }));
    if (sameLen && counts[0] > 0) {
      const out = [];
      let changed = 0;
      for (let k = 0; k < counts[0]; k++) {
        const tally = new Map();
        cands.forEach((c, ci) => {
          const t = toks[ci][k];
          const e = tally.get(t) || { votes: 0, best: 0 };
          e.votes += 1;
          e.best = Math.max(e.best, lineScore(c));
          tally.set(t, e);
        });
        const ranked = [...tally.entries()].sort((a, b) => {
          if (b[1].votes !== a[1].votes) return b[1].votes - a[1].votes;
          const la = lexicon.get(TextAnalysis.stripParticle(a[0])) || 0;
          const lb = lexicon.get(TextAnalysis.stripParticle(b[0])) || 0;
          if (lb !== la) return lb - la;
          return b[1].best - a[1].best || quality(b[0]) - quality(a[0]);
        });
        out.push(ranked[0][0]);
        if (tally.size > 1) changed++;
      }
      const conf = Math.max(...cands.map((c) => c.confidence));
      return { text: out.join(" "), confidence: conf, from: "투표", method: changed ? `낱말 투표(${changed}곳)` : "모두 일치", alternatives };
    }
    // 낱말 수가 다르면: 다른 후보들과의 평균 유사도 + 줄 점수가 가장 높은 줄
    let best = null;
    cands.forEach((c, ci) => {
      const others = cands.filter((_, k) => k !== ci);
      const agree = others.reduce((s, o) => s + sim(c.text, o.text), 0) / others.length;
      const sc = agree * 0.6 + lineScore(c) * 0.4;
      if (!best || sc > best.sc) best = { sc, c };
    });
    return { text: best.c.text, confidence: best.c.confidence, from: best.c.variant, method: "가장 많이 일치하는 줄", alternatives };
  }

  /**
   * @param {Array<{variant:string, lines:Array<{text,confidence}>}>} results  같은 영역의 변형별 OCR 결과
   * @param {Map} [lexicon]  문서 전체 어휘 빈도 (buildLexicon)
   * @returns {{ text:string, lines:object[], base:string, dropped:object[] }}
   */
  function merge(results, lexicon) {
    const usable = (results || []).filter((r) => r && r.lines && r.lines.length);
    if (!usable.length) return { text: "", lines: [], base: null, dropped: [] };
    const lex = lexicon || buildLexicon(usable.map((r) => r.lines.map((l) => l.text).join("\n")));
    const ranked = usable
      .map((r) => ({ r, s: r.lines.reduce((s, l) => s + lineScore(l), 0) / r.lines.length }))
      .sort((a, b) => b.s - a.s);
    const base = ranked[0].r;
    let groups = base.lines.map((l) => ({ rep: l.text, members: [{ variant: base.variant, ...l }], base: true }));
    for (const { r } of ranked.slice(1)) groups = alignInto(groups, r.lines, r.variant);

    const lines = [];
    const dropped = [];
    const nVariants = usable.length;
    for (const g of groups) {
      const v = vote(g, lex);
      const agree = g.members.length;
      const q = quality(v.text);
      // 한 변형에서만 보인 줄: 여러 변형을 돌렸는데 하나만 읽었다면 잡음일 가능성이 크다
      const lonely = nVariants >= 2 && agree === 1;
      if (lonely && (v.confidence < 75 || q < 0.7)) {
        dropped.push({ text: v.text, why: "한 변형에서만 읽혔고 신뢰도가 낮음", variant: v.from, confidence: Math.round(v.confidence) });
        continue;
      }
      if (q < 0.35) {
        dropped.push({ text: v.text, why: "글자 대부분이 기호·잡음", variant: v.from, confidence: Math.round(v.confidence) });
        continue;
      }
      lines.push({ ...v, agree, of: nVariants, quality: Math.round(q * 100) / 100 });
    }
    return { text: lines.map((l) => l.text).join("\n"), lines, base: base.variant, dropped };
  }

  return { merge, quality, buildLexicon, tokens };
})();
