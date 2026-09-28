// quiz.js
// 시험 세션 저장/채점/종료. 문제 만들기는 quizGenerator.js(내용)·wordStudy.js(단어) 담당.
//
// 문제 레코드 (questions 스토어):
//   id, sessionId, order, subjectId, unitId(=sourceUnitId), sourceUnitId, sourceMaterialId,
//   targetType('point'|'word'), targetId(암기 포인트 id 또는 단어 항목 id),
//   type, difficulty, importance(1~5), question, options, answer, acceptableAnswers, explanation,
//   sourceExcerpt(필수), gradeMode('choice'|'text'|'self'), generator('ai'|'local')
//
// 시험 세션 (testSessions 스토어):
//   id, scope('unit'|'words'), subjectId, unitId, title, mode('normal'|'wrong-retry'),
//   parentSessionId, totalQuestions, correctCount, wrongCount, scorePercent,
//   pctBefore, pctAfter, generatorSummary, quality, coreTotal, coreCorrect, startedAt, finishedAt
window.Quiz = (function () {
  const TYPES = {
    OX: "OX",
    MC: "MULTIPLE_CHOICE",
    SUBJECTIVE: "SUBJECTIVE",
    FILL: "FILL_BLANK",
    SHORT: "SHORT_ANSWER",
    DESC: "DESCRIPTIVE",
  };
  const TYPE_LABELS = {
    OX: "O/X",
    MULTIPLE_CHOICE: "객관식",
    SUBJECTIVE: "주관식",
    FILL_BLANK: "빈칸 채우기",
    SHORT_ANSWER: "단답형",
    DESCRIPTIVE: "설명형",
  };
  const DIFFICULTY_LABELS = { EASY: "쉬움", MEDIUM: "보통", HARD: "어려움" };

  /** 유형별 채점 방식: 선택형은 자동, 짧은 답은 자동+정정 가능, 서술형은 자기채점. */
  function gradeModeFor(type) {
    if (type === TYPES.OX || type === TYPES.MC) return "choice";
    if (type === TYPES.FILL || type === TYPES.SHORT) return "text";
    return "self";
  }

  function difficultyFor(type) {
    if (type === TYPES.OX) return "EASY";
    if (type === TYPES.MC) return "EASY";
    if (type === TYPES.FILL || type === TYPES.SHORT) return "MEDIUM";
    return "HARD";
  }

  // ------------------------------------------------------------------
  // 채점
  // ------------------------------------------------------------------
  /**
   * @returns {{isCorrect: boolean|null, needsSelfGrade: boolean}}
   *   isCorrect=null이면 사용자가 직접 맞았는지 선택해야 한다(서술형).
   */
  function grade(question, userAnswer) {
    const user = Utils.normalizeText(userAnswer);
    const accepted = [question.answer].concat(question.acceptableAnswers || []).map(Utils.normalizeText);
    const exact = user.length > 0 && accepted.includes(user);
    if (question.gradeMode === "choice") return { isCorrect: exact, needsSelfGrade: false };
    if (question.gradeMode === "text") return { isCorrect: exact, needsSelfGrade: false };
    // 서술형: 완전히 같으면 바로 정답, 아니면 모범답안과 비교해 스스로 채점
    if (exact) return { isCorrect: true, needsSelfGrade: false };
    return { isCorrect: null, needsSelfGrade: true };
  }

  // ------------------------------------------------------------------
  // 세션
  // ------------------------------------------------------------------
  /**
   * drafts는 quizGenerator/wordStudy가 만든 문제 초안 배열(이미 섞인 순서).
   */
  async function createSession({ scope, subjectId, unitId, title, drafts, mode, parentSessionId, pctBefore, notes, quality }) {
    const now = Utils.now();
    const session = {
      id: Utils.generateId(),
      scope,
      subjectId,
      unitId: unitId || null,
      title,
      mode: mode || "normal",
      parentSessionId: parentSessionId || null,
      totalQuestions: drafts.length,
      correctCount: 0,
      wrongCount: 0,
      scorePercent: 0,
      pctBefore: pctBefore ?? null,
      pctAfter: null,
      generatorSummary: summarizeGenerators(drafts),
      notes: notes || [],
      quality: quality || null, // 품질 검증 통계 (만든 수 / 폐기 수 / 재생성 수 / 폐기 이유)
      startedAt: now,
      finishedAt: null,
    };
    const questions = drafts.map((d, i) => ({
      id: Utils.generateId(),
      sessionId: session.id,
      order: i,
      subjectId,
      unitId: d.sourceUnitId || unitId || null,
      sourceUnitId: d.sourceUnitId || unitId || null,
      sourceMaterialId: d.sourceMaterialId || null,
      materialId: d.sourceMaterialId || null, // v1 필드명 호환
      targetType: d.targetType,
      targetId: d.targetId,
      type: d.type,
      difficulty: d.difficulty || difficultyFor(d.type),
      importance: d.importance || 3,
      question: d.question,
      options: d.options || null,
      answer: d.answer,
      acceptableAnswers: d.acceptableAnswers || [],
      explanation: d.explanation || "",
      sourceExcerpt: d.sourceExcerpt,
      gradeMode: d.gradeMode || gradeModeFor(d.type),
      generator: d.generator || "local",
      createdAt: now,
    }));
    await Storage.put("testSessions", session);
    await Storage.putMany("questions", questions);
    return session;
  }

  function summarizeGenerators(drafts) {
    const ai = drafts.filter((d) => d.generator === "ai").length;
    if (ai === 0) return "local";
    if (ai === drafts.length) return "ai";
    return "mixed";
  }

  async function getSession(id) {
    return Storage.get("testSessions", id);
  }

  async function getQuestions(sessionId) {
    const qs = await Storage.getAllByIndex("questions", "sessionId", sessionId);
    return qs.sort((a, b) => a.order - b.order);
  }

  async function getAnswers(sessionId) {
    return Storage.getAllByIndex("testAnswers", "sessionId", sessionId);
  }

  /** 문제 하나 답할 때마다 즉시 저장 → 새로고침해도 이어서 풀 수 있다. */
  async function saveAnswer(sessionId, question, userAnswer, isCorrect, gradedBy) {
    const record = {
      id: `${sessionId}:${question.id}`,
      sessionId,
      questionId: question.id,
      userAnswer: String(userAnswer ?? ""),
      isCorrect: !!isCorrect,
      gradedBy: gradedBy || "auto", // auto | self | override
      answeredAt: Utils.now(),
    };
    await Storage.put("testAnswers", record);
    return record;
  }

  async function scopeProgress(session) {
    if (session.scope === "words") return (await Learning.wordProgress(session.subjectId)).pct;
    return (await Learning.unitProgress(session.unitId)).pct;
  }

  /**
   * 시험 종료: 점수 확정 + 문제별 대상(암기 포인트/단어)의 학습 정도 갱신 + 오답 기록.
   * 이미 종료된 세션을 다시 호출해도 학습 정도가 두 번 반영되지 않는다.
   */
  async function finishSession(sessionId) {
    const session = await getSession(sessionId);
    if (!session) throw new Error("존재하지 않는 시험입니다.");
    if (session.finishedAt) return session;

    const questions = await getQuestions(sessionId);
    const answers = await getAnswers(sessionId);
    const answerByQ = new Map(answers.map((a) => [a.questionId, a]));

    if (session.pctBefore === null || session.pctBefore === undefined) {
      session.pctBefore = await scopeProgress(session);
    }

    const storeFor = (q) => (q.targetType === "word" ? "wordItems" : "points");
    const cache = new Map();
    for (const q of questions) {
      const a = answerByQ.get(q.id);
      if (!a || !q.targetId) continue;
      const key = storeFor(q) + ":" + q.targetId;
      let target = cache.get(key);
      if (!target) {
        target = await Storage.get(storeFor(q), q.targetId);
        if (!target) continue; // 그 사이 자료가 삭제된 경우
        cache.set(key, target);
      }
      Learning.applyResult(target, a.isCorrect, 1);
      target.lastQuestionType = q.type;
      await WrongAnswers.record({
        targetType: q.targetType,
        targetId: q.targetId,
        subjectId: session.subjectId,
        unitId: q.sourceUnitId,
        questionId: q.id,
        isCorrect: a.isCorrect,
      });
    }
    for (const [key, target] of cache) {
      await Storage.put(key.split(":")[0], target);
    }

    const answered = questions.filter((q) => answerByQ.has(q.id));
    const correct = answered.filter((q) => answerByQ.get(q.id).isCorrect).length;
    session.totalQuestions = questions.length;
    session.answeredCount = answered.length;
    session.correctCount = correct;
    session.wrongCount = answered.length - correct;
    session.scorePercent = questions.length ? Math.round((correct / questions.length) * 100) : 0;
    const core = questions.filter((q) => (q.importance || 3) >= 4);
    session.coreTotal = core.length;
    session.coreCorrect = core.filter((q) => answerByQ.get(q.id) && answerByQ.get(q.id).isCorrect).length;
    session.finishedAt = Utils.now();
    session.pctAfter = await scopeProgress(session);
    await Storage.put("testSessions", session);
    return session;
  }

  async function listSessionsBySubject(subjectId) {
    const items = await Storage.getAllByIndex("testSessions", "subjectId", subjectId);
    return items.sort((a, b) => b.startedAt - a.startedAt);
  }

  async function listSessionsByUnit(unitId) {
    const items = await Storage.getAllByIndex("testSessions", "unitId", unitId);
    return items.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 세션과 그 문제·답안을 삭제 (과목/단원 삭제 시 사용). */
  async function removeSessionsBy(indexName, value) {
    const sessions = await Storage.getAllByIndex("testSessions", indexName, value);
    for (const s of sessions) {
      await Storage.removeAllByIndex("testAnswers", "sessionId", s.id);
      await Storage.removeAllByIndex("questions", "sessionId", s.id);
      await Storage.remove("testSessions", s.id);
    }
  }

  // v1 인터페이스 호환 (세션 없이 단원에 붙은 문제 조회)
  async function listByUnit(unitId) {
    return Storage.getAllByIndex("questions", "unitId", unitId);
  }

  return {
    TYPES,
    TYPE_LABELS,
    DIFFICULTY_LABELS,
    gradeModeFor,
    difficultyFor,
    grade,
    createSession,
    getSession,
    getQuestions,
    getAnswers,
    saveAnswer,
    finishSession,
    listSessionsBySubject,
    listSessionsByUnit,
    removeSessionsBy,
    listByUnit,
  };
})();
