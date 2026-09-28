// docStructure.js
// 교재 한 쪽의 구조를 JSON으로 복원하고(parse), 다시 글로 바꾼다(render). 두 방향이 왕복된다.
//
// ■ 쪽 구조 (structuredContent.pages[i])
//   {
//     pageLabel: "정신전력 - 5" | null,          // 쪽 번호 (본문에서는 지우고 여기에만 보관)
//     title: "우리가 지켜야 하는 대한민국 (1-3. 대한민국을 수호하는 국군)",
//     chapter, lesson,                         // 제목을 나눈 것 (없으면 null)
//     question: { number:"3", text:"…의미는 무엇인가?", tags:["민주주의와 헌법수호"], starred:true } | null,
//     sections: [ { number:"1", title:"국가와 군대의 관계", content:["…"],
//                   subsections:[ { title:"국가와 헌법", content:["…","…"] } ] } ],
//     subsections: [ { section:"1", title:"국가와 헌법" } ],   // 찾아보기용 평면 목록
//     coreContent: ["…"],                     // 핵심 내용 칸의 본문 줄 (제목 줄 제외, 읽는 순서)
//     beliefContent: ["…"],                   // 신념화 칸 항목
//     tables: [ { rows:[["…","…"]] } ], emphasis: ["자유 · 평등 · 정의"],
//     unverified: [ { kind, text, after, reason } ]   // AI만 읽은 줄 (OCR 근거 없음 → 사용자 확인 전까지 학습에서 제외)
//   }
//
// ■ 글 형식 (finalText) — 사용자가 직접 고쳐도 다시 구조로 읽힌다
//   [제목] 우리가 지켜야 하는 대한민국 (1-3. 대한민국을 수호하는 국군)
//   [질문] Q3. (★민주주의와 헌법수호) 군인이 …의미는 무엇인가?
//   [핵심 내용]
//   1. 국가와 군대의 관계
//   - 국가와 헌법
//   대한민국 헌법 제5조 제2항에 …
//   [신념화]
//   ● 국가와 국민은 …
window.DocStructure = (function () {
  const TA = () => TextAnalysis;
  const SECTION_RE = /^(\d{1,2})\s*[.)]\s*(?=\S)(.+)$/;
  const SUB_RE = /^-\s*(.+)$/;
  const BULLET_RE = /^●\s*(.+)$/;

  function emptyPage() {
    return {
      pageLabel: null,
      title: null,
      chapter: null,
      lesson: null,
      question: null,
      sections: [],
      subsections: [],
      coreContent: [],
      beliefContent: [],
      tables: [],
      emphasis: [],
      unverified: [],
      coreLabeled: false,
    };
  }

  // ------------------------------------------------------------------
  // 조각별 해석
  // ------------------------------------------------------------------
  function parseHeader(text) {
    const s = String(text || "")
      .replace(/\s+/g, " ")
      .replace(/^[^가-힣0-9(\[]*[:：]\s*/, "") // "■ :" "1 :" 같은 머리 기호
      .replace(/^[^가-힣0-9(\[]+/, "")
      .trim();
    if (!s) return { title: null, chapter: null, lesson: null };
    const m = s.match(/^(.*?)\s*[(\[]\s*(\d+\s*-\s*\d+\s*\.?\s*[^)\]]*?)\s*[)\]]?\s*$/);
    if (m && m[1].trim()) {
      const lesson = m[2].replace(/\s*-\s*/, "-").replace(/(\d)\s*\.\s*/, "$1. ").trim();
      return { title: `${m[1].trim()} (${lesson})`, chapter: m[1].trim(), lesson };
    }
    return { title: s, chapter: null, lesson: null };
  }

  function parseQuestion(text) {
    let s = String(text || "").replace(/\s+/g, " ").trim();
    if (!s) return null;
    s = s.replace(/^\[질문\]\s*/, "");
    let number = null;
    const m = s.match(/^[QqOo0]?\s*(\d{1,3})\s*[.,]\s*/);
    if (m) {
      number = String(Number(m[1]));
      s = s.slice(m[0].length);
    }
    let tags = [];
    let starred = false;
    const t = s.match(/^[(\[]\s*([★☆*※x]?)\s*([^)\]]{1,40})[)\]]\s*/);
    if (t) {
      starred = !!t[1];
      tags = t[2].split(/[,/·]/).map((x) => x.trim()).filter(Boolean);
      s = s.slice(t[0].length);
    }
    return { number, text: s.trim(), tags, starred };
  }

  /** 핵심 내용 칸: 번호 → 대제목, "- " → 소제목, 나머지 → 본문 (번호·기호 없는 줄). */
  function parseCore(lines, page) {
    let section = null;
    let sub = null;
    const ensureSection = () => {
      if (!section) {
        section = { number: null, title: "", content: [], subsections: [] };
        page.sections.push(section);
      }
      return section;
    };
    for (const raw of lines) {
      const line = String(raw || "").trim();
      if (!line) continue;
      if (/\|/.test(line) && line.split("|").filter((c) => c.trim()).length >= 2) {
        const row = line.split("|").map((c) => c.trim()).filter(Boolean);
        const last = page.tables[page.tables.length - 1];
        if (last && last.open) last.rows.push(row);
        else page.tables.push({ rows: [row], open: true });
        continue;
      }
      for (const t of page.tables) delete t.open;
      let m = line.match(SECTION_RE);
      if (m && !/^\d{1,2}\.\d/.test(line)) {
        section = { number: m[1], title: m[2].trim(), content: [], subsections: [] };
        page.sections.push(section);
        sub = null;
        continue;
      }
      m = line.match(SUB_RE);
      if (m) {
        sub = { title: m[1].trim(), content: [] };
        ensureSection().subsections.push(sub);
        page.subsections.push({ section: section.number, title: sub.title });
        continue;
      }
      const body = line.replace(BULLET_RE, "$1").trim();
      if (sub) sub.content.push(body);
      else ensureSection().content.push(body);
      page.coreContent.push(body);
    }
    for (const t of page.tables) delete t.open;
  }

  /** 신념화 칸: ● 로 항목을 나누고, 기호 없는 줄은 앞 항목에 잇는다 (긴 항목의 줄바꿈). */
  function parseBelief(lines, page) {
    const clean = lines.map((l) => String(l || "").trim()).filter(Boolean);
    const hasBullets = clean.some((l) => BULLET_RE.test(l));
    for (const line of clean) {
      const b = line.match(BULLET_RE);
      const last = page.beliefContent.length - 1;
      if (b) page.beliefContent.push(b[1].trim());
      else if (hasBullets && last >= 0) page.beliefContent[last] = `${page.beliefContent[last]} ${line}`;
      else if (!hasBullets && last >= 0 && /(은|는|이|가|을|를|에|의|와|과|고|며|서|로|,)$/.test(page.beliefContent[last]))
        page.beliefContent[last] = `${page.beliefContent[last]} ${line}`;
      else page.beliefContent.push(line);
    }
  }

  function collectEmphasis(page) {
    const texts = [page.question && page.question.text, ...page.coreContent, ...page.beliefContent].filter(Boolean);
    const out = new Set();
    for (const t of texts) for (const m of t.matchAll(/[‘'“"]([^’'”"]{2,30})[’'”"]/g)) out.add(m[1].trim());
    page.emphasis = [...out];
  }

  function finish(page) {
    collectEmphasis(page);
    return page;
  }

  // ------------------------------------------------------------------
  // 영역(레이아웃 분석 결과) → 구조
  // ------------------------------------------------------------------
  /**
   * @param {{regions:Array<{kind,index,lines:string[]}>, pageLabel}} cleanPage  docCleanup 결과 한 쪽
   */
  function fromRegions(cleanPage) {
    const regions = cleanPage.regions || [];
    if (regions.length === 1 && regions[0].kind === "page") {
      const p = parseText(regions[0].lines.join("\n")).pages[0] || emptyPage();
      p.pageLabel = p.pageLabel || cleanPage.pageLabel || null;
      return p;
    }
    const page = emptyPage();
    page.pageLabel = cleanPage.pageLabel || null;
    const header = regions.find((r) => r.kind === "header");
    if (header) Object.assign(page, parseHeader(header.lines.join(" ")));
    const q = regions.find((r) => r.kind === "question");
    if (q) page.question = parseQuestion(q.lines.join(" "));
    const blocks = regions.filter((r) => r.kind === "block").sort((a, b) => a.index - b.index);
    blocks.forEach((b, i) => {
      const label = regions.find((r) => r.kind === "label" && r.index === b.index);
      let kind = label ? DocCleanup.labelKind(label.lines.join("")) : null;
      if (!kind) kind = blocks.length >= 2 && i === blocks.length - 1 ? "belief" : "core";
      if (kind === "belief") parseBelief(b.lines, page);
      else {
        parseCore(b.lines, page);
        if (label || blocks.length >= 2) page.coreLabeled = true; // 표 칸 + 라벨로 확인된 핵심 내용
      }
    });
    return finish(page);
  }

  // ------------------------------------------------------------------
  // 글 → 구조 (저장된 finalText, 사용자가 고친 글, 레이아웃을 못 찾은 사진)
  // ------------------------------------------------------------------
  const TAG_RE = /^\[(제목|질문|핵심\s*내용|신념화|쪽)\]\s*(.*)$/;

  function hasStructureTags(text) {
    return /^\[(질문|핵심\s*내용|신념화)\]/m.test(String(text || ""));
  }

  /**
   * 태그 형식이면 그대로, 아니면 교재 모양(“Q3.”, “핵심 내용”, “신념화” 줄)으로 추정한다.
   * @returns {{pages: object[], tagged: boolean}}
   */
  function parseText(text) {
    const lines = String(text || "").split(/\r?\n/);
    const tagged = hasStructureTags(text);
    const pages = [];
    let page = null;
    let mode = null;
    let buf = [];
    const flush = () => {
      if (!page) return;
      if (mode === "core") parseCore(buf, page);
      else if (mode === "belief") parseBelief(buf, page);
      else if (mode === "question" && buf.length) {
        const extra = parseQuestion(buf.join(" "));
        if (page.question) page.question.text = `${page.question.text} ${extra.text}`.trim();
      }
      buf = [];
    };
    const newPage = () => {
      flush();
      if (page) pages.push(finish(page));
      page = emptyPage();
      mode = null;
    };
    const QUESTION_LINE = /^\s*[QqO0]\s*\d{1,3}\s*[.,]\s*\S|^\s*\d{1,3}\s*\.\s*[(\[]\s*[★☆*]/;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (tagged) {
        const m = line.match(TAG_RE);
        if (m) {
          const tag = m[1].replace(/\s+/g, "");
          if (tag === "제목") {
            newPage();
            Object.assign(page, parseHeader(m[2]));
            continue;
          }
          if (tag === "질문") {
            if (!page || page.question || page.sections.length || page.beliefContent.length) newPage();
            flush();
            page.question = parseQuestion(m[2]);
            mode = "question";
            continue;
          }
          if (!page) newPage();
          flush();
          if (tag === "쪽") page.pageLabel = m[2].trim() || null;
          mode = tag === "신념화" ? "belief" : tag === "핵심내용" ? "core" : mode;
          if (tag === "핵심내용") page.coreLabeled = true;
          if (m[2].trim() && tag !== "쪽") buf.push(m[2].trim());
          continue;
        }
        if (!page) newPage();
        if (!mode) mode = "core";
        buf.push(line);
        continue;
      }
      // 태그 없는 글: 교재 모양으로 추정
      if (QUESTION_LINE.test(line) && (!page || page.question || page.sections.length)) {
        const keepTitle = page && !page.question && !page.sections.length ? page.title : null;
        newPage();
        if (keepTitle) Object.assign(page, parseHeader(keepTitle));
        page.question = parseQuestion(line);
        mode = "question";
        continue;
      }
      if (!page) newPage();
      if (QUESTION_LINE.test(line) && !page.question) {
        flush();
        page.question = parseQuestion(line);
        mode = "question";
        continue;
      }
      // 칸 라벨: 줄 전체가 라벨이거나, 라벨 바로 뒤에 칸의 첫 줄(● 항목 / 1. 대제목)이 붙어 읽힌 경우만
      //  ("핵심 개념은 …" 같은 일반 문장을 라벨로 오해하지 않도록)
      let label = line.match(/^(핵\s*심\s*내\s*용|핵\s*심|신\s*념\s*화)\s*$/);
      if (!label) label = line.match(/^(신\s*념\s*화)\s*([●•*].*)$/) || line.match(/^(핵\s*심\s*내\s*용)\s*(\d{1,2}\s*[.)].*)$/);
      if (label) label[2] = label[2] || "";
      if (label) {
        flush();
        mode = /신/.test(label[1]) ? "belief" : "core";
        if (mode === "core") page.coreLabeled = true;
        const rest = label[2].trim();
        if (rest && !/^내\s*용$/.test(rest)) buf.push(rest);
        continue;
      }
      if (/^내\s*용$/.test(line)) continue; // "핵심 / 내용"이 두 줄로 읽힌 경우
      if (!mode && !page.question && !page.title && !SECTION_RE.test(line)) {
        Object.assign(page, parseHeader(line));
        continue;
      }
      if (mode === "question") {
        if (SECTION_RE.test(line) || SUB_RE.test(line) || /[?？]$/.test(page.question.text)) {
          flush();
          mode = "core";
        } else {
          page.question.text = `${page.question.text} ${line}`.trim(); // 두 줄로 넘어간 질문
          continue;
        }
      }
      if (!mode) mode = "core";
      buf.push(line);
    }
    flush();
    if (page) pages.push(finish(page));
    return { pages, tagged };
  }

  /**
   * 교재형 구조인지: 질문 칸, 신념화 칸, '핵심 내용' 라벨(또는 표 레이아웃) 중 하나가 있어야 한다.
   * 번호 목록("1. …")만 있는 일반 노트·프린트는 예전 방식(문장 단위 분석)을 그대로 쓴다.
   */
  function isStructured(doc) {
    return !!(doc && doc.pages && doc.pages.some((p) => p.question || p.beliefContent.length || p.coreLabeled));
  }

  // ------------------------------------------------------------------
  // 구조 → 글
  // ------------------------------------------------------------------
  function renderQuestion(q) {
    if (!q) return "";
    const head = q.number ? `Q${q.number}. ` : "";
    const tags = q.tags && q.tags.length ? `(${q.starred ? "★" : ""}${q.tags.join(", ")}) ` : q.starred ? "(★) " : "";
    return `${head}${tags}${q.text || ""}`.trim();
  }

  function renderPage(p) {
    const out = [];
    if (p.title) out.push(`[제목] ${p.title}`);
    if (p.question) out.push(`[질문] ${renderQuestion(p.question)}`);
    const hasCore = p.sections.some((s) => s.title || s.content.length || s.subsections.length) || p.tables.length;
    if (hasCore) {
      out.push("[핵심 내용]");
      for (const s of p.sections) {
        if (s.title) out.push(s.number ? `${s.number}. ${s.title}` : s.title);
        for (const c of s.content) out.push(c);
        for (const sub of s.subsections) {
          out.push(`- ${sub.title}`);
          for (const c of sub.content) out.push(c);
        }
      }
      for (const t of p.tables) for (const r of t.rows) out.push(r.join(" | "));
    }
    if (p.beliefContent.length) {
      out.push("[신념화]");
      for (const b of p.beliefContent) out.push(`● ${b}`);
    }
    return out.join("\n");
  }

  function render(doc) {
    return (doc.pages || []).map(renderPage).filter(Boolean).join("\n\n");
  }

  // ------------------------------------------------------------------
  // 평면 목록 ↔ 구조 (AI 구조와 OCR 구조를 줄 단위로 맞춰 보기 위해)
  // ------------------------------------------------------------------
  function flatten(p) {
    const out = [];
    if (p.title) out.push({ kind: "title", text: p.title });
    if (p.question) out.push({ kind: "question", text: p.question.text, meta: { number: p.question.number, tags: p.question.tags, starred: p.question.starred } });
    for (const s of p.sections) {
      if (s.title) out.push({ kind: "section", text: s.title, meta: { number: s.number } });
      for (const c of s.content) out.push({ kind: "content", text: c });
      for (const sub of s.subsections) {
        out.push({ kind: "subsection", text: sub.title });
        for (const c of sub.content) out.push({ kind: "content", text: c });
      }
    }
    for (const b of p.beliefContent) out.push({ kind: "belief", text: b });
    return out;
  }

  function build(nodes, base) {
    const p = emptyPage();
    if (base) {
      p.pageLabel = base.pageLabel || null;
      p.tables = base.tables || [];
      p.coreLabeled = !!base.coreLabeled;
    }
    let section = null;
    let sub = null;
    const ensureSection = () => {
      if (!section) {
        section = { number: null, title: "", content: [], subsections: [] };
        p.sections.push(section);
      }
      return section;
    };
    for (const n of nodes) {
      if (n.kind === "title") Object.assign(p, parseHeader(n.text));
      else if (n.kind === "question") p.question = { number: (n.meta && n.meta.number) || null, text: n.text, tags: (n.meta && n.meta.tags) || [], starred: !!(n.meta && n.meta.starred) };
      else if (n.kind === "section") {
        section = { number: (n.meta && n.meta.number) || null, title: n.text, content: [], subsections: [] };
        p.sections.push(section);
        sub = null;
      } else if (n.kind === "subsection") {
        sub = { title: n.text, content: [] };
        ensureSection().subsections.push(sub);
        p.subsections.push({ section: section.number, title: sub.title });
      } else if (n.kind === "belief") p.beliefContent.push(n.text);
      else {
        if (sub) sub.content.push(n.text);
        else ensureSection().content.push(n.text);
        p.coreContent.push(n.text);
      }
    }
    return finish(p);
  }

  // ------------------------------------------------------------------
  // AI 구조 검증·병합: AI가 이미지까지 보고 만든 구조를 OCR 구조와 줄 단위로 맞춘다
  //   - 짝이 있는 줄: OcrCorrection.judgeChange(OCR줄, AI줄)로 교정인지 검사
  //       apply → AI 표기 사용 / confirm → OCR 표기 유지 + 사용자 확인 목록 / reject → OCR 표기 유지
  //   - OCR에만 있는 줄: AI가 빠뜨린 것 → 그대로 살린다 (내용 삭제 금지)
  //   - AI에만 있는 줄: OCR 근거 없음 → unverified (사용자가 확인하기 전까지 학습에서 제외)
  //   - 줄의 종류(대제목/소제목/본문/신념화)는 AI 판단을 따른다 (AI는 굵기·들여쓰기를 이미지로 봄)
  // ------------------------------------------------------------------
  function align(a, b) {
    const n = a.length;
    const m = b.length;
    const S = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const M = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
    for (let i = 1; i <= n; i++) M[i][0] = 2;
    for (let j = 1; j <= m; j++) M[0][j] = 3;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const s = TA().similarity(a[i - 1].text, b[j - 1].text);
        let best = S[i - 1][j];
        let mv = 2;
        if (S[i][j - 1] > best) {
          best = S[i][j - 1];
          mv = 3;
        }
        if (s >= 0.45 && S[i - 1][j - 1] + s > best) {
          best = S[i - 1][j - 1] + s;
          mv = 1;
        }
        S[i][j] = best;
        M[i][j] = mv;
      }
    }
    const pairs = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      const mv = M[i][j];
      if (mv === 1) pairs.push([--i, --j]);
      else if (mv === 2) pairs.push([--i, -1]);
      else pairs.push([-1, --j]);
    }
    return pairs.reverse();
  }

  /**
   * @param {object} localPage  OCR+규칙으로 만든 쪽 구조
   * @param {object} aiPage     AI가 돌려준 쪽 구조 (같은 스키마)
   * @returns {{ page, applied:[], uncertain:[], rejected:[], restored:[], unverified:[] }}
   */
  function mergeAi(localPage, aiPage) {
    const L = flatten(localPage);
    const A = flatten(normalizeAiPage(aiPage));
    const pairs = align(L, A);
    const nodes = [];
    const applied = [];
    const uncertain = [];
    const rejected = [];
    const restored = [];
    const unverified = [];
    let lastText = null;
    for (const [li, ai] of pairs) {
      if (li >= 0 && ai >= 0) {
        const l = L[li];
        const a = A[ai];
        const kind = a.kind === l.kind || a.kind !== "title" ? a.kind : l.kind;
        const meta = { ...(l.meta || {}), ...(a.meta || {}) };
        if (Utils.normalizeText(l.text) === Utils.normalizeText(a.text)) {
          nodes.push({ kind, text: a.text.length >= l.text.length - 2 ? a.text : l.text, meta });
        } else {
          const j = OcrCorrection.judgeChange(l.text, a.text, "high");
          if (j.verdict === "apply") {
            nodes.push({ kind, text: a.text, meta });
            applied.push({ from: l.text, to: a.text, reason: `AI 구조 분석 교정 · ${j.why}` });
          } else if (j.verdict === "confirm") {
            nodes.push({ kind, text: l.text, meta });
            uncertain.push({ from: l.text, to: a.text, reason: j.why });
          } else {
            nodes.push({ kind, text: l.text, meta });
            rejected.push({ from: l.text, to: a.text, reason: j.why });
          }
        }
        lastText = nodes[nodes.length - 1].text;
      } else if (li >= 0) {
        nodes.push(L[li]);
        restored.push({ text: L[li].text, reason: "AI 결과에 없던 OCR 줄 (삭제하지 않고 유지)" });
        lastText = L[li].text;
      } else {
        const a = A[ai];
        // AI가 한 줄을 둘로 나눴거나 두 줄을 합친 경우: 이미 있는 줄에 완전히 들어 있으면 근거 있음
        const covered = L.some((l) => TA().containment(a.text, l.text) >= 0.9);
        if (covered && ["section", "subsection"].includes(a.kind)) {
          nodes.push(a);
          continue;
        }
        unverified.push({ kind: a.kind, text: a.text, after: lastText, reason: covered ? "OCR 줄의 일부" : "OCR에서 읽히지 않은 줄 (AI만 읽음)" });
      }
    }
    const page = build(nodes, localPage);
    page.unverified = unverified;
    return { page, applied, uncertain, rejected, restored, unverified };
  }

  /** AI 응답을 스키마에 맞게 다듬는다 (없는 필드는 빈 값). */
  function normalizeAiPage(ai) {
    const p = emptyPage();
    if (!ai || typeof ai !== "object") return p;
    const str = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
    p.title = str(ai.title) || null;
    if (ai.question) {
      const q = typeof ai.question === "string" ? parseQuestion(ai.question) : ai.question;
      p.question = { number: q.number != null ? String(q.number) : null, text: str(q.text), tags: Array.isArray(q.tags) ? q.tags.map(str).filter(Boolean) : [], starred: !!q.starred };
      if (!p.question.text) p.question = null;
    }
    for (const s of Array.isArray(ai.sections) ? ai.sections : []) {
      const sec = { number: s.number != null ? String(s.number) : null, title: str(s.title), content: [], subsections: [] };
      for (const c of Array.isArray(s.content) ? s.content : []) if (str(c)) sec.content.push(str(c));
      for (const sub of Array.isArray(s.subsections) ? s.subsections : []) {
        const ss = { title: str(sub.title), content: (Array.isArray(sub.content) ? sub.content : []).map(str).filter(Boolean) };
        if (ss.title || ss.content.length) sec.subsections.push(ss);
      }
      p.sections.push(sec);
    }
    p.beliefContent = (Array.isArray(ai.beliefContent) ? ai.beliefContent : []).map(str).filter(Boolean);
    return p;
  }

  /** 사용자가 unverified 줄을 [적용]했을 때: 기억해 둔 앞 줄 뒤에 끼워 넣는다. */
  function insertUnverified(page, item) {
    const nodes = flatten(page);
    let at = nodes.length;
    if (item.after) {
      const k = nodes.findIndex((n) => n.text === item.after);
      if (k >= 0) at = k + 1;
    } else at = 0;
    nodes.splice(at, 0, { kind: item.kind === "title" ? "content" : item.kind, text: item.text });
    const next = build(nodes, page);
    next.unverified = (page.unverified || []).filter((u) => u.text !== item.text);
    return next;
  }

  return {
    emptyPage,
    parseHeader,
    parseQuestion,
    parseCore,
    parseBelief,
    fromRegions,
    parseText,
    hasStructureTags,
    isStructured,
    render,
    renderPage,
    renderQuestion,
    flatten,
    build,
    mergeAi,
    normalizeAiPage,
    insertUnverified,
  };
})();
