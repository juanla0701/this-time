// learning.js
// 학습 정도(studyLevel 0~100) 계산과 "암기 포인트" 관리.
//
// ■ 암기 포인트(points 스토어)
//   내용 암기 단원의 자료를 "외워야 할 핵심 내용 1개 = 레코드 1개"로 쪼갠 것.
//   시험은 이 포인트들을 기준으로 출제되고, 모든 포인트가 최소 1번씩 문제에 들어간다.
//   포인트는 자료(material)별로 추출·캐시한다. 자료 내용이 바뀌면 그 자료의 포인트만
//   다시 뽑고, 문장이 같은 포인트는 기존 학습 기록(studyLevel 등)을 그대로 이어받는다.
//     - AI 연결 시: ai.js가 자료에서 핵심 내용을 추출 (sourceExcerpt 검증 통과분만 저장)
//     - AI 미연결 시: 자료 문장을 그대로 포인트로 사용 (자료에 없는 내용이 생길 수 없음)
//   각 포인트에는 분석 정보가 붙는다 (v3):
//     importance(1~5 중요도), category(정의/원인·결과/기능·역할 …), questionTarget(외울 핵심),
//     blankText("대한민국의 수도는 [      ]이다."), answer("서울" — 짧은 핵심어만), explanation
//   예전에 만들어진 포인트에 이 정보가 없으면 학습 기록은 그대로 두고 분석 정보만 채운다.
//
// ■ 학습 정도 규칙
//   - 정답: 남은 거리(100 - level)의 일정 비율만큼 상승. 연속 정답(streak)일수록 더 크게
//     오른다 → "반복해서 맞혀야" 100%에 가까워진다.
//   - 오답: 현재 값의 40% 하락, 연속 정답 초기화.
//   - 시험을 "봤다는 사실"만으로는 오르지 않는다. 오직 정답/오답 결과로만 바뀐다.
//   - [학습하기](플래시카드)의 "알았음"은 시험 정답의 절반만 반영한다.
window.Learning = (function () {
  // ------------------------------------------------------------------
  // 학습 정도 갱신
  // ------------------------------------------------------------------
  function applyResult(target, isCorrect, weight) {
    const w = weight === undefined ? 1 : weight;
    const level = target.studyLevel || 0;
    const streak = target.streak || 0;
    if (isCorrect) {
      const newStreak = streak + 1;
      const rate = (0.25 + 0.05 * Math.min(newStreak, 4)) * w;
      target.studyLevel = Math.round(Utils.clamp(level + (100 - level) * rate, 0, 100) * 10) / 10;
      target.correctCount = (target.correctCount || 0) + 1;
      target.streak = newStreak;
    } else {
      const drop = 0.4 * w;
      target.studyLevel = Math.round(Utils.clamp(level * (1 - drop), 0, 100) * 10) / 10;
      target.wrongCount = (target.wrongCount || 0) + 1;
      target.streak = 0;
    }
    target.lastResult = !!isCorrect;
    target.lastStudiedAt = Utils.now();
    return target;
  }

  // ------------------------------------------------------------------
  // 로컬 포인트 추출 (AI 미연결 시 / AI 실패 시 폴백) → textAnalysis.js
  // ------------------------------------------------------------------
  const ANALYSIS_VERSION = 3;
  const ANALYSIS_FIELDS = ["importance", "category", "questionTarget", "blankText", "answer", "explanation", "area", "questionLinked", "pageQuestion"];

  function splitSentences(text) {
    return TextAnalysis.splitSentencesWithHeadings(text).map((r) => r.sentence);
  }

  function extractPointsLocal(text) {
    return TextAnalysis.analyzePointsLocal(text);
  }

  function pickAnalysis(src) {
    const out = {};
    for (const f of ANALYSIS_FIELDS) out[f] = src[f] === undefined ? null : src[f];
    if (!out.importance) out.importance = 3;
    return out;
  }

  // ------------------------------------------------------------------
  // 단원 포인트 동기화
  // ------------------------------------------------------------------
  /**
   * 단원의 모든 자료에 대해 포인트가 최신인지 확인하고, 필요하면 다시 추출한다.
   * @param {object} opts { useAi: boolean }
   * @returns {Promise<{points: object[], aiErrors: string[], usedAi: boolean}>}
   */
  async function refreshUnitPoints(unitId, opts) {
    const useAi = !!(opts && opts.useAi) && window.Ai && Ai.isConfigured();
    const unit = await Storage.get("units", unitId);
    if (!unit) return { points: [], aiErrors: [], usedAi: false };

    const materials = (await Storage.getAllByIndex("materials", "unitId", unitId)).filter(
      (m) => (m.studyMode || "content") === "content"
    );
    let allPoints = await Storage.getAllByIndex("points", "unitId", unitId);
    const aiErrors = [];
    let usedAi = false;

    // 1) 삭제된 자료의 포인트 정리
    const materialIds = new Set(materials.map((m) => m.id));
    const orphan = allPoints.filter((p) => !materialIds.has(p.materialId));
    if (orphan.length) {
      await Storage.removeMany(
        "points",
        orphan.map((p) => p.id)
      );
      allPoints = allPoints.filter((p) => materialIds.has(p.materialId));
    }

    // 2) 자료별로 필요한 경우에만 다시 추출
    for (const m of materials) {
      const text = m.finalText ?? m.rawText ?? "";
      const hash = Utils.hashString(text);
      const upToDate = m.pointsHash === hash;
      // v4: 교재 구조([질문]/[핵심 내용]/[신념화])가 있는 자료는 구조에서 포인트를 만든다 (AI 추출보다 우선)
      const structurePoints = window.StructureLearning ? StructureLearning.pointsFromText(text) : null;
      const needAiUpgrade = useAi && !structurePoints && m.pointsOrigin !== "ai";
      // 예전 버전의 기본 분석 결과는 새 분석(중요도·빈칸)으로 다시 계산 (학습 기록은 문장 기준으로 유지)
      const staleLocal = m.pointsOrigin !== "ai" && m.pointsOrigin !== "structure" && m.pointsVersion !== ANALYSIS_VERSION;
      const staleStructure = !!structurePoints && m.pointsOrigin !== "structure";
      if (upToDate && !needAiUpgrade && !staleLocal && !staleStructure) continue;

      let extracted = null;
      let origin = "local";
      if (structurePoints && structurePoints.length) {
        extracted = structurePoints;
        origin = "structure";
      } else if (useAi && text.trim()) {
        try {
          extracted = await Ai.extractPoints({ title: m.title, text });
          origin = "ai";
          usedAi = true;
          if (!extracted.length) extracted = null;
        } catch (err) {
          console.warn("AI 포인트 추출 실패, 기본 방식으로 대체:", err);
          aiErrors.push(`${m.title}: ${err.message || err}`);
          extracted = null;
        }
      }
      if (!extracted) {
        extracted = extractPointsLocal(text);
        origin = "local";
      }

      const oldForMaterial = allPoints.filter((p) => p.materialId === m.id);
      const oldByKey = new Map(oldForMaterial.map((p) => [Utils.normalizeText(p.text), p]));
      const now = Utils.now();
      const next = [];
      const keep = new Set();
      extracted.forEach((e, idx) => {
        const key = Utils.normalizeText(e.text);
        const prev = oldByKey.get(key);
        if (prev && !keep.has(prev.id)) {
          keep.add(prev.id);
          next.push({ ...prev, sourceExcerpt: e.sourceExcerpt, heading: e.heading || null, ...pickAnalysis(e), orderIndex: idx, origin, updatedAt: now });
        } else {
          next.push({
            id: Utils.generateId(),
            subjectId: m.subjectId,
            unitId,
            materialId: m.id,
            text: e.text,
            sourceExcerpt: e.sourceExcerpt,
            heading: e.heading || null,
            ...pickAnalysis(e),
            orderIndex: idx,
            origin,
            studyLevel: 0,
            correctCount: 0,
            wrongCount: 0,
            streak: 0,
            lastResult: null,
            lastStudiedAt: null,
            lastQuestionType: null,
            createdAt: now,
            updatedAt: now,
          });
        }
      });
      // 문장 경계가 바뀐 경우(줄 잇기 등): 거의 같은 문장이면 이전 학습 기록을 이어받는다
      for (let k = 0; k < next.length; k++) {
        const n = next[k];
        if (oldForMaterial.some((p) => p.id === n.id)) continue;
        const cand = oldForMaterial.find(
          (p) => !keep.has(p.id) && (TextAnalysis.containment(p.text, n.text) >= 0.9 || TextAnalysis.similarity(p.text, n.text) >= 0.8)
        );
        if (cand) {
          keep.add(cand.id);
          next[k] = {
            ...n,
            id: cand.id,
            studyLevel: cand.studyLevel,
            correctCount: cand.correctCount,
            wrongCount: cand.wrongCount,
            streak: cand.streak,
            lastResult: cand.lastResult,
            lastStudiedAt: cand.lastStudiedAt,
            lastQuestionType: cand.lastQuestionType,
            createdAt: cand.createdAt,
          };
        }
      }
      const removed = oldForMaterial.filter((p) => !keep.has(p.id));
      if (removed.length) {
        await Storage.removeMany(
          "points",
          removed.map((p) => p.id)
        );
      }
      await Storage.putMany("points", next);
      // updatedAt은 건드리지 않는다 (사용자가 수정한 시각이 아니므로)
      await Storage.put("materials", { ...m, pointsHash: hash, pointsOrigin: origin, pointsVersion: ANALYSIS_VERSION });

      allPoints = allPoints.filter((p) => p.materialId !== m.id).concat(next);
    }

    // 3) 분석 정보가 없는 예전 포인트(AI 추출분 등) 보강: 학습 기록은 그대로, 분석 정보만 채움
    const lacking = allPoints.filter((p) => !p.importance);
    if (lacking.length) {
      for (const p of lacking) Object.assign(p, TextAnalysis.enrichPoint(p, {}));
      await Storage.putMany("points", lacking);
    }

    const materialOrder = new Map(materials.map((m, i) => [m.id, m.createdAt || i]));
    allPoints.sort(
      (a, b) =>
        (materialOrder.get(a.materialId) || 0) - (materialOrder.get(b.materialId) || 0) ||
        (a.orderIndex || 0) - (b.orderIndex || 0)
    );
    return { points: allPoints, aiErrors, usedAi };
  }

  /** 자료가 추가/수정/삭제될 때 호출. AI를 부르지 않고 로컬로만 즉시 동기화한다(비용 0). */
  async function onMaterialsChanged(unitId) {
    if (!unitId) return;
    try {
      await refreshUnitPoints(unitId, { useAi: false });
    } catch (err) {
      console.warn("포인트 동기화 실패 (자료 저장에는 영향 없음):", err);
    }
  }

  // ------------------------------------------------------------------
  // 학습률 계산 (항상 저장된 데이터에서 실시간 계산)
  // ------------------------------------------------------------------
  async function unitProgress(unitId) {
    const [points, materials, sessions] = await Promise.all([
      Storage.getAllByIndex("points", "unitId", unitId),
      Storage.getAllByIndex("materials", "unitId", unitId),
      Storage.getAllByIndex("testSessions", "unitId", unitId),
    ]);
    const levels = points.map((p) => p.studyLevel || 0);
    const pct = points.length ? Utils.average(levels) : 0;
    const studied = points.filter((p) => p.lastStudiedAt).length;
    const lastStudiedAt = Math.max(0, ...points.map((p) => p.lastStudiedAt || 0));
    const finished = sessions.filter((s) => s.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt);
    const byImportance = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    points.forEach((p) => (byImportance[p.importance || 3] += 1));
    const core = points.filter((p) => (p.importance || 3) >= 4);
    return {
      pct: Math.round(pct),
      corePct: core.length ? Math.round(Utils.average(core.map((p) => p.studyLevel || 0))) : null,
      byImportance,
      pointCount: points.length,
      studiedCount: studied,
      materialCount: materials.length,
      lastStudiedAt: lastStudiedAt || null,
      lastSession: finished[0] || null,
      levels,
    };
  }

  async function wordProgress(subjectId) {
    const items = await Storage.getAllByIndex("wordItems", "subjectId", subjectId);
    const levels = items.map((i) => i.studyLevel || 0);
    return {
      pct: Math.round(items.length ? Utils.average(levels) : 0),
      itemCount: items.length,
      studiedCount: items.filter((i) => i.lastStudiedAt).length,
      lastStudiedAt: Math.max(0, ...items.map((i) => i.lastStudiedAt || 0)) || null,
      levels,
    };
  }

  /**
   * 과목 전체 학습률 = 모든 단원 암기 포인트 + 모든 단어 항목의 학습 정도 평균.
   * (각 항목의 학습 정도는 시험/학습 결과로만 바뀌므로 "시험 결과"가 자연스럽게 반영된다.)
   * 자료는 있지만 아직 포인트가 없는 단원은 0% 항목 1개로 계산해서, 공부 안 한
   * 단원이 전체 학습률을 부풀리지 않게 한다.
   */
  async function subjectProgress(subjectId) {
    const units = await Storage.getAllByIndex("units", "subjectId", subjectId);
    const [allMaterials, sessions, words] = await Promise.all([
      Storage.getAllByIndex("materials", "subjectId", subjectId),
      Storage.getAllByIndex("testSessions", "subjectId", subjectId),
      wordProgress(subjectId),
    ]);
    let levels = words.levels.slice();
    let lastStudiedAt = words.lastStudiedAt || 0;
    const unitStats = [];
    const legacySessions = [];
    for (const u of units) {
      const up = await unitProgress(u.id);
      unitStats.push({ unit: u, ...up });
      if (up.pointCount) levels = levels.concat(up.levels);
      else if (up.materialCount) levels.push(0);
      lastStudiedAt = Math.max(lastStudiedAt, up.lastStudiedAt || 0);
      // v1 시절(subjectId 없이 저장된) 세션도 마지막 학습 상태에 반영
      const unitSessions = await Storage.getAllByIndex("testSessions", "unitId", u.id);
      legacySessions.push(...unitSessions.filter((s) => !s.subjectId));
    }
    const finished = sessions
      .concat(legacySessions)
      .filter((s) => s.finishedAt)
      .sort((a, b) => b.finishedAt - a.finishedAt);
    const last = finished[0] || null;
    if (last) lastStudiedAt = Math.max(lastStudiedAt, last.finishedAt);
    return {
      pct: Math.round(levels.length ? Utils.average(levels) : 0),
      materialCount: allMaterials.length,
      wordCount: words.itemCount,
      unitCount: units.length,
      pointCount: levels.length - words.itemCount,
      lastStudiedAt: lastStudiedAt || null,
      lastSession: last,
      unitStats,
      words,
    };
  }

  return {
    applyResult,
    splitSentences,
    extractPointsLocal,
    refreshUnitPoints,
    onMaterialsChanged,
    unitProgress,
    wordProgress,
    subjectProgress,
  };
})();
