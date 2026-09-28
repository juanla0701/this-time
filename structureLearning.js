// structureLearning.js
// 복원된 교재 구조(DocStructure)에서 암기 포인트·중요도·빈칸을 만든다. 글자 수(문장 길이)는 중요도에 쓰지 않는다.
//
// ■ 중요도 (구조 근거만 사용)
//   5 = 상단 질문과 연결된 내용 (질문의 핵심어가 2개 이상 겹치는 대제목·소제목 아래 줄, 그 목록을 여는 "N가지" 줄),
//       질문 자체의 답 개요(핵심 질문 포인트)
//   4 = '핵심 내용' 칸의 나머지 본문
//   3 = '신념화' 칸 (분류: 신념화 — 시험보다는 마음가짐 확인용)
// ■ 빈칸 정답은 핵심 구절만 (문장 전체 금지). 우선순위:
//   콜론 정의(“국가관 : …”) > 따옴표 구절(‘자유 · 평등 · 정의’) > 가운뎃점 나열(자유 · 평등 · 번영)
//   > 괄호 속 나열 > 날짜 > 숫자(제5조, 3가지) > “…하는 것” 서술 구절 > 핵심 낱말(기본 분석)
window.StructureLearning = (function () {
  const TA = () => TextAnalysis;
  const NUM_WORDS = { 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8 };

  function stemsOf(text) {
    return TA()
      .keywordCandidates(text || "")
      .filter((c) => !c.generic && c.stem.length >= 2 && !/^\d+$/.test(c.stem))
      .map((c) => c.stem);
  }

  /** 질문 핵심어와 제목 핵심어가 몇 개 겹치는지 (합성어는 부분 포함도 인정: 정부수립 ⊃ 정부).
   *  common: 그 쪽 제목 대부분에 나오는 낱말(예: p5의 ‘국가’)은 구별력이 없으므로 세지 않는다. */
  function overlap(qStems, text, common) {
    const t = stemsOf(text).filter((s) => !(common && common.has(s)));
    let n = 0;
    for (const s of t) {
      if (qStems.some((q) => q === s || (q.length >= 2 && s.length >= 2 && (q.includes(s) || s.includes(q))))) n++;
    }
    return n;
  }

  // ------------------------------------------------------------------
  // 빈칸 (핵심 구절)
  // ------------------------------------------------------------------
  function okAnswer(ans, sentence) {
    const a = String(ans || "").trim();
    return a.length >= 2 && TA().isGoodBlankAnswer(a, sentence) && sentence.includes(a);
  }

  function phraseBlank(sentence) {
    const s = String(sentence || "").trim();
    const tries = [];
    // 1) 콜론 정의: 정의 쪽이 짧으면 정의를, 길면 용어를 묻는다
    const colon = s.match(/^(.{2,30}?)\s*[:：]\s*(.+?)\.?$/);
    if (colon) {
      const term = colon[1].trim();
      const def = colon[2].trim();
      tries.push({ answer: def, why: "콜론 정의(뜻)" });
      tries.push({ answer: term, why: "콜론 정의(용어)" });
    }
    // 2) 따옴표 구절
    for (const m of s.matchAll(/[‘'“"]([^’'”"]{2,24})[’'”"]/g)) tries.push({ answer: m[1].trim(), why: "따옴표 강조" });
    // 3) 가운뎃점 나열: 자유 · 평등 · 번영
    for (const m of s.matchAll(/[가-힣]{1,8}(?:\s*[·ㆍ]\s*[가-힣]{1,8})+/g)) {
      const list = m[0].replace(/(을|를|이|가|은|는|의|과|와|에)$/, "");
      if (/[·ㆍ]/.test(list)) tries.push({ answer: list.trim(), why: "가운뎃점 나열" });
    }
    // 4) 괄호 속 나열: (자유민주주의, 공화주의, 시장경제)
    for (const m of s.matchAll(/\(([^()]{4,40}?,[^()]{2,40}?)\)/g)) tries.push({ answer: m[1].trim(), why: "괄호 속 나열" });
    // 5) 날짜
    for (const m of s.matchAll(/\d{4}\s*(?:년|\.)\s*\d{1,2}\s*(?:월|\.)\s*(?:\d{1,2}\s*일?)?/g)) tries.push({ answer: m[0].trim().replace(/\.$/, ""), why: "날짜" });
    // 6) 숫자 (제5조 제2항, 3가지, 16개국)
    for (const m of s.matchAll(/제\s*\d+\s*조(?:\s*제\s*\d+\s*항)?|\d+\s*(?:가지|개국|개|명|만|차|회|년|일)/g)) tries.push({ answer: m[0].trim(), why: "숫자" });
    // 7) “…하는 것.” 서술 구절: 목적어 + 서술 + 것
    const pred = s.match(/((?:[가-힣]+\s+){0,1}[가-힣]+(?:을|를|로|으로|에서|와|과)\s+[가-힣]+(?:하는|되는|지키는|는|한|된)\s*것)\.?$/);
    if (pred) tries.push({ answer: pred[1].trim(), why: "서술 구절" });
    for (const t of tries) {
      if (!okAnswer(t.answer, s)) continue;
      const blankText = TA().makeBlank(s, t.answer);
      if (blankText) return { answer: t.answer, blankText, why: t.why };
    }
    // 8) 핵심 낱말: 문장 첫 낱말(주어)보다 세 글자 이상 명사를 우선 (예: 국가 → 운명공동체)
    const first = TA().stripParticle(s.split(/\s+/)[0] || "");
    const cands = TA()
      .keywordCandidates(s)
      .filter((c) => !c.generic && !/(하|되|시키|받|지키)$/.test(c.stem) && TA().isGoodBlankAnswer(c.stem, s))
      .sort((a, b) => (b.stem.length >= 3) - (a.stem.length >= 3) || (a.stem === first) - (b.stem === first) || b.score - a.score);
    for (const c of cands) {
      const blankText = TA().makeBlank(s, c.stem);
      if (blankText) return { answer: c.stem, blankText, why: "핵심 낱말" };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 포인트 만들기
  // ------------------------------------------------------------------
  /** 같은 제목 아래 이어지는 줄 중, 연결어미(…하며, …하고, 쉼표)로 끝난 줄은 다음 줄과 한 문장으로 잇는다. */
  function joinLines(lines) {
    const out = [];
    for (const l of lines) {
      const last = out[out.length - 1];
      if (last && /(며|고|하여|되어|으며|,|및|와|과)$/.test(last.text.trim())) {
        last.text = `${last.text} ${l}`;
        last.lines.push(l);
      } else out.push({ text: l, lines: [l] });
    }
    return out;
  }

  function point(text, excerpt, extra) {
    const blank = extra.noBlank ? null : phraseBlank(text);
    const category = extra.category || (/^[^:：]{2,30}[:：]/.test(text) ? "정의" : TA().categoryOf(text));
    return {
      text,
      sourceExcerpt: excerpt,
      heading: extra.heading || null,
      importance: extra.importance,
      category,
      questionTarget: blank ? blank.answer : null,
      blankText: blank ? blank.blankText : null,
      answer: blank ? blank.answer : null,
      explanation: blank ? `자료: “${excerpt}” → 핵심 구절은 ‘${blank.answer}’입니다.` : `자료: “${excerpt}”`,
      area: extra.area,
      questionLinked: !!extra.linked,
      pageQuestion: extra.pageQuestion || null,
    };
  }

  function enumCount(line) {
    const m = String(line).match(/(\d+|두|세|네|다섯|여섯|일곱|여덟)\s*가지/);
    if (!m) return 0;
    return /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1]] || 0;
  }

  /** "헌법을 수호한다는 것의 의미" → "헌법을 수호한다는 것" (목록 빈칸 정답용) */
  function coreOfTitle(title) {
    return String(title || "")
      .replace(/(의|이라는|라는)?\s*의미$/, "")
      .replace(/\s+$/, "")
      .trim();
  }

  function pagePoints(page) {
    const out = [];
    const q = page.question;
    const qText = q ? q.text : "";
    const qStems = stemsOf(qText);
    const pageQuestion = q ? `${q.number ? `Q${q.number}. ` : ""}${q.text}` : null;
    const titles = [];
    for (const s of page.sections) {
      if (s.title) titles.push(s.title);
      for (const sub of s.subsections) titles.push(sub.title);
    }
    const df = new Map();
    for (const t of titles) for (const st of new Set(stemsOf(t))) df.set(st, (df.get(st) || 0) + 1);
    const common = new Set([...df].filter(([, n]) => titles.length >= 4 && n / titles.length > 0.4).map(([st]) => st));
    const linkedTitle = (t) => !!q && overlap(qStems, t, common) >= 2;

    // 핵심 질문 포인트: 질문 + 답의 뼈대(질문과 연결된 제목들, 없으면 대제목들)
    if (q && qText) {
      const linkedHeads = [];
      for (const s of page.sections) {
        if (s.title && linkedTitle(s.title)) linkedHeads.push(s.title);
        for (const sub of s.subsections) if (linkedTitle(sub.title) && !linkedTitle(s.title)) linkedHeads.push(sub.title);
      }
      const outline = (linkedHeads.length ? linkedHeads : page.sections.map((s) => s.title).filter(Boolean)).slice(0, 6);
      if (outline.length) {
        const text = `${qText} — ${outline.join(" / ")}`;
        const p = point(text, qText, { importance: 5, category: "핵심 질문", area: "question", linked: true, pageQuestion, heading: page.title, noBlank: true });
        // 빈칸: 답 뼈대 중 하나 (문장 전체가 아니라 제목 하나)
        const ans = outline[0];
        if (TA().isGoodBlankAnswer(ans, text)) {
          p.answer = ans;
          p.blankText = TA().makeBlank(text, ans);
          p.questionTarget = ans;
        }
        out.push(p);
      }
    }

    for (const s of page.sections) {
      const sLinked = s.title ? linkedTitle(s.title) : false;
      const subLinked = s.subsections.map((sub) => sLinked || linkedTitle(sub.title));
      // 대제목 바로 아래 줄
      for (const j of joinLines(s.content)) {
        const n = enumCount(j.text);
        const enumSubs = n && s.subsections.length >= n ? s.subsections.slice(0, n) : null;
        if (enumSubs) {
          const linked = sLinked || subLinked.slice(0, n).some(Boolean);
          const titles = enumSubs.map((x) => x.title);
          const text = `${j.text}: ${titles.join(", ")}`;
          const p = point(text, j.text, { importance: linked ? 5 : 4, category: "목록", area: "core", linked, pageQuestion, heading: s.title, noBlank: true });
          const ans = coreOfTitle(titles[0]);
          if (ans && TA().isGoodBlankAnswer(ans, text) && text.includes(ans)) {
            p.answer = ans;
            p.blankText = TA().makeBlank(text, ans);
            p.questionTarget = ans;
          }
          out.push(p);
          continue;
        }
        out.push(point(j.text, j.lines.join(" "), { importance: sLinked ? 5 : 4, area: "core", linked: sLinked, pageQuestion, heading: s.title || page.title }));
      }
      s.subsections.forEach((sub, k) => {
        for (const j of joinLines(sub.content)) {
          out.push(point(j.text, j.lines.join(" "), { importance: subLinked[k] ? 5 : 4, area: "core", linked: subLinked[k], pageQuestion, heading: sub.title }));
        }
      });
    }
    for (const t of page.tables || []) {
      for (const r of t.rows) {
        const text = r.join(" | ");
        out.push(point(text, text, { importance: 4, area: "core", pageQuestion, heading: page.title, category: "표" }));
      }
    }
    for (const b of page.beliefContent) {
      out.push(point(b, b, { importance: 3, category: "신념화", area: "belief", pageQuestion, heading: "신념화" }));
    }
    return out;
  }

  /** 문서 전체 → 포인트 목록 (같은 문장은 한 번만). */
  function pointsFromDoc(doc) {
    const seen = new Set();
    const out = [];
    for (const p of doc.pages || []) {
      for (const pt of pagePoints(p)) {
        const key = Utils.normalizeText(pt.text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(pt);
      }
    }
    return out;
  }

  /** 자료 글이 교재 구조 형식이면 구조 기반 포인트를, 아니면 null (예전 기본 분석 사용). */
  function pointsFromText(text) {
    if (!DocStructure.hasStructureTags(text)) return null;
    const doc = DocStructure.parseText(text);
    if (!DocStructure.isStructured(doc)) return null;
    return pointsFromDoc(doc);
  }

  return { pointsFromDoc, pointsFromText, pagePoints, phraseBlank, overlap, stemsOf, enumCount, coreOfTitle };
})();
