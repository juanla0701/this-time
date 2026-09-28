// summary.js
// 단원 요약본 + 빈칸 학습 데이터.
//
// 요약은 원문을 줄이는 게 아니라 암기용으로 구조화한다:
//   반드시 암기할 내용(중요도 5) → 정의 → 기능·역할 → 구조·위치 → 원인·결과 → 비교 → 순서 → 숫자·날짜 → 특징 → 참고·세부
// 한 번 만든 요약은 저장해두고, 자료가 바뀌었을 때만 "다시 만들기"를 권한다 (AI 비용 절약).
//
// 저장 형태: { id, unitId, sections:[{ title, items:[{ text, sourceExcerpt, importance, pointId? }] }],
//              origin('ai'|'local'), contentHash, createdAt, updatedAt }
// v1에서 저장된 items가 문자열 배열이어도 화면에서 그대로 보이도록 호환한다.
window.Summary = (function () {
  const SECTION_ORDER = ["정의", "원리", "기능·역할", "구조·위치", "원인·결과", "비교", "순서", "숫자·날짜", "인물·사건", "용어", "특징"];

  async function get(unitId) {
    const items = await Storage.getAllByIndex("summaries", "unitId", unitId);
    return items[0] || null;
  }

  async function save(unitId, sections, extra) {
    const existing = await get(unitId);
    const now = Utils.now();
    const record = {
      id: existing ? existing.id : Utils.generateId(),
      unitId,
      sections,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      ...(extra || {}),
    };
    await Storage.put("summaries", record);
    return record;
  }

  async function unitContext(unitId) {
    const materials = (await Materials.listByUnit(unitId)).filter((m) => (m.studyMode || "content") === "content");
    const context = materials.map((m) => `[${m.title}]\n${Materials.textOf(m)}`).join("\n\n");
    return { materials, context, hash: Utils.hashString(context) };
  }

  /** AI 없이 만드는 구조화 요약: 암기 포인트를 중요도·분류별로 묶는다 (자료 문장만 사용). */
  function buildFromPoints(points) {
    const item = (p) => ({ text: p.text, sourceExcerpt: p.sourceExcerpt, importance: p.importance || 3, pointId: p.id });
    const byImp = (a, b) => (b.importance || 3) - (a.importance || 3);
    const sections = [];
    const must = points.filter((p) => (p.importance || 3) >= 5).sort(byImp);
    if (must.length) sections.push({ title: "반드시 암기할 내용", items: must.map(item) });
    const rest = points.filter((p) => (p.importance || 3) >= 3 && (p.importance || 3) < 5);
    const cats = new Map();
    for (const p of rest) {
      const c = SECTION_ORDER.includes(p.category) ? p.category : "특징";
      if (!cats.has(c)) cats.set(c, []);
      cats.get(c).push(p);
    }
    for (const c of SECTION_ORDER) if (cats.has(c)) sections.push({ title: c, items: cats.get(c).sort(byImp).map(item) });
    const minor = points.filter((p) => (p.importance || 3) <= 2);
    if (minor.length) sections.push({ title: "참고·세부", items: minor.map(item) });
    return sections;
  }

  /**
   * v4: 교재 구조에서 만든 포인트(area 있음)는 교재 순서 그대로 요약한다.
   *   [Q3. 질문] → 답의 뼈대 + 핵심 내용(대제목·소제목 순서, 질문과 연결된 줄은 중요도 5)
   *   [신념화] → 마음가짐 항목 (시험 비중 낮음)
   * 구조가 없는 포인트는 예전 방식(중요도·분류별)으로 뒤에 붙인다.
   */
  function buildFromStructurePoints(points) {
    const item = (p) => ({ text: p.text, sourceExcerpt: p.sourceExcerpt, importance: p.importance || 3, pointId: p.id, heading: p.heading || null, area: p.area });
    const structured = points.filter((p) => p.area);
    const rest = points.filter((p) => !p.area);
    const groups = new Map();
    for (const p of structured) {
      if (p.area === "belief") continue;
      const key = p.pageQuestion || "핵심 내용";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const sections = [];
    for (const [title, list] of groups) {
      list.sort((a, b) => (a.area === "question" ? -1 : 0) - (b.area === "question" ? -1 : 0) || (a.orderIndex || 0) - (b.orderIndex || 0));
      sections.push({ title, kind: "question", items: list.map(item) });
    }
    const belief = structured.filter((p) => p.area === "belief");
    if (belief.length) sections.push({ title: "신념화 (마음가짐)", kind: "belief", items: belief.map(item) });
    if (rest.length) sections.push(...buildFromPoints(rest));
    return sections;
  }

  function hasStructure(points) {
    return points.some((p) => p.area);
  }

  async function buildLocal(unitId) {
    const { points } = await Learning.refreshUnitPoints(unitId, { useAi: false });
    return hasStructure(points) ? buildFromStructurePoints(points) : buildFromPoints(points);
  }

  /**
   * 요약 생성. AI 연결 시 AI 요약(근거 검증 통과분만), 실패하면 기본 요약으로 대체.
   * @returns {Promise<{summary, fellBack: boolean, message: string}>}
   */
  async function generate(unitId) {
    const unit = await Units.get(unitId);
    const { context, hash } = await unitContext(unitId);
    if (!context.trim()) throw new Error("요약할 자료가 없습니다.");
    // 교재 구조가 있는 단원: 요약은 구조에서 만든다 (AI 요약보다 교재 순서·질문 연결이 정확함)
    const { points } = await Learning.refreshUnitPoints(unitId, { useAi: false });
    if (hasStructure(points)) {
      const summary = await save(unitId, buildFromStructurePoints(points), { origin: "structure", contentHash: hash });
      return { summary, fellBack: false, message: "" };
    }
    if (Ai.isConfigured()) {
      try {
        const sections = await Ai.summarize({ unitName: unit ? unit.name : "", context });
        if (!sections.length) throw new Error("AI 요약 결과가 자료 근거 검증을 통과하지 못했습니다.");
        const summary = await save(unitId, sections, { origin: "ai", contentHash: hash });
        return { summary, fellBack: false, message: "" };
      } catch (err) {
        console.warn("AI 요약 실패, 기본 요약으로 대체:", err);
        const summary = await save(unitId, await buildLocal(unitId), { origin: "local", contentHash: hash });
        return { summary, fellBack: true, message: `AI 분석을 사용할 수 없어 기본 분석으로 생성했습니다. (${err.message || err})` };
      }
    }
    const summary = await save(unitId, await buildLocal(unitId), { origin: "local", contentHash: hash });
    return { summary, fellBack: false, message: "" };
  }

  /** 화면용: 저장된 요약 + 자료가 바뀌었는지 여부. */
  async function load(unitId) {
    const saved = await get(unitId);
    const { hash, context } = await unitContext(unitId);
    return { summary: saved, outdated: !!(saved && saved.contentHash && saved.contentHash !== hash), hasMaterial: !!context.trim() };
  }

  /**
   * 빈칸 학습 카드: 단원 암기 포인트 중 빈칸 정답이 있는 것, 중요도 높은 순.
   * 각 카드: { pointId, blankText:"대한민국의 수도는 [      ]이다.", answer:"서울", importance, sourceExcerpt }
   */
  async function blankCards(unitId, opts) {
    const { points } = await Learning.refreshUnitPoints(unitId, { useAi: !!(opts && opts.useAi) && Ai.isConfigured() });
    return points
      .filter((p) => p.answer && p.blankText && p.blankText.includes(TextAnalysis.BLANK))
      .sort((a, b) => (b.importance || 3) - (a.importance || 3) || (a.orderIndex || 0) - (b.orderIndex || 0))
      .map((p) => ({
        pointId: p.id,
        blankText: p.blankText,
        answer: p.answer,
        importance: p.importance || 3,
        sourceExcerpt: p.sourceExcerpt,
        studyLevel: p.studyLevel || 0,
      }));
  }

  return { get, save, generate, load, buildLocal, buildFromPoints, buildFromStructurePoints, blankCards };
})();
