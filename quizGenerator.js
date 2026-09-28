// quizGenerator.js
// "중요 내용 중심 + 자료 전체 커버" 시험 조립기.
//
//   자료 수집 → 암기 포인트(중요도·빈칸 포함) → 중요도 기반 출제 계획 → 문제 생성(AI 또는 기본)
//   → 품질 검증(questionQuality.js) → 불합격 문제 폐기·재생성 → 커버리지 확인 → 순서/보기 섞기
//
// ■ 출제 비중 (중요도 1~5)
//   핵심(5) 약 45% · 중요(4) 약 27% · 일반(3) 약 18% · 보조/세부(2·1) 나머지 약 10%
//   (있는 등급끼리 비율을 다시 나눈다)
// ■ 커버리지
//   - 중요도 2 이상인 포인트는 매 시험 최소 1번 반드시 출제
//   - 세부(1) 포인트는 "세부 몫" 안에서만 출제하고, 이번에 빠진 것은 다음 시험에 우선 출제(돌아가며 전부 다룸)
// ■ 반복 상한 (같은 내용을 억지로 여러 번 내지 않기)
//   핵심 최대 3회(매번 다른 유형) · 중요/일반 최대 2회 · 보조/세부 1회
//   (품질 검증으로 빈 자리가 생기면 중요(4) 내용은 3번째 유형까지 써서 채운다 — 세부 비중이 커지지 않게)
// ■ 유형
//   학습 정도·중요도에 맞춰 가중 랜덤. 같은 내용에 같은 유형은 반복하지 않고, 직전 시험 유형은 피한다.
//
// 기본 출제(AI 미연결·실패 시)는 자료 문장과 그 분석(빈칸 정답·주제어)만으로 문제를 만든다.
// 오답 보기·틀린 진술도 같은 단원 다른 포인트의 핵심어로만 만든다.
window.QuizGenerator = (function () {
  const T = () => Quiz.TYPES;
  const TA = () => TextAnalysis;

  const SHARE = { 5: 0.45, 4: 0.275, 3: 0.175, low: 0.1 };
  const MAX_REPEAT_BY_IMPORTANCE = { 5: 3, 4: 2, 3: 2, 2: 1, 1: 1 };

  function imp(t) {
    return Utils.clamp(Math.round(t.importance || 3), 1, 5);
  }
  function groupOf(t) {
    const i = imp(t);
    return i >= 5 ? "5" : i === 4 ? "4" : i === 3 ? "3" : "low";
  }
  function maxRepeat(t) {
    return MAX_REPEAT_BY_IMPORTANCE[imp(t)];
  }

  // ------------------------------------------------------------------
  // 문제 수 자동 결정 (실제 암기 포인트 수 기준)
  // ------------------------------------------------------------------
  function decideCount(n) {
    if (n <= 0) return 0;
    let count;
    if (n <= 5) count = Math.min(Math.max(5, n * 2), 10); // 매우 적은 자료: 5~10
    else if (n <= 12) count = Utils.clamp(Math.round(n * 1.3), 10, 15); // 적은 자료: 10~15
    else if (n <= 30) count = Utils.clamp(Math.round(n * 1.15), 15, 30); // 중간: 15~30
    else count = Math.max(30, n); // 많은 자료: 30~50+
    return count;
  }

  // ------------------------------------------------------------------
  // 중요도 기반 출제 계획
  // ------------------------------------------------------------------
  /**
   * @returns {{ slots: object[], skippedDetail: object[] }} slots = 출제 대상(반복 포함)
   */
  function planByImportance(targets) {
    const groups = { 5: [], 4: [], 3: [], low: [] };
    targets.forEach((t) => groups[groupOf(t)].push(t));
    const required = targets.filter((t) => imp(t) >= 2);
    const detail = targets.filter((t) => imp(t) <= 1);

    let N = decideCount(targets.length);
    const present = Object.keys(groups).filter((g) => groups[g].length);
    const shareSum = present.reduce((s, g) => s + SHARE[g], 0);
    const desired = {};
    present.forEach((g) => (desired[g] = (SHARE[g] / shareSum) * N));

    // 세부(1): 세부 몫 안에서만, 아직 안 다뤘거나 약한 것부터 (나머지는 다음 시험에)
    const lowRequired = groups.low.filter((t) => imp(t) >= 2).length;
    // 세부가 있으면 시험마다 최소 1개는 돌아가며 출제 (여러 번 보면 자료 전체를 다룸)
    const detailBudget = required.length ? Math.max(detail.length ? 1 : 0, Math.round((desired.low || 0) - lowRequired)) : detail.length;
    const detailSorted = detail
      .map((t) => ({ t, k: (t.lastStudiedAt ? 1 : 0) * 1000 + (t.studyLevel || 0) + Math.random() * 20 }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.t);
    const detailChosen = detailSorted.slice(0, Math.max(detailBudget, required.length ? 0 : detail.length));
    const skippedDetail = detailSorted.slice(detailChosen.length);

    const base = required.concat(detailChosen); // 커버리지 (각 1회)
    const times = new Map(base.map((t) => [t.id, 1]));
    const alloc = { 5: 0, 4: 0, 3: 0, low: 0 };
    base.forEach((t) => (alloc[groupOf(t)] += 1));
    const slots = base.slice();
    if (N < slots.length) N = slots.length; // 커버리지가 문제 수보다 우선
    // 보조·세부가 전체의 15%를 넘지 않도록, 필요하면 핵심·중요 문제를 더 늘린다 (반복 상한 안에서)
    if (alloc.low && required.length > alloc.low) N = Math.max(N, Math.ceil(alloc.low / 0.15));

    const capacity = (g) => groups[g].some((t) => times.has(t.id) && times.get(t.id) < maxRepeat(t));
    let guard = 0;
    while (slots.length < N && guard++ < 1000) {
      // 목표 비중보다 가장 모자란 등급에 추가 (없으면 높은 등급부터)
      const open = present.filter(capacity);
      if (!open.length) break;
      const g = open.sort((a, b) => desired[b] - alloc[b] - (desired[a] - alloc[a]) || Number(b === "low" ? 0 : b) - Number(a === "low" ? 0 : a))[0];
      const candidates = groups[g].filter((t) => times.has(t.id) && times.get(t.id) < maxRepeat(t));
      const weights = candidates.map((t) => {
        const weak = 100 - (t.studyLevel || 0);
        const wrong = Math.min(t.wrongCount || 0, 5) * 15;
        const again = times.get(t.id) > 1 ? 0.35 : 1;
        return (weak + wrong + 10) * (1 + imp(t) / 5) * again;
      });
      const pick = Utils.weightedPick(candidates, weights);
      times.set(pick.id, times.get(pick.id) + 1);
      alloc[g] += 1;
      slots.push(pick);
    }
    return { slots, skippedDetail };
  }

  // ------------------------------------------------------------------
  // 유형 선택 (학습 정도·중요도 + 다양성 + 직전 유형 회피)
  // ------------------------------------------------------------------
  function typeWeight(type, level, importance) {
    const t = T();
    const easy = [t.OX, t.MC];
    const mid = [t.FILL, t.SHORT];
    let w;
    if (level < 30) w = easy.includes(type) ? 1.6 : mid.includes(type) ? 1.0 : 0.5;
    else if (level < 70) w = mid.includes(type) ? 1.3 : 1.0;
    else w = easy.includes(type) ? 0.6 : mid.includes(type) ? 1.1 : 1.6;
    if (importance <= 2 && !easy.concat(mid).includes(type)) w *= 0.2; // 세부 내용은 가볍게
    if (importance >= 5 && (type === t.SHORT || type === t.FILL)) w *= 1.2; // 핵심은 직접 떠올리게
    return w;
  }

  function orderTypes(target, supported, usedForTarget, typeCounts) {
    const level = target.studyLevel || 0;
    const remaining = supported.slice();
    const ordered = [];
    while (remaining.length) {
      const weights = remaining.map((type) => {
        let w = typeWeight(type, level, imp(target));
        w *= 1 / (1 + (typeCounts[type] || 0));
        if (usedForTarget.includes(type)) w *= 0.02;
        if (target.lastQuestionType === type && supported.length > 1) w *= 0.35;
        return w;
      });
      const pick = Utils.weightedPick(remaining, weights);
      ordered.push(pick);
      remaining.splice(remaining.indexOf(pick), 1);
    }
    return ordered;
  }

  /** 같은 대상 문제가 연달아 나오지 않도록 섞는다. */
  function shuffleSpread(drafts) {
    const a = Utils.shuffle(drafts);
    for (let i = 1; i < a.length; i++) {
      if (a[i].targetId === a[i - 1].targetId) {
        const j = a.findIndex((d, k) => k > i && d.targetId !== a[i - 1].targetId && (k + 1 >= a.length || a[k + 1].targetId !== a[i].targetId));
        if (j > 0) [a[i], a[j]] = [a[j], a[i]];
      }
    }
    return a;
  }

  /**
   * 품질 검증에서 떨어져 빈 자리가 생기면 버리지 않고, 반복 여유가 있는 핵심·중요 내용으로 다시 채운다
   * (빈 자리를 그대로 두면 상대적으로 세부 내용 비중이 커지기 때문).
   */
  function refillSlots({ missing, targets, drafts, used, typeCounts, build, accept }) {
    if (missing <= 0) return 0;
    const fillers = targets
      .filter((t) => imp(t) >= 4)
      .sort((a, b) => imp(b) - imp(a) || (a.studyLevel || 0) - (b.studyLevel || 0));
    let filled = 0;
    const cap = (t) => Math.max(maxRepeat(t), 3); // 채우기 용도로는 중요(4)도 최대 3가지 유형까지 허용
    for (const t of fillers) {
      while (filled < missing && (used.get(t.id) || []).length < cap(t)) {
        const usedForTarget = used.get(t.id) || [];
        const types = orderTypes(t, allTypes().filter((x) => !usedForTarget.includes(x)), usedForTarget, typeCounts);
        let got = null;
        for (const type of types) {
          const d = build(t, type);
          if (d && accept(d, t)) {
            got = d;
            break;
          }
        }
        if (!got) break;
        typeCounts[got.type] = (typeCounts[got.type] || 0) + 1;
        used.set(t.id, usedForTarget.concat(got.type));
        drafts.push(got);
        filled++;
      }
      if (filled >= missing) break;
    }
    return filled;
  }

  /**
   * 공통 조립 (기본 출제·단어 시험): 각 자리마다 유형을 바꿔가며 만들고 품질 검증을 통과한 것만 채택.
   * @returns {{drafts, stats}}
   */
  function assemble({ targets, supportedTypesOf, build, fallback, context, targetOf }) {
    const { slots, skippedDetail } = planByImportance(targets);
    const typeCounts = {};
    const used = new Map();
    const drafts = [];
    const stats = { built: 0, rejected: 0, reasons: {}, skippedDetail: skippedDetail.length };
    const tryAccept = (draft, target) => {
      if (!draft) return false;
      stats.built++;
      const res = QuestionQuality.check(draft, { context, target: targetOf ? targetOf(target) : target, accepted: drafts });
      if (!res.ok) {
        stats.rejected++;
        res.reasons.forEach((r) => (stats.reasons[r] = (stats.reasons[r] || 0) + 1));
        return false;
      }
      return true;
    };
    for (const target of slots) {
      const usedForTarget = used.get(target.id) || [];
      const types = orderTypes(target, supportedTypesOf(target), usedForTarget, typeCounts);
      let accepted = null;
      for (const type of types) {
        const d = build(target, type);
        if (tryAccept(d, target)) {
          accepted = d;
          break;
        }
      }
      if (!accepted && usedForTarget.length === 0) {
        const fb = fallback(target);
        if (tryAccept(fb, target)) accepted = fb;
        else if (fb) accepted = fb; // 커버리지 최후 수단 (자료 문장 그대로의 O/X)
      }
      if (!accepted) continue;
      typeCounts[accepted.type] = (typeCounts[accepted.type] || 0) + 1;
      used.set(target.id, usedForTarget.concat(accepted.type));
      drafts.push(accepted);
    }
    stats.refilled = refillSlots({
      missing: slots.length - drafts.length,
      targets,
      drafts,
      used,
      typeCounts,
      build,
      accept: (d, t) => tryAccept(d, t),
    });
    return { drafts, stats };
  }

  function verifyCoverage(targets, drafts) {
    const covered = new Set(drafts.map((d) => d.targetId));
    return targets.filter((t) => imp(t) >= 2 && !covered.has(t.id));
  }

  // ------------------------------------------------------------------
  // 내용 암기: 기본 출제 (포인트 분석 기반)
  // ------------------------------------------------------------------
  function contentBase(point, type) {
    return {
      targetType: "point",
      targetId: point.id,
      sourceUnitId: point.unitId,
      sourceMaterialId: point.materialId,
      sourceExcerpt: point.sourceExcerpt || point.text,
      importance: imp(point),
      type,
      difficulty: Quiz.difficultyFor(type),
      gradeMode: Quiz.gradeModeFor(type),
      generator: "local",
    };
  }

  /** 다른 포인트의 핵심어 중 같은 종류(숫자 ↔ 숫자)이고 이 문장에 없는 것 → 오답 보기/틀린 진술 */
  function distractorsFor(answer, point, pool, n) {
    const isNum = /[0-9]/.test(answer);
    const normAns = Utils.normalizeText(answer);
    const normSentence = Utils.normalizeText(point.text);
    const ranked = Utils.shuffle(pool)
      .filter((c) => c.pointId !== point.id)
      .filter((c) => {
        const nw = Utils.normalizeText(c.word);
        return nw && nw !== normAns && !normSentence.includes(nw) && !nw.includes(normAns) && !normAns.includes(nw) && /[0-9]/.test(c.word) === isNum;
      })
      .sort((a, b) => (b.category === point.category) - (a.category === point.category) || b.isAnswer - a.isAnswer);
    const uniq = [];
    for (const c of ranked) if (!uniq.some((u) => Utils.normalizeText(u) === Utils.normalizeText(c.word))) uniq.push(c.word);
    return uniq.slice(0, n);
  }

  function blankOf(point) {
    if (point.answer && point.blankText && point.blankText.includes(TA().BLANK)) return { answer: point.answer, blankText: point.blankText };
    return TA().chooseBlank(point.text);
  }

  function subjectiveQuestion(subject, category) {
    const s = subject;
    switch (category) {
      case "기능·역할":
        return `${TA().josa(s, "은/는")} 어떤 기능(역할)을 하는가? 자료 내용대로 쓰시오.`;
      case "정의":
        return `${TA().josa(s, "이란/란")} 무엇인가? 자료의 정의대로 쓰시오.`;
      case "원인·결과":
        return `${s}에 대해 자료에 나온 원인과 결과를 쓰시오.`;
      case "구조·위치":
        return `${s}의 구조나 위치를 자료 내용대로 쓰시오.`;
      case "숫자·날짜":
        return `${s}에 관한 수치·날짜를 포함해 자료 내용대로 쓰시오.`;
      default:
        return `자료에 따르면 ${TA().josa(s, "은/는")} 어떠한가? 핵심 내용을 쓰시오.`;
    }
  }

  function buildContentLocal(point, type, pool) {
    const t = T();
    const s = point.text;
    const base = contentBase(point, type);
    const blank = blankOf(point);
    const topic = TA().splitTopic(s);

    if (type === t.OX) {
      if (Math.random() < 0.5 && blank) {
        const [wrong] = distractorsFor(blank.answer, point, pool, 1);
        const altered = wrong ? TA().makeBlank(s, blank.answer)?.replace(TA().BLANK, wrong) : null;
        if (altered) {
          return {
            ...base,
            question: `다음 내용이 자료와 일치하면 O, 틀리면 X를 고르시오.\n${altered}`,
            options: ["O", "X"],
            answer: "X",
            explanation: `‘${wrong}’이(가) 아니라 ‘${blank.answer}’입니다. 자료: “${s}”`,
          };
        }
      }
      return {
        ...base,
        question: `다음 내용이 자료와 일치하면 O, 틀리면 X를 고르시오.\n${s}`,
        options: ["O", "X"],
        answer: "O",
        explanation: `자료에 그대로 나오는 내용입니다: “${s}”`,
      };
    }

    if (type === t.MC) {
      if (!blank) return null;
      const ds = distractorsFor(blank.answer, point, pool, 3);
      if (ds.length < 2) return null; // 보기 3개 미만이면 찍기 문제가 되므로 만들지 않음
      return {
        ...base,
        question: Utils.pickRandom([`다음 [      ]에 들어갈 알맞은 말은?\n${blank.blankText}`, `빈칸에 알맞은 것을 고르시오.\n${blank.blankText}`]),
        options: Utils.shuffle([blank.answer, ...ds]),
        answer: blank.answer,
        explanation: point.explanation || `정답은 ‘${blank.answer}’입니다. 자료: “${s}”`,
      };
    }

    if (type === t.FILL) {
      if (!blank) return null;
      return {
        ...base,
        question: `빈칸에 들어갈 말을 쓰시오.\n${blank.blankText}`,
        answer: blank.answer,
        explanation: point.explanation || `빈칸에는 ‘${blank.answer}’이(가) 들어갑니다. 자료: “${s}”`,
      };
    }

    if (type === t.SHORT) {
      // 주제어를 묻는 경우: "혈액을 전신으로 순환시키는 펌프 역할을 하는 것은?" → 심장
      if (topic && blank && Utils.normalizeText(topic.subject) === Utils.normalizeText(blank.answer)) {
        const pred = topic.predicate.replace(/[.。]$/, "");
        return {
          ...base,
          question: `다음 설명에 해당하는 것은?\n“${pred}”`,
          answer: blank.answer,
          explanation: `자료: “${s}”`,
        };
      }
      if (!blank) return null;
      return {
        ...base,
        question: `다음에서 ○○에 알맞은 말을 한두 단어로 쓰시오.\n${blank.blankText.replace(TA().BLANK, "○○")}`,
        answer: blank.answer,
        explanation: point.explanation || `○○은(는) ‘${blank.answer}’입니다. 자료: “${s}”`,
      };
    }

    if (type === t.SUBJECTIVE) {
      if (!topic) return null;
      return {
        ...base,
        question: subjectiveQuestion(topic.subject, point.category || TA().categoryOf(s)),
        answer: topic.predicate,
        explanation: `자료: “${s}”`,
      };
    }

    if (type === t.DESC) {
      const key = (topic && topic.subject) || point.questionTarget;
      if (!key || imp(point) < 3) return null;
      return {
        ...base,
        question: `‘${key}’에 대해 자료에 나온 핵심 내용을 설명하시오.`,
        answer: s,
        explanation: `자료: “${s}”`,
      };
    }
    return null;
  }

  function contentFallback(point) {
    const t = T();
    const blank = blankOf(point);
    if (blank) {
      return {
        ...contentBase(point, t.FILL),
        question: `빈칸에 들어갈 말을 쓰시오.\n${blank.blankText}`,
        answer: blank.answer,
        explanation: `자료: “${point.text}”`,
      };
    }
    return {
      ...contentBase(point, t.OX),
      question: `다음 내용이 자료와 일치하면 O, 틀리면 X를 고르시오.\n${point.text}`,
      options: ["O", "X"],
      answer: "O",
      explanation: `자료에 그대로 나오는 내용입니다: “${point.text}”`,
    };
  }

  /** 오답 보기 재료: 각 포인트의 빈칸 정답(우선) + 핵심어 후보 */
  function contentPool(points) {
    const pool = [];
    for (const p of points) {
      if (p.answer) pool.push({ word: p.answer, pointId: p.id, category: p.category, isAnswer: 1 });
      for (const c of TA().keywordCandidates(p.text)) {
        if (!c.generic && TA().isGoodBlankAnswer(c.stem, p.text)) pool.push({ word: c.stem, pointId: p.id, category: p.category, isAnswer: 0 });
      }
    }
    return pool;
  }

  function allTypes() {
    const t = T();
    return [t.OX, t.MC, t.SUBJECTIVE, t.FILL, t.SHORT, t.DESC];
  }

  // ------------------------------------------------------------------
  // 내용 암기 시험 만들기 (단원)
  // opts: { targetIds?: string[] (오답 다시 풀기 등 일부만), onProgress?: fn(text) }
  // ------------------------------------------------------------------
  async function buildUnitTest(unitId, opts) {
    const o = opts || {};
    const useAi = Ai.isConfigured();
    const progress = o.onProgress || (() => {});
    const notes = [];

    progress("자료 전체를 모으고 중요 내용을 분석하는 중…");
    const { points: allPoints, aiErrors } = await Learning.refreshUnitPoints(unitId, { useAi });
    if (useAi && aiErrors.length) notes.push("AI 분석을 사용할 수 없어 일부 자료는 기본 분석으로 생성했습니다.");
    const targets = o.targetIds ? allPoints.filter((p) => o.targetIds.includes(p.id)) : allPoints;
    if (!targets.length) {
      throw new Error(o.targetIds ? "다시 풀 오답이 없습니다." : "이 단원에 시험 볼 자료가 없습니다. 먼저 사진이나 글을 추가하세요.");
    }

    const materials = (await Materials.listByUnit(unitId)).filter((m) => (m.studyMode || "content") === "content");
    const context = materials.map((m) => `[${m.title}]\n${Materials.textOf(m)}`).join("\n\n");
    const pool = contentPool(allPoints);
    const byId = new Map(targets.map((p) => [p.id, p]));
    const localSupported = (p) => allTypes().filter((type) => type === T().OX || buildContentLocal(p, type, pool) !== null);

    let drafts;
    let stats;
    if (!useAi) {
      ({ drafts, stats } = assemble({
        targets,
        supportedTypesOf: localSupported,
        build: (p, type) => buildContentLocal(p, type, pool),
        fallback: contentFallback,
        context,
      }));
    } else {
      ({ drafts, stats } = await buildWithAi({ targets, byId, pool, context, notes, progress }));
    }

    // 커버리지 확인: 중요도 2 이상 포인트가 한 번도 안 나왔으면 추가 출제
    const missing = verifyCoverage(targets, drafts);
    for (const p of missing) drafts.push(buildContentLocal(p, T().FILL, pool) || contentFallback(p));
    drafts = drafts.filter((d) => d && d.sourceExcerpt);

    progress("문제 순서를 섞는 중…");
    return { drafts: shuffleSpread(drafts), notes, targetCount: targets.length, stats };
  }

  /** AI 출제: 계획 → AI 생성 → 품질 검증 → 불합격분 AI 재생성(이유 전달) → 그래도 불합격이면 기본 출제 */
  async function buildWithAi({ targets, byId, pool, context, notes, progress }) {
    const { slots, skippedDetail } = planByImportance(targets);
    const typeCounts = {};
    const used = new Map();
    const plan = slots.map((target, i) => {
      const usedForTarget = used.get(target.id) || [];
      const type = orderTypes(target, allTypes(), usedForTarget, typeCounts)[0];
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      used.set(target.id, usedForTarget.concat(type));
      return { requestId: "r" + i, target, type };
    });
    const stats = { built: 0, rejected: 0, regenerated: 0, localFallback: 0, aiAccepted: 0, reasons: {}, skippedDetail: skippedDetail.length };
    const accepted = new Map(); // requestId → draft
    const acceptedList = () => [...accepted.values()];
    const toRequest = (p, feedback) => ({
      requestId: p.requestId,
      type: p.type,
      difficulty: Quiz.difficultyFor(p.type),
      importance: imp(p.target),
      pointText: p.target.text,
      sourceExcerpt: p.target.sourceExcerpt,
      questionTarget: p.target.questionTarget || p.target.answer || null,
      answerHint: p.target.answer || null,
      // v4: 교재 상단 질문과 연결된 내용이면 그 질문을 함께 준다 (구술평가 질문에 맞춘 출제)
      pageQuestion: p.target.pageQuestion || null,
      questionLinked: !!p.target.questionLinked,
      area: p.target.area || null,
      avoidQuestions: acceptedList().filter((d) => d.targetId === p.target.id).map((d) => d.question),
      feedback: feedback || null,
    });
    const judge = (p, aiQ) => {
      stats.built++;
      const draft = { ...contentBase(p.target, p.type), ...aiQ, generator: "ai" };
      if (draft.options && p.type === T().MC) draft.options = Utils.shuffle(draft.options);
      const res = QuestionQuality.check(draft, { context, target: p.target, accepted: acceptedList() });
      if (res.ok) return { draft };
      stats.rejected++;
      res.reasons.forEach((r) => (stats.reasons[r] = (stats.reasons[r] || 0) + 1));
      return { reasons: res.reasons };
    };

    // 1차 생성
    let pending = plan;
    let feedbackById = {};
    for (let round = 0; round < 2 && pending.length; round++) {
      let aiMap = new Map();
      try {
        progress(round === 0 ? `AI가 문제 ${pending.length}개를 만드는 중…` : `검증에서 떨어진 ${pending.length}문제를 AI가 다시 만드는 중…`);
        aiMap = await Ai.generateQuestions({ context, requests: pending.map((p) => toRequest(p, feedbackById[p.requestId])) });
      } catch (err) {
        console.warn("AI 문제 생성 실패, 기본 출제로 대체:", err);
        notes.push(`AI 분석을 사용할 수 없어 기본 분석으로 생성했습니다. (${err.message || err})`);
        break;
      }
      const next = [];
      for (const p of pending) {
        const aiQ = aiMap.get(p.requestId);
        const verdict = aiQ ? judge(p, aiQ) : { reasons: ["AI 응답 형식·근거 검증 실패"] };
        if (!aiQ) {
          stats.rejected++;
          stats.reasons["AI 응답 형식·근거 검증 실패"] = (stats.reasons["AI 응답 형식·근거 검증 실패"] || 0) + 1;
        }
        if (verdict.draft) {
          accepted.set(p.requestId, verdict.draft);
          stats.aiAccepted++;
          if (round > 0) stats.regenerated++;
        } else {
          feedbackById[p.requestId] = verdict.reasons.join(", ");
          next.push(p);
        }
      }
      pending = next;
    }

    // 끝까지 불합격한 자리는 기본 출제 (그것도 품질 검증)
    for (const p of pending) {
      const types = [p.type].concat(orderTypes(p.target, allTypes().filter((x) => x !== p.type), [], typeCounts));
      let chosen = null;
      for (const type of types) {
        const d = buildContentLocal(p.target, type, pool);
        if (!d) continue;
        stats.built++;
        const res = QuestionQuality.check(d, { context, target: p.target, accepted: acceptedList() });
        if (res.ok) {
          chosen = d;
          break;
        }
        stats.rejected++;
      }
      if (!chosen && ![...accepted.values()].some((d) => d.targetId === p.target.id)) chosen = contentFallback(p.target);
      if (chosen) {
        accepted.set(p.requestId, chosen);
        stats.localFallback++;
      }
    }
    if (stats.localFallback && !notes.length) notes.push(`품질 검증을 통과하지 못한 ${stats.localFallback}문제는 기본 출제로 대체했습니다.`);
    const drafts = plan.map((p) => accepted.get(p.requestId)).filter(Boolean);
    const usedNow = new Map();
    drafts.forEach((d) => usedNow.set(d.targetId, (usedNow.get(d.targetId) || []).concat(d.type)));
    stats.refilled = refillSlots({
      missing: plan.length - drafts.length,
      targets,
      drafts,
      used: usedNow,
      typeCounts,
      build: (t, type) => buildContentLocal(t, type, pool),
      accept: (d, t) => QuestionQuality.check(d, { context, target: t, accepted: drafts }).ok,
    });
    return { drafts, stats };
  }

  // v2 호환: 핵심 낱말 후보는 textAnalysis.js로 이동
  function keywordCandidates(sentence) {
    return TA().keywordCandidates(sentence);
  }

  return {
    decideCount,
    planByImportance,
    assemble,
    verifyCoverage,
    shuffleSpread,
    keywordCandidates,
    buildContentLocal,
    buildUnitTest,
    allTypes,
    SHARE,
    MAX_REPEAT_BY_IMPORTANCE,
  };
})();
