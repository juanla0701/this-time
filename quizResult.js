// quizResult.js
// 시험 세션 하나의 결과를 화면에 필요한 형태로 조합한다.
window.QuizResult = (function () {
  async function getSessionDetail(sessionId) {
    const session = await Quiz.getSession(sessionId);
    if (!session) return null;
    const questions = await Quiz.getQuestions(sessionId);
    const answers = await Quiz.getAnswers(sessionId);
    const byQ = new Map(answers.map((a) => [a.questionId, a]));
    const rows = questions.map((q, i) => ({ no: i + 1, question: q, answer: byQ.get(q.id) || null }));
    return {
      session,
      rows,
      wrongRows: rows.filter((r) => !r.answer || !r.answer.isCorrect),
    };
  }

  /** 이 시험에서 틀린(또는 못 푼) 문제의 대상 id 목록 → "오답 다시 풀기"에 사용. */
  async function wrongTargetIds(sessionId) {
    const detail = await getSessionDetail(sessionId);
    if (!detail) return [];
    return [...new Set(detail.wrongRows.map((r) => r.question.targetId).filter(Boolean))];
  }

  return { getSessionDetail, wrongTargetIds };
})();
