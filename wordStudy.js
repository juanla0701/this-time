// wordStudy.js
// 단순 단어 암기: 용어(term) ↔ 뜻(definition) 카드와 그 시험.
//
// 항목 레코드 (wordItems 스토어):
//   id(itemId), subjectId, materialId(자료에서 가져온 경우), term, definition,
//   sourceExcerpt(근거 원문), studyLevel(0~100), correctCount, wrongCount, streak,
//   lastResult, lastStudiedAt, lastQuestionType, createdAt, updatedAt
//
// 단어 시험은 입력된 용어·뜻만으로 만들기 때문에 AI 없이도 완전히 동작한다.
// 오답 보기와 틀린 O/X 진술은 같은 과목의 "다른 단어 카드"에서만 가져온다.
window.WordStudy = (function () {
  const T = () => Quiz.TYPES;

  async function list(subjectId) {
    const items = await Storage.getAllByIndex("wordItems", "subjectId", subjectId);
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  function newItem({ subjectId, term, definition, sourceExcerpt, materialId, importance }) {
    const now = Utils.now();
    return {
      id: Utils.generateId(),
      subjectId,
      materialId: materialId || null,
      term: term.trim(),
      definition: definition.trim(),
      sourceExcerpt: (sourceExcerpt || `${term.trim()} → ${definition.trim()}`).trim(),
      importance: Utils.clamp(Math.round(Number(importance) || 3), 1, 5),
      studyLevel: 0,
      correctCount: 0,
      wrongCount: 0,
      streak: 0,
      lastResult: null,
      lastStudiedAt: null,
      lastQuestionType: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async function create(data) {
    const item = newItem(data);
    await Storage.put("wordItems", item);
    return item;
  }

  async function createMany(subjectId, list, materialId) {
    const items = list
      .filter((i) => i.term && i.term.trim() && i.definition && i.definition.trim())
      .map((i) => newItem({ subjectId, materialId, ...i }));
    await Storage.putMany("wordItems", items);
    return items;
  }

  /** 수정 시 학습 기록은 유지한다. 직접 입력 항목의 근거는 수정한 내용으로 갱신. */
  async function update(id, { term, definition }) {
    const item = await Storage.get("wordItems", id);
    if (!item) return null;
    const wasManual = !item.materialId;
    item.term = term.trim();
    item.definition = definition.trim();
    if (wasManual) item.sourceExcerpt = `${item.term} → ${item.definition}`;
    item.updatedAt = Utils.now();
    await Storage.put("wordItems", item);
    return item;
  }

  async function remove(id) {
    await Storage.remove("wordItems", id);
    const wrong = await Storage.getAllByIndex("wrongAnswers", "targetId", id);
    await Storage.removeMany(
      "wrongAnswers",
      wrong.map((w) => w.id)
    );
  }

  // ------------------------------------------------------------------
  // 자료(글/OCR)에서 용어-뜻 쌍 뽑기 (AI 미연결 시 기본 방식)
  // 지원 형식: "용어 → 뜻", "용어: 뜻", "용어 = 뜻", "용어 - 뜻", "용어<탭>뜻", "apple 사과"
  // ------------------------------------------------------------------
  const SEPARATORS = [/\s*(?:→|->|=>|⇒)\s*/, /\s*[:：]\s*/, /\s*=\s*/, /\t+/, /\s+[-–—]\s+/];

  function parseItemsLocal(text) {
    const items = [];
    const unparsed = [];
    const seen = new Set();
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.replace(/^\s*([-*•·]+|\d+[.)]|[①-⑳])\s*/, "").trim();
      if (!line) continue;
      let pair = null;
      for (const sep of SEPARATORS) {
        const m = line.split(sep);
        if (m.length >= 2 && m[0].trim() && m.slice(1).join(" ").trim()) {
          pair = [m[0].trim(), m.slice(1).join(" ").trim()];
          break;
        }
      }
      if (!pair) {
        const en = line.match(/^([A-Za-z][A-Za-z'\- ]*?)\s+([가-힣(].*)$/);
        if (en) pair = [en[1].trim(), en[2].trim()];
      }
      if (pair && pair[0].length <= 40) {
        const key = Utils.normalizeText(pair[0]);
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ term: pair[0], definition: pair[1], sourceExcerpt: line });
        }
      } else {
        unparsed.push(line);
      }
    }
    return { items, unparsed };
  }

  /** AI가 연결되어 있으면 AI로, 아니면 기본 방식으로 항목을 뽑는다. */
  async function extractItems(text) {
    if (Ai.isConfigured()) {
      try {
        const items = await Ai.extractWordItems(text);
        if (items.length) return { items, unparsed: [], origin: "ai" };
      } catch (err) {
        console.warn("AI 단어 정리 실패, 기본 방식으로 대체:", err);
        const local = parseItemsLocal(text);
        return { ...local, origin: "local", aiError: err.message || String(err) };
      }
    }
    return { ...parseItemsLocal(text), origin: "local" };
  }

  // ------------------------------------------------------------------
  // 단어 문제 만들기 (앞/뒤 방향 랜덤)
  // ------------------------------------------------------------------
  function base(item, type) {
    return {
      targetType: "word",
      targetId: item.id,
      sourceUnitId: null,
      sourceMaterialId: item.materialId || null,
      sourceExcerpt: item.sourceExcerpt || `${item.term} → ${item.definition}`,
      importance: item.importance || 3,
      type,
      difficulty: Quiz.difficultyFor(type),
      gradeMode: Quiz.gradeModeFor(type),
      generator: "local",
    };
  }

  function others(item, pool, field) {
    const mine = Utils.normalizeText(item[field]);
    const out = [];
    for (const o of Utils.shuffle(pool)) {
      if (o.id === item.id) continue;
      const v = Utils.normalizeText(o[field]);
      if (!v || v === mine || out.some((x) => Utils.normalizeText(x[field]) === v)) continue;
      out.push(o);
    }
    return out;
  }

  function buildWordQuestion(item, type, pool) {
    const t = T();
    const b = base(item, type);
    const explain = `‘${item.term}’의 뜻: ${item.definition}`;

    if (type === t.MC) {
      const toDef = Math.random() < 0.5; // 방향 랜덤
      const field = toDef ? "definition" : "term";
      const ds = others(item, pool, field).slice(0, 3);
      if (!ds.length) return null;
      return {
        ...b,
        question: toDef
          ? `‘${item.term}’의 뜻으로 알맞은 것은?`
          : `다음 설명에 해당하는 용어는?\n“${item.definition}”`,
        options: Utils.shuffle([item[field], ...ds.map((d) => d[field])]),
        answer: item[field],
        explanation: explain,
      };
    }

    if (type === t.OX) {
      const wantFalse = Math.random() < 0.5;
      const [other] = wantFalse ? others(item, pool, "definition") : [];
      const shownDef = other ? other.definition : item.definition;
      const asTerm = Math.random() < 0.5;
      return {
        ...b,
        question: asTerm
          ? `다음이 맞으면 O, 틀리면 X를 고르시오.\n‘${item.term}’ — ${shownDef}`
          : `다음이 맞으면 O, 틀리면 X를 고르시오.\n“${shownDef}”에 해당하는 용어는 ‘${item.term}’이다.`,
        options: ["O", "X"],
        answer: other ? "X" : "O",
        explanation: other ? `${explain}\n(제시된 설명은 ‘${other.term}’의 뜻입니다.)` : explain,
      };
    }

    if (type === t.SHORT) {
      return {
        ...b,
        question: Utils.pickRandom([
          `“${item.definition}”에 해당하는 용어를 쓰시오.`,
          `다음 설명에 해당하는 말은?\n${item.definition}`,
        ]),
        answer: item.term,
        explanation: explain,
      };
    }

    if (type === t.SUBJECTIVE) {
      return {
        ...b,
        question: Utils.pickRandom([`‘${item.term}’의 뜻을 쓰시오.`, `‘${item.term}’은(는) 무엇인가?`]),
        answer: item.definition,
        explanation: explain,
      };
    }

    if (type === t.FILL) {
      const words = item.definition.split(/\s+/).filter(Boolean);
      if (words.length < 2) return null;
      const cands = QuizGenerator.keywordCandidates(item.definition);
      const kw = cands.length ? Utils.pickRandom(cands.slice(0, 3)).stem : null;
      if (!kw) return null;
      const idx = item.definition.indexOf(kw);
      if (idx < 0) return null;
      const blanked = item.definition.slice(0, idx) + "(      )" + item.definition.slice(idx + kw.length);
      return {
        ...b,
        question: `빈칸에 들어갈 말을 쓰시오.\n‘${item.term}’: ${blanked}`,
        answer: kw,
        explanation: explain,
      };
    }

    if (type === t.DESC) {
      if (item.definition.length < 12) return null; // 짧은 뜻은 설명형이 어색함
      return {
        ...b,
        question: `‘${item.term}’의 특징을 자료 내용에 맞게 설명하시오.`,
        answer: item.definition,
        explanation: explain,
      };
    }
    return null;
  }

  function fallback(item) {
    return buildWordQuestion(item, T().SHORT, []);
  }

  /** 단어 시험 만들기. opts.targetIds가 있으면 그 항목만 (오답 다시 풀기). */
  async function buildTest(subjectId, opts) {
    const o = opts || {};
    const pool = await list(subjectId);
    const targets = o.targetIds ? pool.filter((i) => o.targetIds.includes(i.id)) : pool;
    if (!targets.length) throw new Error(o.targetIds ? "다시 풀 오답이 없습니다." : "먼저 단어를 추가하세요.");
    // 품질 검증의 "자료 근거"는 이 과목 단어 카드들의 근거 원문 전체
    const context = pool.map((i) => i.sourceExcerpt || `${i.term} → ${i.definition}`).join("\n");
    let { drafts, stats } = QuizGenerator.assemble({
      targets,
      supportedTypesOf: () => QuizGenerator.allTypes(),
      build: (item, type) => buildWordQuestion(item, type, pool),
      fallback,
      context,
    });
    for (const miss of QuizGenerator.verifyCoverage(targets, drafts)) drafts.push(fallback(miss));
    drafts = drafts.filter((d) => d && d.sourceExcerpt);
    return { drafts: QuizGenerator.shuffleSpread(drafts), notes: [], targetCount: targets.length, stats };
  }

  return { list, create, createMany, update, remove, parseItemsLocal, extractItems, buildWordQuestion, buildTest };
})();
