// wrongAnswers.js
// 오답 기록. 시험 문제는 매번 새로 만들어지므로(표현·유형이 바뀜) 오답은 "문제"가 아니라
// 그 문제가 묻는 대상(암기 포인트 또는 단어 항목) 기준으로 누적한다.
//   { id, targetType, targetId, subjectId, unitId, wrongCount, correctCount,
//     lastAttemptCorrect, lastQuestionId, lastAttemptAt }
// → "오답 다시 풀기"는 lastAttemptCorrect === false 인 대상만 모아 새 문제로 다시 출제하고,
//   다시 맞히면 lastAttemptCorrect가 true가 되어 오답 목록에서 빠지고 학습 정도가 오른다.
window.WrongAnswers = (function () {
  async function getByTarget(targetId) {
    const items = await Storage.getAllByIndex("wrongAnswers", "targetId", targetId);
    return items[0] || null;
  }

  async function record({ targetType, targetId, subjectId, unitId, questionId, isCorrect }) {
    const existing = await getByTarget(targetId);
    const now = Utils.now();
    const rec = existing || {
      id: Utils.generateId(),
      targetType,
      targetId,
      subjectId,
      unitId: unitId || null,
      wrongCount: 0,
      correctCount: 0,
    };
    rec.wrongCount += isCorrect ? 0 : 1;
    rec.correctCount += isCorrect ? 1 : 0;
    rec.lastAttemptCorrect = !!isCorrect;
    rec.lastQuestionId = questionId;
    rec.lastAttemptAt = now;
    await Storage.put("wrongAnswers", rec);
    return rec;
  }

  /** 현재 "틀린 상태"인 대상 id 목록. scope: {unitId} 또는 {subjectId, words:true} */
  async function listWrongTargetIds(scope) {
    let recs;
    if (scope.unitId) {
      const unit = await Storage.get("units", scope.unitId);
      if (!unit) return [];
      recs = (await Storage.getAllByIndex("wrongAnswers", "subjectId", unit.subjectId)).filter(
        (r) => r.unitId === scope.unitId && r.targetType === "point"
      );
    } else {
      recs = (await Storage.getAllByIndex("wrongAnswers", "subjectId", scope.subjectId)).filter(
        (r) => r.targetType === "word"
      );
    }
    return recs.filter((r) => r.lastAttemptCorrect === false).map((r) => r.targetId);
  }

  // v1 호환: 문제 id 기준 조회
  async function getByQuestion(questionId) {
    const items = await Storage.getAllByIndex("wrongAnswers", "questionId", questionId);
    return items[0] || null;
  }

  return { getByTarget, record, listWrongTargetIds, getByQuestion };
})();
