// ai.js
// AI 호출 전담 모듈. 다른 파일은 AI를 직접 부르지 않고 반드시 이 모듈을 거친다.
//
// ■ 보안
//   이 파일(프론트엔드)에는 API 키가 없다. config.js의 AI_API_URL(내 백엔드/서버리스
//   함수 주소)로 요청을 보내고, 그 백엔드가 서버 쪽 환경변수에 있는 키로 Claude 등을
//   호출한다. 예시 백엔드: ai-proxy-worker.example.js
//
// ■ 백엔드와 약속한 요청/응답 형식
//   요청 (POST, JSON):
//     { "version": 1, "task": "correctOcr" | "extractPoints" | "extractWordItems" | "generateQuestions" | "summarize",
//       "instructions": "<모델에게 줄 지시문>", "input": { ...작업별 입력... } }
//   응답 (JSON):
//     { "ok": true, "result": <JSON 객체 또는 JSON 문자열> }   실패 시 { "ok": false, "error": "..." }
//
// ■ 자료 기반 원칙 (코드로 강제)
//   - 모든 결과의 sourceExcerpt가 실제 자료 원문 안에 존재하는지 검사한다 (공백·구두점 무시).
//   - AI가 쓴 문장(포인트·요약·단어 뜻)은 근거 원문과 내용이 겹치는지(bigram 포함률) 검사한다.
//     겹치지 않으면 "자료에 없는 내용"으로 보고 버린다.
//   - OCR 보정 제안은 ocrCorrection.js가 한 건씩 검사한 뒤에만 적용한다.
window.Ai = (function () {
  const TIMEOUT_MS = 120000;
  const MAX_CHARS_PER_CALL = 12000;
  const TA = () => TextAnalysis;

  const COMMON_RULES = [
    "너는 사용자가 제공한 학습 자료만으로 암기 학습 데이터를 만드는 도우미다.",
    "절대 규칙:",
    "1) 제공된 자료에 없는 사실·숫자·이름·설명을 추가하지 마라. 네 배경지식으로 보충하지 마라. (교정은 가능, 지식 추가는 금지)",
    "2) 모든 항목의 sourceExcerpt에는 자료 원문에서 그대로 복사한 연속된 구절(한 문장 이내)을 넣어라. 바꿔 쓰지 마라.",
    "3) 자료가 불분명하면 추측하지 말고 그 부분은 건너뛰어라.",
    "4) 응답은 설명 없이 JSON만 출력하라. 마크다운 코드블록을 쓰지 마라.",
  ].join("\n");

  const IMPORTANCE_GUIDE = [
    "importance(중요도) 기준 — 반드시 이 자료 안의 근거로만 판단:",
    " 5 = 반드시 알아야 하는 핵심 (핵심 개념·정의·원리, 제목/소제목과 직결, 자료가 반복·강조한 내용, 표의 핵심 항목)",
    " 4 = 중요 (원인·결과, 기능·구조, 중요한 숫자·날짜, 인물과 업적, 용어와 의미, 비교·순서)",
    " 3 = 일반 (핵심을 보충하는 특징)",
    " 2 = 보조 (예시, 부연 설명)",
    " 1 = 세부 (참고 사항, 시험에 나올 가능성이 낮은 사소한 내용)",
  ].join("\n");

  function isConfigured() {
    return Config.isAiConfigured();
  }

  function statusText() {
    return isConfigured() ? "AI 연결됨" : "AI 연결 필요";
  }

  // ------------------------------------------------------------------
  // 공통 요청
  // ------------------------------------------------------------------
  function parseJsonLoose(value) {
    if (value && typeof value === "object") return value;
    let text = String(value || "").trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try {
      return JSON.parse(text);
    } catch (e) {
      const start = text.search(/[\[{]/);
      const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
      if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
      throw new Error("AI 응답을 JSON으로 해석할 수 없습니다.");
    }
  }

  async function request(task, instructions, input, images) {
    if (!isConfigured()) throw new Error("AI 연결 필요: 설정에서 AI 서버 주소를 입력하세요.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(Config.getAiUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // images: [{ mediaType, data(base64) }] — 백엔드가 모델에 이미지 블록으로 넘긴다 (v4, 없으면 생략)
        body: JSON.stringify(images && images.length ? { version: 2, task, instructions, input, images } : { version: 1, task, instructions, input }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`AI 서버 오류 (${res.status})`);
      const body = await res.json();
      if (body && body.ok === false) throw new Error(body.error || "AI 서버가 오류를 반환했습니다.");
      const result = body && Object.prototype.hasOwnProperty.call(body, "result") ? body.result : body;
      return parseJsonLoose(result);
    } catch (err) {
      if (err.name === "AbortError") throw new Error("AI 응답 시간이 초과되었습니다.");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------
  // 검증 도구
  // ------------------------------------------------------------------
  /** sourceExcerpt가 자료 원문 안에 실제로 있는지 (공백·구두점 무시). */
  function validateExcerpt(excerpt, context) {
    const e = Utils.normalizeText(excerpt);
    if (e.length < 3) return false;
    return Utils.normalizeText(context).includes(e);
  }

  /** AI가 쓴 문장이 근거 원문에 기대고 있는지 (새 정보를 덧붙이지 않았는지). */
  function isGrounded(text, excerpt, context, min) {
    const threshold = min || 0.6;
    return TA().containment(text, excerpt) >= threshold || TA().containment(text, context) >= Math.min(0.85, threshold + 0.2);
  }

  function normalizeOX(v) {
    const s = String(v || "").trim().toUpperCase();
    if (["O", "○", "TRUE", "참", "맞음", "예"].includes(s)) return "O";
    if (["X", "×", "FALSE", "거짓", "틀림", "아니오"].includes(s)) return "X";
    return null;
  }

  /** AI가 만든 문제 1개의 "형식"을 검사하고 앱 형식으로 정리한다. 내용 품질은 questionQuality.js가 본다. */
  function validateQuestion(raw, expectedType, context) {
    if (!raw || typeof raw !== "object") return null;
    const question = String(raw.question || "").trim();
    const answer = raw.answer;
    const explanation = String(raw.explanation || "").trim();
    const sourceExcerpt = String(raw.sourceExcerpt || "").trim();
    if (!question || answer === undefined || answer === null || String(answer).trim() === "") return null;
    if (!validateExcerpt(sourceExcerpt, context)) return null;

    const T = Quiz.TYPES;
    const q = { type: expectedType, question, answer: String(answer).trim(), explanation, sourceExcerpt, options: null };
    if (expectedType === T.OX) {
      const ox = normalizeOX(answer);
      if (!ox) return null;
      q.answer = ox;
      q.options = ["O", "X"];
    } else if (expectedType === T.MC) {
      const opts = Array.isArray(raw.options) ? raw.options.map((o) => String(o).trim()).filter(Boolean) : [];
      const uniq = [];
      for (const o of opts) if (!uniq.some((u) => Utils.normalizeText(u) === Utils.normalizeText(o))) uniq.push(o);
      const ans = uniq.find((o) => Utils.normalizeText(o) === Utils.normalizeText(q.answer));
      if (!ans || uniq.length < 2 || uniq.length > 6) return null;
      q.answer = ans;
      q.options = uniq;
    } else if (expectedType === T.FILL) {
      q.question = q.question.replace(TA().BLANK_RE, TA().BLANK);
    }
    if (Array.isArray(raw.acceptableAnswers)) {
      q.acceptableAnswers = raw.acceptableAnswers.map((a) => String(a).trim()).filter(Boolean);
    }
    return q;
  }

  function chunkText(text) {
    if (text.length <= MAX_CHARS_PER_CALL) return [text];
    const chunks = [];
    let current = "";
    for (const para of text.split(/\n\s*\n|\n/)) {
      if ((current + "\n" + para).length > MAX_CHARS_PER_CALL && current) {
        chunks.push(current);
        current = para;
      } else {
        current = current ? current + "\n" + para : para;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // ------------------------------------------------------------------
  // 작업 0: OCR 문맥 보정 (제안만 받음 → ocrCorrection.js가 검사 후 적용)
  // pages: [{ page, text }]  — 한 자료의 여러 장을 한 번에 (페이지가 이어지는 문맥 유지)
  // ------------------------------------------------------------------
  async function correctOcr({ pages }) {
    const instructions = [
      COMMON_RULES,
      "",
      "작업: 아래는 교재/프린트 사진을 OCR로 읽은 글이다. pages는 순서대로 이어지는 페이지다(앞 페이지 끝 문장이 다음 페이지로 이어질 수 있다).",
      "문맥을 보고 OCR 오류만 고쳐라. 고칠 대상:",
      " - 한글 자모 오인식(데한민국→대한민국, 수토→수도, 심쟝→심장), 비슷하게 생긴 글자, 숫자 오인식(l392→1392)",
      " - 조사 오류, 띄어쓰기 오류, 붙어버린 단어, 줄바꿈 때문에 끊긴 문장, 문장 연결 오류",
      "금지: 원문에 없는 단어·사실·숫자·설명 추가, 문장 다시 쓰기, 요약, 내용 삭제.",
      "출력: 바꿔야 하는 부분만 목록으로. raw에는 OCR 원문을 한 글자도 바꾸지 말고 그대로 복사(바뀌는 낱말과 앞뒤 한두 낱말 정도의 짧은 구간).",
      "confidence: 문맥상 명확하면 \"high\", 여러 가지로 읽힐 수 있거나 확신하지 못하면 \"low\" (low는 앱이 자동 수정하지 않고 사용자에게 확인을 요청한다).",
      '출력 형식: {"changes":[{"page":1,"raw":"OCR 원문 그대로","corrected":"고친 글","confidence":"high","reason":"짧은 이유"}]}',
      "고칠 것이 없으면 {\"changes\":[]}.",
    ].join("\n");
    const result = await request("correctOcr", instructions, { pages });
    const list = Array.isArray(result) ? result : result.changes || [];
    return list
      .filter((c) => c && typeof c.raw === "string" && typeof c.corrected === "string")
      .map((c) => ({
        page: Number(c.page) || 1,
        raw: c.raw,
        corrected: c.corrected,
        confidence: c.confidence === "low" ? "low" : "high",
        reason: String(c.reason || "").slice(0, 80),
      }));
  }

  // ------------------------------------------------------------------
  // 작업 1: 암기 포인트 + 중요도 + 빈칸 추출 (자료 전체를 빠짐없이)
  // ------------------------------------------------------------------
  function normalizeAiPoint(p, chunk) {
    const text = String((p && p.text) || "").trim();
    const ex = String((p && p.sourceExcerpt) || "").trim();
    if (!text || !validateExcerpt(ex, chunk)) return null;
    if (!isGrounded(text, ex, chunk, 0.5)) return null; // 자료에 없는 내용이 덧붙은 포인트

    const importance = Utils.clamp(Math.round(Number(p.importance) || 3), 1, 5);
    const category = String(p.category || "").trim() || TA().categoryOf(text);

    // 빈칸: 정답은 짧은 핵심어/구절이어야 하고, 자료 근거 안에 있어야 한다.
    let answer = String(p.answer || "").trim();
    let blankText = String(p.blankText || "").replace(TA().BLANK_RE, TA().BLANK).trim();
    const blankOk =
      answer &&
      blankText.includes(TA().BLANK) &&
      TA().isGoodBlankAnswer(answer, text) &&
      Utils.normalizeText(ex + text).includes(Utils.normalizeText(answer)) &&
      TA().similarity(blankText.replace(TA().BLANK, answer), text) >= 0.6;
    if (!blankOk) {
      const local = TA().chooseBlank(text);
      answer = local ? local.answer : null;
      blankText = local ? local.blankText : null;
    }
    let explanation = String(p.explanation || "").trim();
    if (!explanation || !isGrounded(explanation, ex, chunk, 0.4)) explanation = `자료: “${ex}”`;
    return {
      text,
      sourceExcerpt: ex,
      importance,
      category,
      questionTarget: String(p.questionTarget || answer || "").trim() || null,
      blankText,
      answer,
      explanation,
    };
  }

  async function extractPoints({ title, text }) {
    const instructions = [
      COMMON_RULES,
      "",
      "작업: 자료 전체를 처음부터 끝까지 읽고, 시험에 나올 수 있는 '암기 포인트'를 빠짐없이 뽑아라.",
      "- 암기 포인트 하나 = 외워야 할 사실/개념/정의/원리/원인/결과/특징/기능/구조/비교/순서/수치/날짜/인물·업적/용어와 의미 하나.",
      "- 앞부분만 보지 말고 모든 문단을 다뤄라. 같은 내용을 두 번 뽑지 마라.",
      "- text: 그 포인트를 한 문장으로 정리 (자료의 표현을 최대한 유지, 새 정보 금지).",
      IMPORTANCE_GUIDE,
      "- category: 정의 / 원리 / 원인·결과 / 특징 / 기능·역할 / 구조·위치 / 비교 / 순서 / 숫자·날짜 / 인물·사건 / 용어 중 하나.",
      "- questionTarget: 이 포인트에서 외워야 할 핵심(용어·숫자·인물·기능 등).",
      "- blankText: text에서 핵심어 부분만 [      ] 로 바꾼 문장. 조사·연결어·'역할/기능' 같은 일반어를 빈칸으로 만들지 마라.",
      "- answer: 빈칸에 들어갈 실제 정답 단어 또는 짧은 핵심 구절만 (문장 전체 금지). 예) blankText \"대한민국의 수도는 [      ]이다.\" → answer \"서울\"",
      "- explanation: 자료 내용으로 1문장.",
      '출력 형식: {"points":[{"text":"...","sourceExcerpt":"자료 원문 그대로","importance":5,"category":"정의","questionTarget":"...","blankText":"...[      ]...","answer":"...","explanation":"..."}]}',
    ].join("\n");
    const out = [];
    const seen = new Set();
    for (const chunk of chunkText(text)) {
      const result = await request("extractPoints", instructions, { title, material: chunk });
      const list = Array.isArray(result) ? result : result.points || [];
      for (const raw of list) {
        const p = normalizeAiPoint(raw, chunk);
        if (!p) continue;
        const key = Utils.normalizeText(p.text);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 작업 2: 단어 암기 항목 정리 (OCR 오타는 문맥으로 바로잡되 뜻은 자료 그대로)
  // ------------------------------------------------------------------
  /** 용어가 근거 원문에 그대로 있거나, 자모 한두 개 차이(OCR 교정)인지 */
  function termSupported(term, excerpt) {
    const t = Utils.normalizeText(term);
    const e = Utils.normalizeText(excerpt);
    if (!t) return false;
    if (e.includes(t)) return true;
    for (let len = Math.max(1, t.length - 1); len <= t.length + 1; len++) {
      for (let i = 0; i + len <= e.length; i++) {
        if (TA().jamoEditRatio(t, e.slice(i, i + len)) <= 0.34) return true;
      }
    }
    return false;
  }

  async function extractWordItems(text) {
    const instructions = [
      COMMON_RULES,
      "",
      "작업: 자료에서 '용어(단어)'와 그 '뜻/설명' 쌍을 모두 찾아 암기 카드로 정리하라.",
      "- 자료가 OCR로 읽힌 것이라 오타가 있을 수 있다. 문맥상 명확한 OCR 오류(예: 심쟝→심장)는 바로잡아라.",
      "- definition은 자료에 적힌 설명만 사용하라. 자료에 뜻이 없는 용어는 제외하라. 뜻을 새로 지어내지 마라.",
      "- importance: 이 자료 안에서의 중요도 1~5.",
      '출력 형식: {"items":[{"term":"...","definition":"...","sourceExcerpt":"자료 원문 그대로","importance":3}]}',
    ].join("\n");
    const out = [];
    const seen = new Set();
    for (const chunk of chunkText(text)) {
      const result = await request("extractWordItems", instructions, { material: chunk });
      const list = Array.isArray(result) ? result : result.items || [];
      for (const it of list) {
        const term = String((it && it.term) || "").trim();
        const definition = String((it && it.definition) || "").trim();
        const ex = String((it && it.sourceExcerpt) || "").trim();
        if (!term || !definition || !validateExcerpt(ex, chunk)) continue;
        if (!termSupported(term, ex)) continue; // 근거에 없는 용어
        if (TA().containment(definition, ex) < 0.6) continue; // 자료에 없는 뜻이 섞임
        const key = Utils.normalizeText(term);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ term, definition, sourceExcerpt: ex, importance: Utils.clamp(Math.round(Number(it.importance) || 3), 1, 5) });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 작업 3: 시험 문제 생성
  // requests: [{ requestId, type, difficulty, importance, pointText, sourceExcerpt, questionTarget, answerHint,
  //              avoidQuestions?, feedback? }]
  // 반환: Map(requestId → 형식 검증 통과한 문제). 내용 검증은 quizGenerator가 questionQuality로 한다.
  // ------------------------------------------------------------------
  async function generateQuestions({ context, requests }) {
    const T = Quiz.TYPES;
    const instructions = [
      COMMON_RULES,
      "",
      "작업: requests 배열의 각 요청마다 정확히 1문제를 만들어라. 요청의 pointText 내용(특히 questionTarget)을 실제로 외웠는지 확인하는 문제여야 한다.",
      "좋은 문제: 핵심 개념·정의·원인과 결과·특징·기능·구조·순서·비교·용어와 설명 연결·중요한 숫자/날짜·인물/사건·핵심 관계를 묻는다.",
      "  예) 자료 \"심장은 혈액을 전신으로 순환시키는 펌프 역할을 한다.\" → \"심장의 주요 기능은 무엇인가?\", \"심장은 혈액을 어디로 순환시키는가?\"",
      "금지(나쁜 문제): \"다음 내용에 대해 올바른 것은?\"처럼 범위가 막연한 질문, 특정 단어가 들어간 문장 찾기, 몇 번째 단어/몇 번 나오는지,",
      "  문장을 그대로 베껴 쓰게 하는 질문, 질문 안에 정답이 그대로 드러나는 질문, 정답이 여러 개일 수 있는 질문.",
      "- 같은 내용이라도 요청마다 다른 표현·다른 관점으로 물어라. avoidQuestions에 있는 질문과 비슷하게 만들지 마라.",
      "- pageQuestion이 있으면 교재 상단의 평가 질문이다. questionLinked가 true인 요청은 그 질문의 답을 구성하는 내용(예: \"3가지 의미\" 중 하나)을 묻도록 만들어라.",
      "- area가 \"belief\"(신념화)인 요청은 마음가짐 항목이다. 사실 암기보다 항목 내용을 떠올리는지 확인하는 문제로 만들어라.",
      "- feedback이 있으면 이전 문제가 그 이유로 폐기된 것이다. 그 문제점을 고쳐서 다시 만들어라.",
      `- type별 형식: ${T.OX}=참/거짓 판단(answer "O" 또는 "X"; 틀린 진술은 자료 속 다른 용어·수치로 헷갈리게 바꿔라),`,
      `  ${T.MC}=보기 4개(options, answer는 options 중 하나와 정확히 같게, 오답 보기도 같은 자료 속 용어로, 정답은 하나뿐),`,
      `  ${T.SUBJECTIVE}=서술형 주관식, ${T.FILL}=문장 속 [      ] 빈칸 채우기(answer는 핵심어만), ${T.SHORT}=한두 단어 단답형, ${T.DESC}=개념 설명형.`,
      "- explanation: 왜 그것이 정답인지 자료 내용으로 1~2문장.",
      "- sourceExcerpt: 이 문제의 근거가 되는 자료 원문 구절(그대로 복사).",
      "- 단답형/빈칸은 채점을 위해 acceptableAnswers(허용 가능한 다른 표기) 배열을 넣어도 된다.",
      '출력 형식: {"questions":[{"requestId":"...","question":"...","options":[...]|null,"answer":"...","acceptableAnswers":[],"explanation":"...","sourceExcerpt":"..."}]}',
    ].join("\n");

    const results = new Map();
    const BATCH = 15;
    for (let i = 0; i < requests.length; i += BATCH) {
      const batch = requests.slice(i, i + BATCH);
      const result = await request("generateQuestions", instructions, { material: context, requests: batch });
      const list = Array.isArray(result) ? result : result.questions || [];
      for (const raw of list) {
        const req = batch.find((r) => r.requestId === (raw && raw.requestId));
        if (!req || results.has(req.requestId)) continue;
        const q = validateQuestion(raw, req.type, context);
        if (q) results.set(req.requestId, q);
      }
    }
    return results;
  }

  // ------------------------------------------------------------------
  // 작업 4: 단원 요약본 (구조화)
  // ------------------------------------------------------------------
  async function summarize({ unitName, context }) {
    const instructions = [
      COMMON_RULES,
      "",
      "작업: 자료를 시험·암기용으로 구조화한 요약본을 만들어라. 원문을 단순히 줄이지 마라.",
      "- 섹션은 자료에 해당 내용이 있을 때만 만든다: 반드시 암기할 내용 / 핵심 개념 / 정의 / 특징 / 원인 / 결과 / 기능 / 구조 / 비교 / 중요 숫자·날짜.",
      "  (역사라면 인물·사건·연도, 해부학이라면 구조명·위치·기능·주변 구조, 법학이라면 개념·요건·차이점처럼 자료 성격에 맞춰도 된다.)",
      "- '반드시 암기할 내용' 섹션을 맨 앞에 두고 importance 5 항목을 모아라.",
      "- 각 item: text(짧고 명확하게, 자료 표현 유지), sourceExcerpt(자료 원문 그대로), importance(1~5).",
      IMPORTANCE_GUIDE,
      '출력 형식: {"sections":[{"title":"...","items":[{"text":"...","sourceExcerpt":"...","importance":5}]}]}',
    ].join("\n");
    const result = await request("summarize", instructions, { unitName, material: context });
    const sections = Array.isArray(result) ? result : result.sections || [];
    const out = [];
    for (const s of sections) {
      const title = String((s && s.title) || "").trim();
      const items = (Array.isArray(s && s.items) ? s.items : [])
        .map((it) => ({
          text: String((it && it.text) || "").trim(),
          sourceExcerpt: String((it && it.sourceExcerpt) || "").trim(),
          importance: Utils.clamp(Math.round(Number(it && it.importance) || 3), 1, 5),
        }))
        .filter((it) => it.text && validateExcerpt(it.sourceExcerpt, context) && isGrounded(it.text, it.sourceExcerpt, context, 0.5));
      if (title && items.length) out.push({ title, items });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 작업 5 (v4): 교재 사진 문서 분석 — 원본 이미지 + OCR 결과 + 이전 쪽 구조 → 구조 JSON
  //   AI는 이미지를 보고 OCR이 틀린 글자를 고치고, 줄의 종류(대제목·소제목·본문·신념화)를 정한다.
  //   결과는 DocStructure.mergeAi가 OCR 줄과 한 줄씩 맞춰 보며 "교정"만 받아들인다
  //   (OCR에 없던 줄은 확인 대기, AI가 빠뜨린 OCR 줄은 되살림).
  // ------------------------------------------------------------------
  async function analyzeDocument(input) {
    const instructions = [
      COMMON_RULES,
      "",
      "작업: 교재 한 쪽의 사진(첨부 이미지)과 그 사진을 OCR로 읽은 결과가 주어진다. 사진을 직접 보고 이 쪽의 문서 구조를 JSON으로 복원하라.",
      "입력: ocrRegions(영역별 OCR 원문: header=제목줄, question=질문 칸, label=왼쪽 라벨, block=본문 칸, footer=쪽 번호), cleanedText(규칙으로 정리한 글),",
      "      localStructure(규칙으로 추정한 구조), previousStructure(앞 쪽의 구조 — 대제목 번호·용어를 이어서 판단할 때만 참고).",
      "규칙:",
      " - OCR 오인식은 사진을 보고 고쳐라(대할민국→대한민국, 국굳→국군, 현법→헌법 등). 교정만 하고 설명·지식을 덧붙이지 마라.",
      " - 사진에 있는 글자만 옮겨라. 요약하거나 다시 쓰지 말고, 문장 순서를 바꾸지 마라.",
      " - 워터마크(사선으로 비스듬히 찍힌 이름/날짜/시각, 예: 계급/이름/2025-01-01 09:00)와 쪽 번호(예: 정신전력 - 5)는 빼라.",
      "   단, 워터마크가 본문 글자와 겹친 곳은 본문 글자를 살려라.",
      " - 뒷면이 비쳐 보이는 흐린 거울 글씨는 무시하라.",
      " - 제목줄 → title, 질문 칸 → question{number, text, tags[], starred(★ 표시)},",
      "   '핵심 내용' 칸 → sections[{number, title, content[], subsections[{title, content[]}]}],",
      "   (번호 달린 굵은 줄 = 대제목, '-'로 시작하는 줄 = 소제목, 그 아래 줄 = content 한 줄씩)",
      "   '신념화' 칸 → beliefContent[] (● 한 개 = 항목 한 개, 줄바꿈으로 이어진 항목은 한 항목으로).",
      " - 확실히 읽을 수 없는 글자는 OCR 원문을 그대로 두어라.",
      '출력 형식: {"title":"…","question":{"number":"3","text":"…","tags":["…"],"starred":true},"sections":[…],"beliefContent":["…"]}',
    ].join("\n");
    const { imageBase64, ...rest } = input || {};
    const images = imageBase64 ? [{ mediaType: "image/jpeg", data: imageBase64 }] : [];
    const result = await request("analyzeDocument", instructions, rest, images);
    const page = result && (result.page || result.structure || result);
    if (!page || typeof page !== "object" || (!page.sections && !page.question && !page.beliefContent)) {
      throw new Error("AI 문서 분석 결과 형식이 올바르지 않습니다.");
    }
    return page;
  }

  return {
    isConfigured,
    statusText,
    request,
    validateExcerpt,
    isGrounded,
    validateQuestion,
    correctOcr,
    extractPoints,
    extractWordItems,
    generateQuestions,
    summarize,
    analyzeDocument,
  };
})();
