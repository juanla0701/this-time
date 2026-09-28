// docCleanup.js
// OCR 결과(영역별 줄 목록)를 문서로 쓰기 전에 정리한다. 모든 정리는 "지우거나 교정"만 하고 내용을 더하지 않는다.
// 무엇을 왜 바꿨는지 전부 log에 남겨 디버그 화면과 [원본 OCR 보기]에서 확인할 수 있다.
//
//  1) 워터마크 제거
//     - "계급/이름/2025-01-01 09:00"처럼 사선(/)으로 이어진 조각 + 날짜·시각 패턴
//     - 이렇게 찾은 워터마크에서 이름 같은 낱말을 배워(learned) 다른 줄·다른 쪽에 떨어져 나온 조각도 제거.
//       단, 낱말 뒤에 조사가 붙어 있으면(= 문장 속 진짜 단어) 지우지 않는다 → 내용과 겹치는 부분 보호
//     - 워터마크 날짜의 숫자 조각(2026, 08, 13, 13:30)이 한글 낱말 사이에 홀로 끼어든 경우만 제거
//  2) 쪽 번호 제거: 아래쪽 영역의 "정신전력 - 5", "- 5 -", "5" 같은 줄 → pageLabel로만 보관
//  3) 잡음 줄 제거: 기호뿐인 줄, 홑자모(ㄱ·ㅏ)가 많은 줄, 한국어다움이 너무 낮은 줄 (뒷면 비침·얼룩)
//  4) 글머리 기호 통일: ●•·*∙ → ●, ―ㅡ–— → -
//  5) 용어 통일: 문서 전체에서 3번 이상 나온 낱말과 자모 1~2개만 다르고, 그 차이가 OCR이 자주 헷갈리는
//     모양(ㄴ/ㄹ, ㅓ/ㅕ, ㄴ/ㄷ …)이며, 드물게(1~2번) 나온 낱말만 다수 표기로 바꾼다.
//     예) 대할민국→대한민국, 국굳→국군, 현법→헌법. 사전 지식이 아니라 "이 문서 안의 빈도"만 근거로 쓴다.
window.DocCleanup = (function () {
  const TA = () => TextAnalysis;

  // ------------------------------------------------------------------
  // 워터마크
  // ------------------------------------------------------------------
  // 날짜+시각(“2025-01-01 09:00”)은 워터마크로 본다. 날짜만 있는 것(“1948. 8. 15”)은 내용일 수 있으므로
  // 워터마크 조각(사선 사슬) 안에서 확인된 날짜와 똑같을 때만 지운다.
  const DATE_PART = "(?:19|20)\\d{2}\\s*[-./]\\s*\\d{1,2}\\s*[-./]\\s*\\d{1,2}";
  const DATE_TIME_RE = new RegExp(DATE_PART + "\\s*\\d{1,2}\\s*:\\s*\\d{2}", "g");
  const DATE_RE = new RegExp(DATE_PART, "g");
  const SLASH_CHAIN_RE = new RegExp(
    "\\/?\\s*(?:[가-힣A-Za-z0-9]{1,8}\\s*\\/\\s*)+(?:" + DATE_PART + "(?:\\s*\\d{1,2}\\s*:\\s*\\d{2})?|[가-힣A-Za-z0-9]{1,8})?",
    "g"
  );
  const TIME_RE = /\b\d{1,2}\s*:\s*\d{2}\b/g;

  /** 사선 사슬이 워터마크인지: 날짜·시각을 품었거나, 사선이 앞/뒤에 매달려 있거나, 배운 워터마크 낱말이 들어 있을 때. */
  function chainIsWatermark(chunk, wm) {
    const c = chunk.trim();
    if (!c.includes("/")) return false;
    if (new RegExp(DATE_PART).test(c) || /\d{1,2}\s*:\s*\d{2}/.test(c)) return true;
    if (/^\/|\/$/.test(c)) return true;
    if (wm && wm.words && c.split(/[\/\s]+/).some((p) => wm.words.includes(p))) return true;
    return false;
  }

  /** 모든 쪽의 글에서 워터마크 신호를 모아 "배운 워터마크 낱말·날짜·숫자 조각"을 만든다. */
  function learnWatermark(allTexts) {
    const words = new Map(); // 이름 같은 한글 조각 → 몇 쪽에서 봤는지
    const digits = new Set();
    const dates = new Set();
    const samples = [];
    const addDigits = (str) => {
      for (const d of str.match(/\d+/g) || []) if (d.length >= 2) digits.add(d);
      const t = str.match(/\d{1,2}\s*:\s*\d{2}/);
      if (t) digits.add(t[0].replace(/\s+/g, ""));
      const dt = str.match(DATE_RE);
      if (dt) for (const x of dt) dates.add(x.replace(/\s+/g, ""));
    };
    allTexts.forEach((text) => {
      const seen = new Set();
      for (const m of String(text).matchAll(SLASH_CHAIN_RE)) {
        const chunk = m[0];
        if (!chainIsWatermark(chunk, null)) continue;
        samples.push(chunk.trim());
        addDigits(chunk);
        for (const piece of chunk.split(/[\/\s]+/)) {
          const p = piece.trim();
          if (/^[가-힣]{2,5}$/.test(p)) seen.add(p);
        }
      }
      for (const m of String(text).matchAll(DATE_TIME_RE)) {
        samples.push(m[0]);
        addDigits(m[0]);
      }
      for (const w of seen) words.set(w, (words.get(w) || 0) + 1);
    });
    return {
      words: [...words.keys()],
      wordPages: Object.fromEntries(words),
      digits: [...digits],
      dates: [...dates],
      samples: [...new Set(samples)].slice(0, 12),
    };
  }

  const PARTICLE_TAIL = /(은|는|이|가|을|를|에|의|와|과|도|로|으로|에서|에게|께서|이다|이며|이고|이나|만)$/;

  /** 한 줄에서 워터마크 조각을 지운다. 반환: { text, removed:[...] } */
  function stripWatermark(line, wm) {
    let text = line;
    const removed = [];
    const cut = (re, why) => {
      text = text.replace(re, (m) => {
        removed.push({ from: m.trim(), why });
        return " ";
      });
    };
    text = text.replace(SLASH_CHAIN_RE, (m) => {
      if (!chainIsWatermark(m, wm)) return m;
      // 사슬 맨 앞 조각이 문장 속 낱말(조사가 붙었거나 문서에 자주 나옴)이면 그 낱말은 살린다
      const pieces = m.split("/");
      let keep = "";
      const first = pieces[0].trim();
      const lexCount = wm && wm.lexicon ? wm.lexicon.get(TA().stripParticle(first)) || 0 : 0;
      if (first && /[가-힣]/.test(first) && !(wm && wm.words.includes(first)) && (PARTICLE_TAIL.test(first) || lexCount >= 2)) {
        keep = pieces.shift();
      }
      const cutPart = pieces.join("/").trim();
      if (!cutPart) return m;
      removed.push({ from: cutPart, why: "워터마크(사선으로 이어진 이름·날짜)" });
      return keep ? `${keep} ` : " ";
    });
    cut(DATE_TIME_RE, "워터마크(날짜·시각)");
    if (wm && wm.dates && wm.dates.length) {
      text = text.replace(DATE_RE, (m) => {
        if (!wm.dates.includes(m.replace(/\s+/g, ""))) return m;
        removed.push({ from: m.trim(), why: "워터마크(다른 곳의 워터마크와 같은 날짜)" });
        return " ";
      });
    }
    if (removed.length) cut(TIME_RE, "워터마크(시각)");
    // 배운 워터마크 낱말: 조사 없이 홀로 떨어진 경우만 (문장 속 진짜 단어 보호)
    if (wm && wm.words.length) {
      const toks = text.split(/(\s+)/);
      for (let i = 0; i < toks.length; i++) {
        const raw = toks[i];
        const t = raw.replace(/^[\/|]+|[\/|]+$/g, "");
        if (!t || !wm.words.includes(t)) continue;
        const hadSlash = t !== raw;
        const onlyToken = text.trim() === raw.trim();
        const neighborWm = [toks[i - 2], toks[i + 2]].some((n) => n && (/\//.test(n) || wm.words.includes(n.replace(/\//g, "")) || wm.digits.includes(n)));
        // 문서 다른 곳에서 조사가 붙은 형태(예: "상사의")로 쓰였다면 진짜 내용 낱말일 수 있으므로,
        // 그때는 사선·다른 워터마크 조각과 붙어 있을 때만 지운다
        const isContentWord = (wm.protectedWords || []).includes(t);
        if (hadSlash || onlyToken || neighborWm || (!isContentWord && !PARTICLE_TAIL.test(t))) {
          removed.push({ from: raw.trim(), why: "워터마크 낱말(다른 곳의 워터마크에서 확인됨)" });
          toks[i] = " ";
        }
      }
      text = toks.join("");
    }
    // 워터마크 숫자 조각이 한글 낱말 사이에 홀로 끼어든 경우
    if (wm && wm.digits.length) {
      const toks = text.split(/\s+/);
      const keep = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        const isWmDigit = /^[0-9:]{2,5}$/.test(t) && wm.digits.includes(t);
        const prevHangul = i > 0 && /[가-힣]$/.test(toks[i - 1]);
        const nextHangul = i < toks.length - 1 && /^[가-힣]/.test(toks[i + 1]);
        // "13 개", "5 조"처럼 숫자 뒤에 단위가 띄어 쓰인 경우는 내용이므로 남긴다 (시각 13:30은 항상 워터마크)
        const nextIsUnit = nextHangul && /^(년|월|일|조|항|호|개|명|차|시|분|가지|번째|세기|개국|만)(의|에|은|는|이|가|을|를|로|과|와)?[,.]?$/.test(toks[i + 1]);
        if (isWmDigit && (t.includes(":") || ((prevHangul || nextHangul) && !nextIsUnit))) {
          removed.push({ from: t, why: "워터마크 숫자 조각(문장 사이에 홀로 끼어듦)" });
          continue;
        }
        keep.push(t);
      }
      text = keep.join(" ");
    }
    text = text.replace(/\s{2,}/g, " ").trim();
    return { text, removed };
  }

  // ------------------------------------------------------------------
  // 쪽 번호 / 잡음 / 글머리 기호
  // ------------------------------------------------------------------
  const PAGE_NO_RE = /^\s*(?:[가-힣A-Za-z][가-힣A-Za-z ]{0,14})?\s*[-–—~·]?\s*\(?\d{1,3}\)?\s*[-–—~]?\s*$/;

  function isPageNumber(line) {
    const s = line.trim();
    if (!s || s.length > 20) return false;
    if (!/\d/.test(s)) return false;
    return PAGE_NO_RE.test(s);
  }

  function noiseReason(line, lexicon, kind) {
    const s = line.replace(/\s+/g, "");
    if (!s) return "빈 줄";
    const hangul = (s.match(/[가-힣]/g) || []).length;
    const jamo = (s.match(/[ㄱ-ㅎㅏ-ㅣ]/g) || []).length;
    const alnum = (s.match(/[가-힣0-9A-Za-z]/g) || []).length;
    if (!alnum) return "기호만 있는 줄";
    if (jamo >= 2 && jamo >= hangul * 0.5) return "홑자모가 많은 줄 (뒷면 비침·얼룩 의심)";
    const q = OcrConsensus.quality(line);
    if (q < (kind === "page" ? 0.25 : 0.45)) return "글자 대부분이 기호·잡음인 줄";
    if (kind !== "page" && hangul && hangul <= 2 && s.length <= 4 && !/^\d/.test(s)) {
      // 아주 짧은 줄: 문서 다른 곳에 같은 낱말이 있으면 살린다
      const stem = TA().stripParticle(line.trim());
      if (!lexicon || !(lexicon.get(stem) >= 2)) return "아주 짧은 조각";
    }
    return null;
  }

  function normalizeBullets(line) {
    return line
      .replace(/^\s*[•●∙◦○▪■·ㆍ*]\s*/, "● ")
      .replace(/^\s*[―ㅡ–—−]\s*/, "- ")
      .replace(/^\s*-\s*/, "- ")
      .replace(/\s*[ㆍ∙]\s*/g, " · ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // ------------------------------------------------------------------
  // 용어 통일 (문서 내 빈도 기반)
  // ------------------------------------------------------------------
  const CONFUSABLE = [
    "ㄴㄹ", "ㄴㄷ", "ㄷㄹ", "ㅁㅇ", "ㅁㅂ", "ㅂㅍ", "ㅇㅎ", "ㅎㅌ", "ㄱㅋ", "ㅈㅊ", "ㅅㅈ", "ㄷㅌ", "ㄹㅌ", "ㄱㄲ", "ㄴㅇ",
    "ㄱㄷ", "ㅓㅕ", "ㅡㅜ", "ㅡㅗ", "ㅐㅔ", "ㅔㅖ", "ㅚㅟ", "ㅢㅡ",
  ];
  const CONF_SET = new Set(CONFUSABLE.flatMap((p) => [p, p[1] + p[0]]));

  /** 글자 수가 같은 두 낱말의 다른 자모가 전부 OCR이 헷갈리는 쌍인지. 다른 자모 수를 돌려준다(아니면 -1). */
  function confusableDiff(a, b) {
    if (a.length !== b.length) return -1;
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      const ja = TA().toJamo(a[i]);
      const jb = TA().toJamo(b[i]);
      if (!/[가-힣]/.test(a[i]) || !/[가-힣]/.test(b[i])) return -1;
      const L = Math.max(ja.length, jb.length);
      for (let k = 0; k < L; k++) {
        const x = ja[k] || "";
        const y = jb[k] || "";
        if (x === y) continue;
        // 받침이 생기거나 없어진 경우(예: 국 ↔ 구)는 OCR이 받침을 놓친 것으로 볼 수 있지만 위험하므로 제외
        if (!x || !y) return -1;
        if (!CONF_SET.has(x + y)) return -1;
        diffs++;
      }
    }
    return diffs;
  }

  function wordStats(texts) {
    const freq = new Map();
    for (const t of texts) {
      for (const tok of String(t).split(/\s+/)) {
        const w = tok.replace(/^[^가-힣0-9A-Za-z]+|[^가-힣0-9A-Za-z]+$/g, "");
        if (!w || !/[가-힣]/.test(w)) continue;
        const stem = TA().stripParticle(w);
        if (stem.length >= 2) freq.set(stem, (freq.get(stem) || 0) + 1);
        // 조사를 떼지 않은 앞부분(합성어 앞)도 후보로: "대한민국의" "대한민국헌법"
        if (w !== stem && w.length >= 2) freq.set(w, freq.get(w) || 0);
      }
    }
    return freq;
  }

  /** 마지막 글자의 받침만 ㄴ/ㄹ/ㅁ/ㅆ/없음 사이로 다른 경우: 활용형(지킨/지킬, 한/할)이므로 오인식으로 보지 않는다. */
  function isConjugationPair(a, b) {
    if (a.slice(0, -1) !== b.slice(0, -1)) return false;
    const ja = TA().toJamo(a.slice(-1));
    const jb = TA().toJamo(b.slice(-1));
    if (ja.slice(0, 2) !== jb.slice(0, 2)) return false;
    const fa = ja.slice(2);
    const fb = jb.slice(2);
    const soft = ["", "ㄴ", "ㄹ", "ㅁ", "ㅆ", "ㅂ"];
    return soft.includes(fa) && soft.includes(fb);
  }

  /**
   * 문서 전체 빈도로 드물게 나온 오인식 낱말 → 다수 표기 치환표를 만든다.
   * 진짜 다른 낱말(자산/자신, 조성/조선, 전락/전략)을 잘못 바꾸지 않도록:
   *  - 다른 자모가 전부 OCR이 헷갈리는 모양이어야 하고, 활용형 차이(지킨/지킬)는 제외
   *  - 두 글자 낱말은 추가로, 틀린 쪽에만 있는 글자가 문서의 "자주 나온 낱말"에는 한 번도 안 쓰였어야 한다
   *    (국굳의 ‘굳’, 현법의 ‘현’은 오인식 조각에만 나옴 / 자산의 ‘산’은 공산·재산 등 여러 낱말에 나옴)
   * @returns {Map<string,{to:string, count:number, majority:number}>}
   */
  function buildTermMap(texts, extraTexts) {
    const freq = wordStats(texts.concat(extraTexts || []));
    const common = [...freq.entries()].filter(([w, c]) => c >= 3 && w.length >= 2);
    // 글자별로 "자주 나온 낱말(2회 이상)" 안에 쓰였는지
    // 1차 후보: 더 흔한 "헷갈리는 짝"이 있는 낱말 (이 낱말들끼리는 서로의 근거가 되지 않게 한다)
    const suspect = new Set();
    for (const [w] of freq) {
      for (const [cw] of common) {
        if (cw !== w && cw.length === w.length && confusableDiff(w, cw) >= 1 && freq.get(cw) > freq.get(w)) {
          suspect.add(w);
          break;
        }
      }
    }
    const sylWords = new Map(); // 글자 → 그 글자를 쓴 "2회 이상 나온 (의심 없는) 낱말" 목록
    for (const [w, c] of freq) {
      if (c < 2 || suspect.has(w)) continue;
      for (const ch of new Set(w)) {
        if (!sylWords.has(ch)) sylWords.set(ch, []);
        sylWords.get(ch).push(w);
      }
    }
    const map = new Map();
    for (const [w, c] of freq) {
      if (c < 1 || w.length < 2) continue;
      let best = null;
      for (const [cw, cc] of common) {
        const need = w.length >= 4 ? Math.max(2, c * 2) : w.length === 3 ? Math.max(3, c * 2) : Math.max(3, c * 4);
        if (cw === w || cw.length !== w.length || cc < need) continue;
        const d = confusableDiff(w, cw);
        if (d < 1) continue;
        const allowed = w.length <= 2 ? 1 : Math.max(1, Math.floor(TA().toJamo(w).length / 5));
        if (d > allowed) continue;
        if (isConjugationPair(w, cw)) continue;
        if (w.length <= 2) {
          const diffSyl = [...w].filter((ch, i) => ch !== cw[i]);
          if (diffSyl.some((ch) => (sylWords.get(ch) || []).some((x) => x !== w))) continue;
        }
        if (!best || cc > best.majority || (cc === best.majority && d < best.d)) best = { to: cw, count: c, majority: cc, d };
      }
      if (best) map.set(w, best);
    }
    return map;
  }

  function applyTermMap(line, termMap, log, where) {
    if (!termMap.size) return line;
    return line
      .split(/(\s+)/)
      .map((tok) => {
        if (/^\s+$/.test(tok) || !/[가-힣]/.test(tok)) return tok;
        const lead = tok.match(/^[^가-힣0-9A-Za-z]*/)[0];
        const trail = tok.match(/[^가-힣0-9A-Za-z]*$/)[0];
        const core = tok.slice(lead.length, tok.length - trail.length);
        const stem = TA().stripParticle(core);
        const hit = termMap.get(stem) || termMap.get(core);
        if (!hit) return tok;
        const key = termMap.get(stem) ? stem : core;
        const fixed = hit.to + core.slice(key.length);
        log.push({ ...where, type: "term", from: core, to: fixed, why: `문서 안에서 ‘${hit.to}’ ${hit.majority}회, ‘${key}’ ${hit.count}회 → 다수 표기로 통일` });
        return lead + fixed + trail;
      })
      .join("");
  }

  // ------------------------------------------------------------------
  // 영역 라벨
  // ------------------------------------------------------------------
  function labelKind(text) {
    const s = String(text || "").replace(/[^가-힣]/g, "");
    if (!s) return null;
    if (/핵심|내용/.test(s) || TA().jamoEditRatio(s, "핵심내용") <= 0.35) return "core";
    if (/신념|념화/.test(s) || TA().jamoEditRatio(s, "신념화") <= 0.4) return "belief";
    return null;
  }

  // ------------------------------------------------------------------
  // 문서 전체 정리
  // ------------------------------------------------------------------
  /**
   * @param {Array<{regions:Array<{kind,index,text,lines?}>}>} pages  쪽별 영역 OCR 결과 (합의 후)
   * @param {{extraTexts?:string[]}} [opts] 같은 단원 다른 자료의 글 (용어 빈도 보강용, 선택)
   * @returns {{ pages:Array<{regions, pageLabel}>, log:object[], watermark:object, termMap:object }}
   */
  function cleanDocument(pages, opts) {
    const log = [];
    const allTexts = pages.map((p) => p.regions.map((r) => r.text || "").join("\n"));
    const wm = learnWatermark(allTexts);
    wm.lexicon = OcrConsensus.buildLexicon(allTexts);
    wm.protectedWords = wm.words.filter((w) =>
      allTexts.some((t) => t.split(/\s+/).some((tok) => tok !== w && !tok.includes("/") && TA().stripParticle(tok) === w))
    );
    const lexicon = OcrConsensus.buildLexicon(allTexts);

    // 1차: 워터마크·쪽 번호·잡음·기호
    const stage1 = pages.map((p, pi) => {
      let pageLabel = null;
      const regions = p.regions.map((r) => {
        const lines = [];
        const srcLines = String(r.text || "").split(/\r?\n/);
        srcLines.forEach((raw, li) => {
          const where = { page: pi + 1, region: r.kind + (r.index ?? ""), line: li + 1 };
          if (!raw.trim()) return;
          const w = stripWatermark(raw, wm);
          for (const x of w.removed) log.push({ ...where, type: "watermark", from: x.from, to: "", why: x.why });
          let line = w.text;
          if (!line) return;
          const edgeRegion = r.kind === "footer" || r.kind === "page_footer";
          const isLastOfPage = r.kind === "page" && li >= srcLines.length - 2;
          if ((edgeRegion || isLastOfPage || r.kind === "header") && isPageNumber(line)) {
            pageLabel = pageLabel || line.trim();
            log.push({ ...where, type: "pageNumber", from: line.trim(), to: "", why: "쪽 번호" });
            return;
          }
          if (r.kind === "label") {
            lines.push(line);
            return;
          }
          const why = noiseReason(line, lexicon, r.kind);
          if (why) {
            log.push({ ...where, type: "noise", from: line, to: "", why });
            return;
          }
          const nb = normalizeBullets(line);
          if (nb !== line.trim() && nb.replace(/[●\-\s·]/g, "") !== line.replace(/[•●∙◦○▪■·ㆍ*―ㅡ–—−\-\s]/g, "")) {
            log.push({ ...where, type: "bullet", from: line, to: nb, why: "글머리 기호 정리" });
          }
          lines.push(nb);
        });
        return { ...r, lines };
      });
      return { regions, pageLabel };
    });

    // 2차: 용어 통일 (1차 정리된 글 전체의 빈도 기준)
    const cleanTexts = stage1.map((p) => p.regions.map((r) => r.lines.join("\n")).join("\n"));
    const termMap = buildTermMap(cleanTexts, (opts && opts.extraTexts) || []);
    const out = stage1.map((p, pi) => ({
      pageLabel: p.pageLabel,
      regions: p.regions.map((r) => ({
        ...r,
        lines: r.lines.map((l, li) => applyTermMap(l, termMap, log, { page: pi + 1, region: r.kind + (r.index ?? ""), line: li + 1 })),
      })),
    }));
    for (const p of out) for (const r of p.regions) r.text = r.lines.join("\n");
    return {
      pages: out,
      log,
      watermark: wm,
      termMap: Object.fromEntries([...termMap].map(([k, v]) => [k, v.to])),
    };
  }

  /** 레이아웃 없이 글만 있을 때(직접 입력·예전 자료): 한 덩어리 글을 같은 규칙으로 정리. */
  function cleanPlainText(text, opts) {
    const r = cleanDocument([{ regions: [{ kind: "page", text }] }], opts);
    return { text: r.pages[0].regions[0].text, log: r.log, pageLabel: r.pages[0].pageLabel, termMap: r.termMap };
  }

  return { cleanDocument, cleanPlainText, stripWatermark, learnWatermark, isPageNumber, noiseReason, normalizeBullets, buildTermMap, confusableDiff, isConjugationPair, labelKind };
})();
