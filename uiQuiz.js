// uiQuiz.js
// 학습하기(플래시카드) · 시험 풀기 · 시험 결과 화면.
window.UIQuiz = (function () {
  const h = (s) => Utils.escapeHtml(s);
  const TL = () => Quiz.TYPE_LABELS;

  // ---------------------------------------------------------------------
  // 시험 만들기 → 시험 화면으로 이동
  // opts: { scope:'unit'|'words', subjectId, unitId, targetIds?, mode?, parentSessionId? }
  // ---------------------------------------------------------------------
  async function startTest(opts) {
    const { scope, subjectId, unitId, targetIds, mode, parentSessionId } = opts;
    UI.loadingScreen("시험 준비", "자료 전체를 분석해서 시험을 만드는 중…");
    try {
      const built =
        scope === "words"
          ? await WordStudy.buildTest(subjectId, { targetIds })
          : await QuizGenerator.buildUnitTest(unitId, { targetIds, onProgress: UI.setLoadingText });
      if (!built.drafts.length) throw new Error("만들 수 있는 문제가 없습니다.");

      const subject = await Subjects.get(subjectId);
      const unit = unitId ? await Units.get(unitId) : null;
      const pctBefore =
        scope === "words" ? (await Learning.wordProgress(subjectId)).pct : (await Learning.unitProgress(unitId)).pct;
      const baseTitle = scope === "words" ? `${subject ? subject.name : ""} 단어 시험` : unit ? unit.name : "시험";
      const session = await Quiz.createSession({
        scope,
        subjectId,
        unitId,
        title: mode === "wrong-retry" ? `${baseTitle} · 오답 다시 풀기` : baseTitle,
        drafts: built.drafts,
        mode,
        parentSessionId,
        pctBefore,
        notes: built.notes,
        quality: built.stats || null,
      });
      Router.navigate(`/test/${session.id}`);
    } catch (err) {
      UI.showError(err);
      UI.render();
    }
  }

  // ---------------------------------------------------------------------
  // 시험 풀기: 문제 → 답 → (즉시 확인) → 다음 문제
  // ---------------------------------------------------------------------
  async function renderTest(sessionId) {
    const session = await Quiz.getSession(sessionId);
    if (!session) return UI.renderNotFound("시험을 찾을 수 없습니다.", "/");
    if (session.finishedAt) return Router.replace(`/result/${sessionId}`);
    const questions = await Quiz.getQuestions(sessionId);
    const answers = new Map((await Quiz.getAnswers(sessionId)).map((a) => [a.questionId, a]));
    let idx = questions.findIndex((q) => !answers.has(q.id));
    let pendingSelfAnswer = "";
    if (idx < 0) return finish();

    async function finish() {
      UI.loadingScreen("채점 중", "결과와 학습률을 계산하는 중…");
      await Quiz.finishSession(sessionId);
      Router.replace(`/result/${sessionId}`);
    }

    function answerArea(q) {
      if (q.type === Quiz.TYPES.OX) {
        return `<div class="ox-row">
          <button class="ox-btn" data-choice="O">O</button>
          <button class="ox-btn" data-choice="X">X</button>
        </div>`;
      }
      if (q.type === Quiz.TYPES.MC) {
        return `<div class="option-list">${(q.options || [])
          .map((o, i) => `<button class="option-btn" data-choice-index="${i}"><span class="opt-no">${"①②③④⑤⑥"[i] || i + 1}</span> ${h(o)}</button>`)
          .join("")}</div>`;
      }
      const long = q.gradeMode === "self";
      return `
        ${long ? `<textarea id="answerInput" rows="4" placeholder="답을 입력하세요"></textarea>` : `<input id="answerInput" type="text" placeholder="답을 입력하세요" autocomplete="off" />`}
        <div class="row-btns">
          <button id="dontKnowBtn" class="secondary-btn">모르겠음</button>
          <button id="submitBtn" class="primary-btn">제출</button>
        </div>`;
    }

    function feedbackHtml(q, a, selfPending) {
      const isLast = idx === questions.length - 1;
      const answerBlock = `
        <div class="fb-line"><b>정답</b> ${h(q.answer)}</div>
        ${q.explanation ? `<div class="fb-line"><b>해설</b> ${h(q.explanation)}</div>` : ""}
        <div class="source-box">이 내용은 자료의 다음 부분을 기반으로 출제됨:<br/>“${h(q.sourceExcerpt)}”</div>`;
      if (selfPending !== undefined) {
        return `<div class="feedback self">
          <div class="fb-title">🤔 모범 답안과 비교해서 직접 채점하세요</div>
          <div class="fb-line"><b>내 답</b> ${selfPending.trim() ? h(selfPending) : "(입력 없음)"}</div>
          ${answerBlock}
          <div class="row-btns">
            <button id="selfWrong" class="danger-btn">틀렸음</button>
            <button id="selfRight" class="primary-btn">맞았음</button>
          </div>
        </div>`;
      }
      const canOverride = !a.isCorrect && q.gradeMode === "text" && a.userAnswer.trim();
      return `<div class="feedback ${a.isCorrect ? "right" : "wrong"}">
        <div class="fb-title">${a.isCorrect ? "⭕ 정답" : "❌ 오답"}</div>
        ${!a.isCorrect ? `<div class="fb-line"><b>내 답</b> ${h(a.userAnswer) || "(모르겠음)"}</div>` : ""}
        ${answerBlock}
        ${canOverride ? `<button id="overrideBtn" class="link-btn">표기만 다르고 내 답도 맞아요 (정답 처리)</button>` : ""}
        <button id="nextBtn" class="primary-btn">${isLast ? "결과 보기" : "다음 문제"}</button>
      </div>`;
    }

    function draw(feedback) {
      const q = questions[idx];
      const shown = UI.show(`
        <header class="topbar">
          <button class="icon-btn" id="quitBtn" aria-label="시험 그만두기">✕</button>
          <h1>${h(session.title)}</h1>
          <span class="counter">${idx + 1} / ${questions.length}</span>
        </header>
        <main class="content">
          ${UI.progressBar(((idx + (feedback ? 1 : 0)) / questions.length) * 100, true)}
          <div class="q-meta">
            <span class="chip">${h(TL()[q.type] || q.type)}</span>
            <span class="chip muted">${h(Quiz.DIFFICULTY_LABELS[q.difficulty] || "")}</span>
            ${(q.importance || 3) >= 4 ? `<span class="imp imp-${q.importance}">${TextAnalysis.IMPORTANCE_LABELS[q.importance]}</span>` : ""}
            ${q.generator === "ai" ? `<span class="chip muted">AI</span>` : ""}
          </div>
          <div class="question-text">${h(q.question)}</div>
          <div id="answerArea" ${feedback ? "hidden" : ""}>${answerArea(q)}</div>
          <div id="feedbackArea">${feedback || ""}</div>
        </main>`);
      if (!shown) return;

      UI.on("#quitBtn", "click", async () => {
        const answered = answers.size;
        if (!confirm(`시험을 그만둘까요?\n지금까지 푼 ${answered}문제만 채점하고 나머지는 틀린 것으로 처리됩니다.`)) return;
        finish();
      });

      if (feedback) {
        bindFeedback(q);
        return;
      }

      const submit = async (userAnswer) => {
        const g = Quiz.grade(q, userAnswer);
        if (g.needsSelfGrade) {
          pendingSelfAnswer = userAnswer || "";
          draw(feedbackHtml(q, null, pendingSelfAnswer));
          return;
        }
        const rec = await Quiz.saveAnswer(sessionId, q, userAnswer, g.isCorrect, "auto");
        answers.set(q.id, rec);
        draw(feedbackHtml(q, rec));
      };

      UI.$all("[data-choice]").forEach((b) => b.addEventListener("click", () => submit(b.dataset.choice)));
      UI.$all("[data-choice-index]").forEach((b) =>
        b.addEventListener("click", () => submit(q.options[+b.dataset.choiceIndex]))
      );
      UI.on("#submitBtn", "click", () => {
        const v = UI.$("#answerInput").value;
        if (!v.trim()) return UI.$("#answerInput").focus();
        submit(v);
      });
      UI.on("#answerInput", "keydown", (e) => {
        if (e.key === "Enter" && e.target.tagName === "INPUT") UI.$("#submitBtn").click();
      });
      UI.on("#dontKnowBtn", "click", async () => {
        const rec = await Quiz.saveAnswer(sessionId, q, "", false, "auto");
        answers.set(q.id, rec);
        draw(feedbackHtml(q, rec));
      });
      const input = UI.$("#answerInput");
      if (input) input.focus();
    }

    function bindFeedback(q) {
      const self = async (ok) => {
        const rec = await Quiz.saveAnswer(sessionId, q, pendingSelfAnswer, ok, "self");
        answers.set(q.id, rec);
        draw(feedbackHtml(q, rec));
      };
      UI.on("#selfRight", "click", () => self(true));
      UI.on("#selfWrong", "click", () => self(false));
      UI.on("#overrideBtn", "click", async () => {
        const prev = answers.get(q.id);
        const rec = await Quiz.saveAnswer(sessionId, q, prev.userAnswer, true, "override");
        answers.set(q.id, rec);
        draw(feedbackHtml(q, rec));
      });
      UI.on("#nextBtn", "click", () => {
        if (idx >= questions.length - 1) return finish();
        idx++;
        draw();
      });
    }

    draw();
  }

  // ---------------------------------------------------------------------
  // 시험 결과
  // ---------------------------------------------------------------------
  async function renderResult(sessionId) {
    const detail = await QuizResult.getSessionDetail(sessionId);
    if (!detail) return UI.renderNotFound("시험 결과를 찾을 수 없습니다.", "/");
    const { session, rows, wrongRows } = detail;
    if (!session.finishedAt) return Router.replace(`/test/${sessionId}`);
    const back = session.scope === "words" ? `/subject/${session.subjectId}/words` : `/unit/${session.unitId}`;
    const delta = (session.pctAfter ?? 0) - (session.pctBefore ?? 0);

    const rowHtml = (r) => {
      const q = r.question;
      const a = r.answer;
      const ok = a && a.isCorrect;
      return `
        <li class="card result-row ${ok ? "right" : "wrong"}" data-ok="${ok ? 1 : 0}">
          <div class="row-head">
            <span class="card-title">문제 ${r.no} ${ok ? "⭕ 정답" : "❌ 오답"}</span>
            <span class="row-chips">${(q.importance || 3) >= 4 ? `<span class="imp imp-${q.importance}">${TextAnalysis.IMPORTANCE_LABELS[q.importance]}</span>` : ""}<span class="chip">${h(TL()[q.type] || q.type)}</span></span>
          </div>
          <div class="question-text small">${h(q.question)}</div>
          ${q.options && q.type === Quiz.TYPES.MC ? `<div class="card-sub">보기: ${q.options.map(h).join(" / ")}</div>` : ""}
          <div class="fb-line"><b>내 답</b> ${a ? h(a.userAnswer) || "(모르겠음)" : "(풀지 않음)"}${a && a.gradedBy === "self" ? " <span class='chip muted'>자기채점</span>" : ""}${a && a.gradedBy === "override" ? " <span class='chip muted'>정정</span>" : ""}</div>
          <div class="fb-line"><b>정답</b> ${h(q.answer)}</div>
          ${q.explanation ? `<div class="fb-line"><b>해설</b> ${h(q.explanation)}</div>` : ""}
          <div class="source-box">이 내용은 자료의 다음 부분을 기반으로 출제됨:<br/>“${h(q.sourceExcerpt)}”</div>
        </li>`;
    };

    const shown = UI.show(`
      ${UI.topBar("시험 결과", back)}
      <main class="content">
        <section class="result-hero">
          <div class="score">${session.scorePercent}<span>점</span></div>
          <div class="score-sub">${session.totalQuestions}문제 중 ${session.correctCount}문제 정답</div>
          <div class="score-stats">
            <div><b>${session.correctCount}</b><span>정답</span></div>
            <div><b>${session.totalQuestions - session.correctCount}</b><span>오답</span></div>
            <div><b>${session.pctBefore ?? 0}% → ${session.pctAfter ?? 0}%</b><span>학습률 변화 <em class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "+" : ""}${delta}%p</em></span></div>
          </div>
        </section>
        ${
          session.coreTotal
            ? `<div class="core-line">핵심·중요 내용 정답률 <b>${Math.round((session.coreCorrect / session.coreTotal) * 100)}%</b> (${session.coreCorrect}/${session.coreTotal}문제)</div>`
            : ""
        }
        ${(session.notes || []).map((n) => `<div class="banner warn">${h(n)}</div>`).join("")}
        ${
          session.quality && session.quality.built
            ? `<details class="panel slim"><summary>문제 품질 검증: ${session.quality.built}개 검사 · ${session.quality.rejected}개 폐기${
                session.quality.regenerated ? ` · ${session.quality.regenerated}개 AI 재생성` : ""
              }${session.quality.localFallback ? ` · ${session.quality.localFallback}개 기본 출제 대체` : ""}</summary>
              <ul class="plain-list">${Object.entries(session.quality.reasons || {})
                .map(([r, n]) => `<li>${h(r)} ${n}건</li>`)
                .join("") || "<li>폐기된 문제 없음</li>"}</ul>
              ${session.quality.skippedDetail ? `<p class="hint">세부(중요도 1) 내용 ${session.quality.skippedDetail}개는 이번 시험에서 빠졌고 다음 시험에 우선 출제됩니다.</p>` : ""}
            </details>`
            : ""
        }

        <div class="btn-grid">
          <button id="retryWrongBtn" class="primary-btn" ${wrongRows.length ? "" : "disabled"}>오답 다시 풀기${wrongRows.length ? ` (${wrongRows.length})` : ""}</button>
          <button id="againBtn" class="secondary-btn">다시 시험 보기</button>
        </div>

        <div class="tabs">
          <button class="tab active" data-filter="all">전체 ${rows.length}</button>
          <button class="tab" data-filter="wrong">틀린 문제만 ${wrongRows.length}</button>
        </div>
        <ul class="card-list" id="resultList">${rows.map(rowHtml).join("")}</ul>
        <button class="secondary-btn full" data-back="${back}">돌아가기</button>
      </main>`);
    if (!shown) return;
    UI.bindCommon();

    UI.$all("[data-filter]").forEach((tab) =>
      tab.addEventListener("click", () => {
        UI.$all("[data-filter]").forEach((t) => t.classList.toggle("active", t === tab));
        const onlyWrong = tab.dataset.filter === "wrong";
        UI.$all(".result-row").forEach((li) => (li.hidden = onlyWrong && li.dataset.ok === "1"));
      })
    );
    UI.on("#retryWrongBtn", "click", async () => {
      const targetIds = await QuizResult.wrongTargetIds(sessionId);
      startTest({
        scope: session.scope,
        subjectId: session.subjectId,
        unitId: session.unitId,
        targetIds,
        mode: "wrong-retry",
        parentSessionId: sessionId,
      });
    });
    UI.on("#againBtn", "click", () =>
      startTest({ scope: session.scope, subjectId: session.subjectId, unitId: session.unitId })
    );
  }

  // ---------------------------------------------------------------------
  // 학습하기 (플래시카드): 떠올려 보고 → 확인 → 알았음/몰랐음
  // 시험보다 약하게(절반) 학습 정도에 반영된다.
  // ---------------------------------------------------------------------
  async function renderStudy({ scope, subjectId, unitId }) {
    let back;
    let targets;
    let store;
    if (scope === "words") {
      back = `/subject/${subjectId}/words`;
      targets = await WordStudy.list(subjectId);
      store = "wordItems";
    } else {
      const unit = await Units.get(unitId);
      if (!unit) return UI.renderNotFound("단원을 찾을 수 없습니다.", "/");
      back = `/unit/${unitId}`;
      UI.loadingScreen("학습하기", "암기 포인트를 준비하는 중…");
      targets = (await Learning.refreshUnitPoints(unitId, { useAi: Ai.isConfigured() })).points;
      store = "points";
    }
    if (!targets.length) return UI.renderNotFound("학습할 내용이 없습니다. 먼저 자료나 단어를 추가하세요.", back);

    // 학습 정도가 낮은 것부터 (약간의 랜덤) 최대 20장
    // 학습 정도가 낮고 중요한 것부터 (약간의 랜덤) 최대 20장
    const deck = targets
      .map((t) => ({ t, k: (t.studyLevel || 0) - (t.importance || 3) * 8 + Math.random() * 25 }))
      .sort((a, b) => a.k - b.k)
      .slice(0, 20)
      .map((x) => x.t);
    let i = 0;
    let known = 0;
    let unknown = 0;

    function cardFaces(t) {
      if (scope === "words") {
        const reverse = Math.random() < 0.4;
        return reverse
          ? { front: t.definition, frontHint: "이 뜻에 해당하는 단어는?", back: t.term, source: t.sourceExcerpt }
          : { front: t.term, frontHint: "뜻을 떠올려 보세요", back: t.definition, source: t.sourceExcerpt };
      }
      if (t.answer && t.blankText && t.blankText.includes(TextAnalysis.BLANK)) {
        return {
          front: t.blankText,
          frontHint: "[      ]에 들어갈 핵심어를 떠올려 보세요",
          back: t.answer, // 정답은 핵심어만
          backContext: t.text,
          source: t.sourceExcerpt,
        };
      }
      return { front: t.text, frontHint: "내용을 소리 내어 읽고 기억해 보세요", back: t.text, source: t.sourceExcerpt };
    }

    function draw() {
      if (i >= deck.length) return drawEnd();
      const t = deck[i];
      const f = cardFaces(t);
      const shown = UI.show(`
        ${UI.topBar(scope === "words" ? "단어 학습하기" : "내용 학습하기", back, `<span class="counter">${i + 1} / ${deck.length}</span>`)}
        <main class="content">
          ${UI.progressBar((i / deck.length) * 100, true)}
          <div class="flashcard" id="card">
            <div class="fc-hint">${h(f.frontHint)}</div>
            <div class="fc-front">${h(f.front)}</div>
            <div class="fc-back" hidden>
              <div class="fc-answer">${h(f.back)}</div>
              ${f.backContext ? `<div class="source-mini">${h(f.backContext)}</div>` : ""}
              ${f.source && Utils.normalizeText(f.source) !== Utils.normalizeText(f.back) ? `<div class="source-mini">근거: “${h(f.source)}”</div>` : ""}
            </div>
            <div class="fc-level">현재 학습 정도 ${Math.round(t.studyLevel || 0)}%</div>
          </div>
          <button id="flipBtn" class="primary-btn">정답 확인</button>
          <div class="row-btns" id="judgeBtns" hidden>
            <button id="unknownBtn" class="danger-btn">몰랐음</button>
            <button id="knownBtn" class="primary-btn">알았음</button>
          </div>
        </main>`);
      if (!shown) return;
      UI.bindCommon();
      const flip = () => {
        UI.$(".fc-back").hidden = false;
        UI.$("#flipBtn").hidden = true;
        UI.$("#judgeBtns").hidden = false;
      };
      UI.on("#flipBtn", "click", flip);
      UI.on("#card", "click", flip);
      const judge = async (ok) => {
        const fresh = (await Storage.get(store, t.id)) || t;
        Learning.applyResult(fresh, ok, 0.5);
        await Storage.put(store, fresh);
        ok ? known++ : unknown++;
        i++;
        draw();
      };
      UI.on("#knownBtn", "click", () => judge(true));
      UI.on("#unknownBtn", "click", () => judge(false));
    }

    async function drawEnd() {
      const pct =
        scope === "words" ? (await Learning.wordProgress(subjectId)).pct : (await Learning.unitProgress(unitId)).pct;
      const shown = UI.show(`
        ${UI.topBar("학습 완료", back)}
        <main class="content">
          <section class="result-hero">
            <div class="score">${known}<span> / ${deck.length}</span></div>
            <div class="score-sub">알았음 ${known} · 몰랐음 ${unknown}</div>
            <div class="score-sub">현재 학습률 ${pct}%</div>
          </section>
          <div class="btn-grid">
            <button id="againStudy" class="secondary-btn">한 번 더 학습</button>
            <button id="goTest" class="primary-btn">시험 시작</button>
          </div>
          <button class="secondary-btn full" data-back="${back}">돌아가기</button>
        </main>`);
      if (!shown) return;
      UI.bindCommon();
      UI.on("#againStudy", "click", () => renderStudy({ scope, subjectId, unitId }));
      UI.on("#goTest", "click", async () => {
        const sid = scope === "words" ? subjectId : (await Units.get(unitId)).subjectId;
        startTest({ scope, subjectId: sid, unitId });
      });
    }

    draw();
  }

  return { startTest, renderTest, renderResult, renderStudy };
})();
