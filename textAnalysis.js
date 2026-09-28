// textAnalysis.js
// AI 없이도 동작하는 한국어 텍스트 분석 도구 모음.
//  - 조사 떼기 / 핵심 낱말 후보 / 은·는 같은 조사 고르기
//  - 문장 유사도, 자모 단위 편집 거리 (OCR 보정 안전장치와 문제 중복 검사에 사용)
//  - 줄바꿈 때문에 끊긴 문장 잇기, 제목(소제목) 인식
//  - 암기 포인트 기본 분석: 중요도(1~5) · 분류 · 빈칸 문장 · 빈칸 정답
// 이 파일의 결과는 AI가 없거나 실패했을 때의 기본 분석이며, 자료 문장 밖의 내용을 만들지 않는다.
window.TextAnalysis = (function () {
  // ------------------------------------------------------------------
  // 조사 / 불용어
  // ------------------------------------------------------------------
  const PARTICLES = [
    "으로부터", "에서부터", "으로써", "으로서", "로서", "로써", "에게서", "이라고", "에서는", "에서도", "에서의",
    "으로는", "이라는", "라는", "에서", "에게", "으로", "부터", "까지", "처럼", "보다", "라고",
    "와는", "과는", "이나", "이란", "이며", "이고", "에는", "에도", "은", "는", "이", "가", "을",
    "를", "에", "의", "와", "과", "도", "만", "로", "란", "나",
  ];
  // 한 글자 명사(뇌, 뼈, 폐 …) 뒤에서도 떼어도 안전한 조사 ("마을", "사과", "도로"가 잘리지 않도록 좁게)
  const SAFE_AFTER_ONE_SYLLABLE = new Set(["를", "는", "에", "와", "에서", "에게", "으로", "에는", "에도", "에서는"]);
  const STOPWORDS = new Set([
    "그리고", "그러나", "하지만", "또한", "및", "등", "것", "수", "때", "그", "이", "저", "더", "또",
    "통해", "위해", "대한", "대해", "따라", "의해", "가장", "매우", "모든", "각", "여러", "다른",
    "이후", "이전", "때문", "경우", "중", "후", "전", "현재", "당시", "주로", "특히", "처음", "약",
    "예", "참고", "가령", "예컨대", "반드시", "기억", "중요", "핵심", "주의",
  ]);
  // 빈칸 정답으로 쓰기에는 너무 일반적인 낱말 (문제는 되지만 "암기"를 확인하지 못함)
  const GENERIC = new Set([
    "역할", "기능", "부분", "종류", "특징", "구조", "내용", "사람", "관계", "방법", "과정", "상태",
    "정도", "사용", "형태", "모양", "경우", "이유", "결과", "원인", "의미", "개념", "자료", "문장",
  ]);
  // 서술어/연결어미로 끝나는 낱말은 빈칸 후보에서 뺀다 (명사 위주로 묻기 위해)
  const VERBISH = /(다|요|함|됨|져|하고|하며|하여|되어|해서|되고|하는|되는|있는|없는|된|했던|였던|이던|면서|지만|는데|으며|어서|아서)$/;

  function stripParticle(word) {
    const clean = word.replace(/^[“"'‘(\[<《「『]+|[”"'’)\]>》」』.,!?;:·…]+$/g, "");
    for (const p of PARTICLES) {
      if (!clean.endsWith(p)) continue;
      const rest = clean.length - p.length;
      if (rest >= 2 || (rest === 1 && SAFE_AFTER_ONE_SYLLABLE.has(p) && /[가-힣]/.test(clean[0]))) {
        return clean.slice(0, -p.length);
      }
    }
    return clean;
  }

  /** 문장에서 빈칸/오답 교체에 쓸 핵심 낱말 후보 (점수 높은 순). */
  function keywordCandidates(sentence) {
    const tokens = String(sentence || "").split(/\s+/).filter(Boolean);
    const out = [];
    tokens.forEach((tok, i) => {
      const stem = stripParticle(tok);
      const bare = tok.replace(/[.,!?;:]+$/, "");
      const oneSyllableNoun = stem.length === 1 && stem !== bare && /[가-힣]/.test(stem);
      if ((stem.length < 2 && !oneSyllableNoun) || STOPWORDS.has(stem)) return;
      if (!/[가-힣a-zA-Z0-9]/.test(stem)) return;
      const isLast = i === tokens.length - 1;
      if (/[0-9]/.test(stem)) {
        out.push({ stem, score: 4, generic: false });
        return;
      }
      if (VERBISH.test(stem) || (isLast && /[가-힣]$/.test(stem) && /[.다]$/.test(tok))) return;
      let score = stem.length <= 6 ? 2 : 1;
      if (i === 0) score += 0.5;
      if (stem !== bare) score += 0.5; // 조사가 붙어 있던 명사
      const generic = GENERIC.has(stem);
      if (generic) score -= 1.5;
      out.push({ stem, score, generic });
    });
    const seen = new Set();
    return out.filter((c) => (seen.has(c.stem) ? false : seen.add(c.stem))).sort((a, b) => b.score - a.score);
  }

  // ------------------------------------------------------------------
  // 조사 고르기 (받침 유무)
  // ------------------------------------------------------------------
  function hasBatchim(word) {
    const s = String(word || "").trim();
    const ch = s.charCodeAt(s.length - 1);
    if (ch >= 0xac00 && ch <= 0xd7a3) return (ch - 0xac00) % 28 !== 0;
    if (/[0-9]$/.test(s)) return /[013678]$/.test(s); // 일·삼·육·칠·팔·영(공)
    return false;
  }
  /** josa("심장", "은/는") → "심장은" */
  function josa(word, pair) {
    const [withB, withoutB] = pair.split("/");
    return word + (hasBatchim(word) ? withB : withoutB);
  }

  // ------------------------------------------------------------------
  // 유사도
  // ------------------------------------------------------------------
  function bigrams(s) {
    const n = Utils.normalizeText(s);
    const out = new Map();
    for (let i = 0; i < n.length - 1; i++) {
      const g = n.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }
  /** 0~1 (Dice 계수). 공백·구두점 무시. */
  function similarity(a, b) {
    const A = bigrams(a);
    const B = bigrams(b);
    let inter = 0;
    let total = 0;
    for (const [g, c] of A) {
      inter += Math.min(c, B.get(g) || 0);
      total += c;
    }
    for (const c of B.values()) total += c;
    if (total === 0) return Utils.normalizeText(a) === Utils.normalizeText(b) ? 1 : 0;
    return (2 * inter) / total;
  }

  /** a의 내용이 b 안에 얼마나 들어 있는지 (0~1). "AI가 쓴 문장이 원문에 근거하는가" 검사용. */
  function containment(a, b) {
    const A = bigrams(a);
    const B = bigrams(b);
    let inter = 0;
    let total = 0;
    for (const [g, c] of A) {
      inter += Math.min(c, B.get(g) || 0);
      total += c;
    }
    if (total === 0) return Utils.normalizeText(b).includes(Utils.normalizeText(a)) ? 1 : 0;
    return inter / total;
  }

  /** needle이 haystack 안에 있거나, 자모 한두 개 차이로 들어 있는지 (OCR 교정된 용어 대응). */
  function fuzzyIncludes(needle, haystack, maxRatio) {
    const t = Utils.normalizeText(needle);
    const e = Utils.normalizeText(haystack);
    if (!t) return false;
    if (e.includes(t)) return true;
    const limit = maxRatio === undefined ? 0.34 : maxRatio;
    if (t.length > 40) return false;
    for (let len = Math.max(1, t.length - 1); len <= t.length + 1; len++) {
      for (let i = 0; i + len <= e.length; i++) {
        if (jamoEditRatio(t, e.slice(i, i + len)) <= limit) return true;
      }
    }
    return false;
  }

  const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
  const JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";
  /** "수도" → "ㅅㅜㄷㅗ". OCR 오인식은 대개 자모 한두 개 차이라서 자모 단위로 비교한다. */
  function toJamo(s) {
    let out = "";
    for (const ch of Utils.normalizeText(s)) {
      const c = ch.charCodeAt(0);
      if (c >= 0xac00 && c <= 0xd7a3) {
        const idx = c - 0xac00;
        out += CHO[Math.floor(idx / 588)] + JUNG[Math.floor((idx % 588) / 28)];
        const jong = JONG[idx % 28];
        if (jong !== " ") out += jong;
      } else out += ch;
    }
    return out;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** 자모 편집 거리 비율 (0 = 같음). */
  function jamoEditRatio(a, b) {
    const ja = toJamo(a);
    const jb = toJamo(b);
    const max = Math.max(ja.length, jb.length);
    return max ? levenshtein(ja, jb) / max : 0;
  }

  // ------------------------------------------------------------------
  // 문장 나누기 (줄바꿈으로 끊긴 문장 잇기, 제목 인식)
  // ------------------------------------------------------------------
  function cleanLine(line) {
    return line
      .replace(/^\s*([-*•·▪︎◦○●■□▶▷→]+|\d+[.)]|[①-⑳]|[가-하][.)])\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function endsSentence(line) {
    return /[.!?。]$|[다요음함임됨][.)]?$|\)$/.test(line);
  }

  /** 줄 끝이 조사/연결어미/쉼표면 다음 줄과 이어지는 문장으로 본다 (교재 줄바꿈·페이지 넘김 대응). */
  function continuesNextLine(line) {
    return /(은|는|이|가|을|를|에|의|와|과|고|며|서|로|으로|에서|하여|되어|,|·|및)$/.test(line) || (line.length >= 28 && !endsSentence(line));
  }

  /** 제목/소제목으로 보이는 줄: 짧고, 문장처럼 끝나지 않음. */
  function isHeading(rawLine) {
    const line = rawLine.trim();
    if (!line || line.length > 24) return false;
    if (/^[-*•·▪︎◦○●→]/.test(line)) return false; // 글머리 기호 줄은 목록 항목
    if (endsSentence(line) || continuesNextLine(line)) return false;
    return /^(\d+[.)]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|[①-⑳]|■|□|▶|제\s*\d+\s*[장절과단원])/.test(line) || !/\s.*\s.*\s/.test(line);
  }

  const BULLET_RE = /^\s*([-*•·▪︎◦○●■□▶▷→]|\d+[.)]|[①-⑳]|[가-하][.)])/;

  /**
   * [{ sentence, heading }] — 문장과 그 문장이 속한 소제목.
   * 교재 줄바꿈·페이지 넘김으로 끊긴 문장은 다시 잇는다:
   *   마침표 없이 끝난 줄(3낱말 이상)은 다음 줄과 이어진 문장으로 보되, 다음 줄이 목록 기호나 제목이면 끊는다.
   */
  function splitSentencesWithHeadings(text) {
    const out = [];
    let heading = "";
    let buffer = "";
    const flush = () => {
      if (!buffer) return;
      for (const p of buffer.split(/(?<=[.!?。])\s+/)) {
        const s = p.trim();
        if (s) out.push({ sentence: s, heading });
      }
      buffer = "";
    };
    const lines = String(text || "").split(/\r?\n/);
    const nextNonEmpty = (i) => {
      for (let k = i + 1; k < lines.length; k++) if (lines[k].trim()) return lines[k];
      return null;
    };
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      if (!rawLine.trim()) continue;
      if (!buffer && isHeading(rawLine)) {
        heading = cleanLine(rawLine);
        continue;
      }
      if (buffer && BULLET_RE.test(rawLine)) flush();
      const line = cleanLine(rawLine);
      if (!line) continue;
      buffer = buffer ? `${buffer} ${line}` : line;
      const next = nextNonEmpty(i);
      const nextBreaks = !next || BULLET_RE.test(next) || isHeading(next);
      const words = line.split(/\s+/).length;
      if (endsSentence(buffer) || nextBreaks || (!continuesNextLine(buffer) && words < 3)) flush();
    }
    flush();
    return out;
  }

  function isMeaningful(sentence) {
    const norm = Utils.normalizeText(sentence);
    if (norm.length < 5) return false;
    if (/^[0-9]+$/.test(norm)) return false;
    return /[가-힣a-z]/i.test(norm);
  }

  // ------------------------------------------------------------------
  // 분류 · 중요도 (기본 분석)
  // ------------------------------------------------------------------
  const CATEGORY_RULES = [
    ["정의", /(이?란\s|이라고 한다|라고 한다|[을를] 말한다|의미한다|뜻한다|일컫는다|정의)/],
    ["원인·결과", /(때문|원인|결과|따라서|그 결과|으로 인해|로 인해|초래|야기|영향)/],
    ["기능·역할", /(기능|역할|담당|작용|보호|조절|분비|생성|운반|순환|지지|저장)/],
    ["숫자·날짜", /[0-9]/],
    ["비교", /(비해|보다|반면|차이|와 달리|과 달리|공통점|차이점)/],
    ["순서", /(먼저|다음으로|마지막|순서|단계|이후|뒤이어)/],
    ["구조·위치", /(위치|사이|구성|이루어|포함|속한|안쪽|바깥|위쪽|아래)/],
  ];

  function categoryOf(sentence) {
    for (const [name, re] of CATEGORY_RULES) if (re.test(sentence)) return name;
    return "특징";
  }

  const IMPORTANCE_LABELS = { 5: "핵심", 4: "중요", 3: "일반", 2: "보조", 1: "세부" };

  /**
   * 기본 중요도 (1~5). 자료 안의 신호만 쓴다:
   * 정의/수치·날짜/원인·결과/강조 표현/소제목과의 연결/여러 문장에서 반복되는 용어 → 가산,
   * 예시·참고·나열 → 감산.
   */
  function importanceLocal(sentence, ctx) {
    let score = 3;
    if (CATEGORY_RULES[0][1].test(sentence)) score += 1;
    if (/[0-9]/.test(sentence)) score += 1;
    if (CATEGORY_RULES[1][1].test(sentence)) score += 1;
    if (CATEGORY_RULES[2][1].test(sentence)) score += 0.5;
    if (/(중요|반드시|핵심|주의|★|※|꼭 |필수)/.test(sentence)) score += 1.5; // 자료가 직접 강조한 내용
    if (ctx) {
      if (ctx.heading) {
        const hk = keywordCandidates(ctx.heading).map((c) => c.stem);
        if (hk.some((k) => sentence.includes(k))) score += 0.5;
      }
      if (ctx.firstUnderHeading) score += 0.5;
      if (ctx.repeatCount >= 2) score += 0.5;
    }
    if (/(예를 들어|예컨대|예:|예\)|참고|가령|기타|등이 있다|따위)/.test(sentence)) score -= 2;
    if (Utils.normalizeText(sentence).length < 10) score -= 1;
    return Utils.clamp(Math.round(score), 1, 5);
  }

  // ------------------------------------------------------------------
  // 빈칸
  // ------------------------------------------------------------------
  const BLANK = "[      ]";
  const BLANK_RE = /\[\s*\]|\(\s{2,}\)|_{2,}|\[\s*_+\s*\]/;

  /** 빈칸 정답으로 적절한 짧은 핵심어인지 (문장 전체·조사·일반어 금지). */
  function isGoodBlankAnswer(answer, sentence) {
    const a = Utils.normalizeText(answer);
    const s = Utils.normalizeText(sentence);
    if (!a || a.length > 24) return false;
    if (String(answer).trim().split(/\s+/).length > 6) return false;
    if (s && a.length > s.length * 0.6) return false;
    if (STOPWORDS.has(answer.trim()) || GENERIC.has(answer.trim())) return false;
    if (PARTICLES.includes(answer.trim())) return false;
    return true;
  }

  function makeBlank(sentence, answer) {
    const idx = sentence.indexOf(answer);
    if (idx < 0) return null;
    return sentence.slice(0, idx) + BLANK + sentence.slice(idx + answer.length);
  }

  /** 문장에서 가장 암기 가치가 큰 낱말을 골라 빈칸을 만든다. */
  function chooseBlank(sentence) {
    const cands = keywordCandidates(sentence).filter((c) => !c.generic && isGoodBlankAnswer(c.stem, sentence));
    for (const c of cands) {
      const blankText = makeBlank(sentence, c.stem);
      if (blankText) return { answer: c.stem, blankText };
    }
    return null;
  }

  /** "심장은 혈액을 …한다." → { subject: "심장", predicate: "혈액을 …한다." } */
  function splitTopic(sentence) {
    const tokens = sentence.split(/\s+/);
    for (let i = 0; i < Math.min(3, tokens.length - 1); i++) {
      const m = tokens[i].match(/^(.+?)(이란|란|은|는)$/);
      if (m && m[1].length >= 1 && !STOPWORDS.has(m[1])) {
        const subject = tokens.slice(0, i).concat(m[1]).join(" ");
        const predicate = tokens.slice(i + 1).join(" ");
        if (Utils.normalizeText(predicate).length >= 4) return { subject, predicate, marker: m[2] };
      }
    }
    return null;
  }

  /** 포인트 하나를 기본 분석 (빈칸 + 중요도 + 분류 + 해설). */
  function enrichPoint(p, ctx) {
    const text = p.text;
    const blank = chooseBlank(text);
    return {
      importance: importanceLocal(text, ctx),
      category: categoryOf(text),
      questionTarget: blank ? blank.answer : (splitTopic(text) || {}).subject || null,
      blankText: blank ? blank.blankText : null,
      answer: blank ? blank.answer : null,
      explanation: blank ? `자료: “${p.sourceExcerpt || text}” → 핵심어는 ‘${blank.answer}’입니다.` : `자료: “${p.sourceExcerpt || text}”`,
    };
  }

  function stripEmphasis(sentence) {
    const out = sentence
      .replace(/^\s*[★☆※*!]+\s*/, "")
      .replace(/^((반드시|꼭)\s*(기억|암기|알\s*것)|중요|핵심|주의)\s*[:：!]\s*/, "")
      .trim();
    return out.length >= 5 ? out : sentence;
  }

  /** 자료 전체를 기본 분석해서 암기 포인트 목록을 만든다. */
  function analyzePointsLocal(text) {
    const rows = splitSentencesWithHeadings(text).filter((r) => isMeaningful(r.sentence));
    const seen = new Set();
    const uniq = [];
    for (const r of rows) {
      const key = Utils.normalizeText(r.sentence);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(r);
    }
    // 반복 강조: 한 문장의 핵심어가 다른 문장에도 여러 번 나오는지
    const kwOf = uniq.map((r) => (keywordCandidates(r.sentence).find((c) => !c.generic) || {}).stem || "");
    let lastHeading = null;
    return uniq.map((r, i) => {
      const kw = kwOf[i];
      const repeatCount = kw ? uniq.filter((o, j) => j !== i && o.sentence.includes(kw)).length : 0;
      const firstUnderHeading = !!r.heading && r.heading !== lastHeading;
      lastHeading = r.heading;
      // 문장 앞 강조 표시("★ 반드시 기억:")는 중요도에만 반영하고 문제 문장에서는 뺀다 (근거 원문은 그대로 보존)
      const point = { text: stripEmphasis(r.sentence), sourceExcerpt: r.sentence, heading: r.heading || null };
      const analysis = enrichPoint(point, { heading: r.heading, firstUnderHeading, repeatCount });
      analysis.importance = importanceLocal(r.sentence, { heading: r.heading, firstUnderHeading, repeatCount }); // 강조 표시 포함 원문으로 판단
      return { ...point, ...analysis };
    });
  }

  return {
    PARTICLES,
    STOPWORDS,
    GENERIC,
    BLANK,
    BLANK_RE,
    IMPORTANCE_LABELS,
    stripParticle,
    keywordCandidates,
    hasBatchim,
    josa,
    similarity,
    containment,
    fuzzyIncludes,
    toJamo,
    levenshtein,
    jamoEditRatio,
    splitSentencesWithHeadings,
    isHeading,
    isMeaningful,
    categoryOf,
    importanceLocal,
    isGoodBlankAnswer,
    makeBlank,
    chooseBlank,
    splitTopic,
    enrichPoint,
    analyzePointsLocal,
  };
})();
