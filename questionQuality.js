// questionQuality.js
// 시험 문제 품질 검증. 만들어진 문제(AI든 기본 출제든)는 사용자에게 보이기 전에 반드시 여기를 통과해야 한다.
//
// 검사 항목 (하나라도 걸리면 폐기 → 다른 방식으로 다시 생성)
//   1. 자료 근거      : sourceExcerpt가 실제 자료 원문에 있는가
//   2. 질문 명확성    : 너무 짧거나 막연한 질문이 아닌가, 금지된 "나쁜 문제" 패턴이 아닌가
//   3. 정답 단일성    : 객관식 정답이 하나뿐인가, O/X 정답이 O 또는 X인가, 빈칸이 있는가
//   4·5. 중요도/사소함 : 세부(중요도 1) 내용을 서술형으로 묻지 않는가, 정답이 조사·일반어 같은 사소한 낱말이 아닌가
//   6. 논리 연결      : 정답이 근거 원문에서 나온 것인가, 질문 안에 정답이 그대로 드러나 있지 않은가
//   7. (1과 동일) sourceExcerpt 실존 확인
//   8. 중복           : 같은 시험의 다른 문제와 거의 같은 질문이 아닌가
window.QuestionQuality = (function () {
  const TA = () => TextAnalysis;
  const T = () => Quiz.TYPES;

  // "나쁜 문제" 패턴 (실제 암기 여부를 확인하지 못하는 질문)
  const BAD_PATTERNS = [
    [/(단어|낱말|글자|표현)(가|이)\s*(들어간|포함된|쓰인)\s*(문장|것)/, "단순 단어 찾기 문제"],
    [/(첫|두|세|네|다섯|마지막)\s*번째\s*(단어|낱말|글자|문장)/, "몇 번째 단어를 묻는 의미 없는 문제"],
    [/몇\s*(번|회)\s*(나오|등장|쓰였|사용)/, "단어 등장 횟수를 묻는 의미 없는 문제"],
    [/몇\s*(글자|자로)/, "글자 수를 묻는 의미 없는 문제"],
    [/(그대로|똑같이)\s*(쓰|적|옮겨)/, "문장을 그대로 베끼게 하는 문제"],
  ];
  // 내용 없이 틀만 있는 막연한 질문 (예: "다음 내용에 대해 올바른 것은?")
  const VAGUE = /^(다음|아래|위)\s*(내용|설명|글|자료)?(에\s*대해|에\s*대한|중|으로)?\s*(올바른|옳은|맞는|알맞은|바른)\s*것은\s*\??$/;

  function norm(s) {
    return Utils.normalizeText(s);
  }

  function isTrivialAnswer(answer) {
    const a = String(answer || "").trim();
    return !norm(a) || TA().STOPWORDS.has(a) || TA().GENERIC.has(a) || TA().PARTICLES.includes(a);
  }

  /**
   * @param {object} q     문제 초안 (type, question, options, answer, sourceExcerpt, targetType …)
   * @param {object} opts  { context: 자료 전체 텍스트, target: 포인트/단어 항목, accepted: 이미 통과한 문제들 }
   * @returns {{ok: boolean, reasons: string[]}}
   */
  function check(q, opts) {
    const o = opts || {};
    const reasons = [];
    const t = T();
    const context = o.context || "";
    const target = o.target || {};
    const importance = target.importance || 3;
    const question = String(q.question || "");
    const answer = String(q.answer ?? "");
    const excerpt = String(q.sourceExcerpt || "");
    const basis = `${excerpt}\n${target.text || ""}\n${target.term || ""} ${target.definition || ""}`;

    // 1·7. 자료 근거
    if (!excerpt || !Ai.validateExcerpt(excerpt, context)) reasons.push("sourceExcerpt가 자료 원문에 없음");

    // 2. 질문 명확성
    const firstLine = question.split("\n")[0].trim();
    const contentChars = norm(question.replace(/다음|아래|내용|설명|자료|올바른|옳은|것은|고르시오|쓰시오/g, ""));
    if (norm(question).length < 8 || contentChars.length < 6) reasons.push("질문이 너무 짧거나 막연함");
    if (VAGUE.test(firstLine) && question.split("\n").filter((l) => l.trim()).length === 1) reasons.push("범위가 막연한 질문");
    for (const [re, why] of BAD_PATTERNS) if (re.test(question)) reasons.push(why);

    // 3. 정답이 하나로 결정되는가
    if (q.type === t.OX && !["O", "X"].includes(answer)) reasons.push("O/X 정답이 O 또는 X가 아님");
    if (q.type === t.MC) {
      const opts2 = (q.options || []).map(norm);
      if (opts2.length < 2 || new Set(opts2).size !== opts2.length) reasons.push("객관식 보기가 부족하거나 중복됨");
      const hits = opts2.filter((x) => x === norm(answer)).length;
      if (hits !== 1) reasons.push("객관식 정답이 보기 중 정확히 하나가 아님");
      const nested = opts2.filter((x) => x !== norm(answer) && x && (x.includes(norm(answer)) || norm(answer).includes(x)));
      if (nested.length && norm(answer).length >= 2) reasons.push("정답과 겹치는 보기가 있어 정답이 둘일 수 있음");
    }
    if (q.type === t.FILL && !/\[\s*\]|\(\s{2,}\)|○○/.test(question)) reasons.push("빈칸이 없는 빈칸 문제");

    // 4·5. 중요도 / 사소한 내용
    if ([t.FILL, t.SHORT, t.MC].includes(q.type) && isTrivialAnswer(answer)) reasons.push("정답이 조사·일반어 같은 사소한 낱말");
    if (importance <= 1 && [t.SUBJECTIVE, t.DESC].includes(q.type)) reasons.push("세부 내용을 서술형으로 과하게 묻는 문제");
    if ([t.FILL, t.SHORT].includes(q.type) && norm(answer).length > 30) reasons.push("정답이 너무 긴 단답/빈칸 문제");

    // 6. 문제와 정답의 논리적 연결
    if ([t.FILL, t.SHORT, t.MC].includes(q.type)) {
      if (!TA().fuzzyIncludes(answer, basis)) reasons.push("정답이 근거 원문에 없음");
      if (norm(answer).length >= 2 && norm(question).includes(norm(answer))) reasons.push("질문 안에 정답이 드러남");
    }
    if ([t.SUBJECTIVE, t.DESC].includes(q.type) && TA().containment(answer, basis) < 0.5) reasons.push("모범답안이 근거 원문과 맞지 않음");
    if (q.type === t.OX && answer === "O" && TA().containment(excerpt, question) < 0.35 && TA().similarity(question, excerpt) < 0.3) {
      reasons.push("O가 정답인데 진술이 근거와 다름");
    }

    // 8. 중복
    for (const other of o.accepted || []) {
      if (other.targetId === q.targetId && other.type === q.type) {
        reasons.push("같은 내용·같은 유형 문제가 이미 있음");
        break;
      }
      if (TA().similarity(other.question, question) >= 0.85) {
        reasons.push("다른 문제와 거의 같은 질문");
        break;
      }
    }
    return { ok: reasons.length === 0, reasons };
  }

  return { check, BAD_PATTERNS };
})();
