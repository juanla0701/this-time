// ui.js
// 화면 렌더링 (메인·과목·단어 암기·내용 암기·단원·자료·요약·설정).
// 학습하기/시험/결과 화면은 uiQuiz.js에 있다.
// 프레임워크 없이 innerHTML + 이벤트 연결 방식. 화면 전환 시 해당 화면을 다시 그린다.
window.UI = (function () {
  const h = (s) => Utils.escapeHtml(s);
  const root = () => document.getElementById("app");

  // ---------------------------------------------------------------------
  // 공통: 화면 출력, 사진 URL 관리, 조각들
  // ---------------------------------------------------------------------
  let screenHash = null; // 이 화면이 그려질 때의 주소. 다른 화면으로 떠났으면 늦게 끝난 작업이 덮어쓰지 않게.
  let currentUrls = [];
  let nextUrls = [];

  function objUrl(blob) {
    const url = URL.createObjectURL(blob);
    nextUrls.push(url);
    return url;
  }

  // 다음 화면 상단에 한 번만 보여줄 안내 (예: "분석 완료 · 핵심 3개")
  let pendingFlash = [];
  function flash(message, kind) {
    pendingFlash.push({ message, kind: kind || "ok" });
  }

  function show(html) {
    if (screenHash !== null && window.location.hash !== screenHash && !(screenHash === "" && window.location.hash === "#/")) {
      nextUrls.forEach((u) => URL.revokeObjectURL(u));
      nextUrls = [];
      return false;
    }
    currentUrls.forEach((u) => URL.revokeObjectURL(u));
    currentUrls = nextUrls;
    nextUrls = [];
    if (pendingFlash.length && /<main class="content">/.test(html)) {
      const banners = pendingFlash.map((f) => `<div class="banner ${f.kind} flash">${h(f.message)}</div>`).join("");
      html = html.replace('<main class="content">', `<main class="content">${banners}`);
      pendingFlash = [];
    }
    root().innerHTML = html;
    window.scrollTo(0, 0);
    return true;
  }

  function $(sel) {
    return root().querySelector(sel);
  }
  function $all(sel) {
    return Array.from(root().querySelectorAll(sel));
  }
  function on(sel, event, fn) {
    const el = $(sel);
    if (el) el.addEventListener(event, fn);
  }

  function topBar(title, backPath, right) {
    return `
      <header class="topbar">
        ${backPath !== null ? `<button class="icon-btn" data-back="${h(backPath)}" aria-label="뒤로">←</button>` : `<span class="icon-btn-spacer"></span>`}
        <h1>${h(title)}</h1>
        ${right || `<span class="icon-btn-spacer"></span>`}
      </header>`;
  }

  function bindCommon() {
    $all("[data-back]").forEach((btn) => btn.addEventListener("click", () => Router.navigate(btn.dataset.back)));
    $all("[data-go]").forEach((el) =>
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-stop]")) return;
        Router.navigate(el.dataset.go);
      })
    );
  }

  function progressBar(pct, small) {
    const p = Utils.clamp(Math.round(pct || 0), 0, 100);
    const level = p >= 80 ? "high" : p >= 40 ? "mid" : "low";
    return `<div class="progress ${small ? "small" : ""}" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-fill ${level}" style="width:${p}%"></div></div>`;
  }

  function aiBanner(context) {
    if (Ai.isConfigured()) return "";
    const msg =
      context === "word"
        ? "AI 연결 필요 · 사진/글에서 단어를 자동 정리할 때는 기본 형식(용어: 뜻)만 인식합니다. 단어 시험은 AI 없이도 정상 동작합니다."
        : "AI 연결 필요 · 지금은 자료 문장을 그대로 활용하는 기본 출제 모드입니다. AI를 연결하면 요약과 문제 표현이 더 다양해집니다.";
    return `<div class="banner"><span>${h(msg)}</span> <button class="link-btn" data-go="/settings">설정</button></div>`;
  }

  function lastStudyText(stat) {
    if (!stat.lastStudiedAt && !stat.lastSession) return "아직 학습 기록 없음";
    const parts = [];
    if (stat.lastStudiedAt) parts.push(`마지막 학습 ${Utils.timeAgo(stat.lastStudiedAt)}`);
    if (stat.lastSession) parts.push(`최근 시험 ${stat.lastSession.scorePercent}점`);
    return parts.join(" · ");
  }

  function showError(err) {
    console.error(err);
    alert(err && err.message ? err.message : String(err));
  }

  function loadingScreen(title, text) {
    show(`
      ${topBar(title, null)}
      <main class="content center">
        <div class="spinner"></div>
        <p id="loadingText">${h(text || "잠시만 기다려주세요…")}</p>
      </main>`);
  }

  function setLoadingText(text) {
    const el = document.getElementById("loadingText");
    if (el) el.textContent = text;
  }

  // ---------------------------------------------------------------------
  // 메인: 과목 목록 + 학습률
  // ---------------------------------------------------------------------
  async function renderHome() {
    const subjects = await Subjects.list();
    const stats = [];
    for (const s of subjects) stats.push(await Learning.subjectProgress(s.id));

    const shown = show(`
      <header class="topbar home">
        <span class="icon-btn-spacer"></span>
        <h1>암기 도우미</h1>
        <button class="icon-btn" data-go="/settings" aria-label="설정">⚙</button>
      </header>
      <main class="content">
        <button id="toggleAddSubject" class="primary-btn">+ 과목 추가</button>
        <div id="addSubjectForm" class="add-form" hidden>
          <input id="newSubjectName" type="text" placeholder="과목 이름 (예: 해부학, 한국사, 영어 단어)" />
          <div class="row-btns">
            <button id="cancelSubjectBtn" class="secondary-btn">취소</button>
            <button id="addSubjectBtn" class="primary-btn">추가</button>
          </div>
        </div>
        ${
          subjects.length === 0
            ? `<p class="empty">아직 과목이 없습니다.<br/>“+ 과목 추가”로 공부할 과목을 만들어보세요.</p>`
            : `<ul class="card-list">
                ${subjects
                  .map((s, i) => {
                    const st = stats[i];
                    return `
                  <li class="card subject-card" data-go="/subject/${s.id}">
                    <div class="card-head">
                      <span class="card-title">${h(s.name)}</span>
                      <span class="pct">${st.pct}%</span>
                    </div>
                    ${progressBar(st.pct)}
                    <div class="card-meta">
                      <span>자료 ${st.materialCount}개${st.wordCount ? ` · 단어 ${st.wordCount}개` : ""}</span>
                      <span>${h(lastStudyText(st))}</span>
                    </div>
                    <button class="delete-mini" data-stop data-delete-subject="${s.id}" data-name="${h(s.name)}" aria-label="과목 삭제">삭제</button>
                  </li>`;
                  })
                  .join("")}
              </ul>`
        }
      </main>
    `);
    if (!shown) return;
    bindCommon();

    const form = $("#addSubjectForm");
    on("#toggleAddSubject", "click", () => {
      form.hidden = false;
      $("#toggleAddSubject").hidden = true;
      $("#newSubjectName").focus();
    });
    on("#cancelSubjectBtn", "click", () => {
      form.hidden = true;
      $("#toggleAddSubject").hidden = false;
    });
    const add = async () => {
      const name = $("#newSubjectName").value.trim();
      if (!name) return;
      await Subjects.create(name);
      renderHome();
    };
    on("#addSubjectBtn", "click", add);
    on("#newSubjectName", "keydown", (e) => e.key === "Enter" && add());

    $all("[data-delete-subject]").forEach((btn) =>
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = confirm(
          `‘${btn.dataset.name}’ 과목을 삭제할까요?\n\n이 과목의 단원·자료·사진·단어·문제·시험 기록·학습 기록이 모두 삭제되며 되돌릴 수 없습니다.`
        );
        if (!ok) return;
        try {
          await Subjects.remove(btn.dataset.deleteSubject);
        } catch (err) {
          showError(err);
        }
        renderHome();
      })
    );
  }

  // ---------------------------------------------------------------------
  // 과목: 학습 방식 선택 (단어 암기 / 내용 암기)
  // ---------------------------------------------------------------------
  async function renderSubject(subjectId) {
    const subject = await Subjects.get(subjectId);
    if (!subject) return renderNotFound("과목을 찾을 수 없습니다.", "/");
    const st = await Learning.subjectProgress(subjectId);
    const contentPct = (() => {
      const lv = st.unitStats.filter((u) => u.pointCount || u.materialCount).map((u) => u.pct);
      return lv.length ? Math.round(Utils.average(lv)) : 0;
    })();

    const shown = show(`
      ${topBar(subject.name, "/", `<button class="icon-btn" id="renameSubject" aria-label="과목 이름 수정">✏</button>`)}
      <main class="content">
        <section class="overall">
          <div class="card-head"><span>과목 전체 학습률</span><span class="pct big">${st.pct}%</span></div>
          ${progressBar(st.pct)}
          <div class="card-meta"><span>${h(lastStudyText(st))}</span></div>
        </section>

        <button class="mode-card" data-go="/subject/${subjectId}/words">
          <div class="mode-icon">🔤</div>
          <div class="mode-body">
            <div class="mode-title">단어 암기</div>
            <div class="mode-desc">용어와 뜻을 짧게 외우기 · 단어 ${st.wordCount}개</div>
            ${progressBar(st.words.pct, true)}
          </div>
          <div class="mode-pct">${st.words.pct}%</div>
        </button>

        <button class="mode-card" data-go="/subject/${subjectId}/content">
          <div class="mode-icon">📚</div>
          <div class="mode-body">
            <div class="mode-title">내용 암기</div>
            <div class="mode-desc">단원별 사진·글 자료로 공부하고 시험 보기 · 단원 ${st.unitCount}개</div>
            ${progressBar(contentPct, true)}
          </div>
          <div class="mode-pct">${contentPct}%</div>
        </button>
      </main>
    `);
    if (!shown) return;
    bindCommon();
    on("#renameSubject", "click", async () => {
      const name = prompt("과목 이름", subject.name);
      if (name && name.trim()) {
        await Subjects.rename(subjectId, name);
        renderSubject(subjectId);
      }
    });
  }

  // ---------------------------------------------------------------------
  // 단어 암기
  // ---------------------------------------------------------------------
  async function renderWords(subjectId) {
    const subject = await Subjects.get(subjectId);
    if (!subject) return renderNotFound("과목을 찾을 수 없습니다.", "/");
    const [items, wp, wrongIds, wordMaterials] = await Promise.all([
      WordStudy.list(subjectId),
      Learning.wordProgress(subjectId),
      WrongAnswers.listWrongTargetIds({ subjectId }),
      Materials.listWordMaterials(subjectId),
    ]);
    const wrongCount = wrongIds.filter((id) => items.some((i) => i.id === id)).length;

    const shown = show(`
      ${topBar(`${subject.name} · 단어 암기`, `/subject/${subjectId}`)}
      <main class="content">
        <section class="overall">
          <div class="card-head"><span>단어 학습률 · ${items.length}개</span><span class="pct big">${wp.pct}%</span></div>
          ${progressBar(wp.pct)}
        </section>

        <div class="btn-grid">
          <button id="studyBtn" class="secondary-btn" ${items.length ? "" : "disabled"}>학습하기</button>
          <button id="testBtn" class="primary-btn" ${items.length ? "" : "disabled"}>시험 시작</button>
          <button id="wrongBtn" class="secondary-btn wide" ${wrongCount ? "" : "disabled"}>오답 다시 풀기${wrongCount ? ` (${wrongCount})` : ""}</button>
        </div>

        <section class="panel">
          <h2 class="panel-title">단어 추가</h2>
          <input id="termInput" type="text" placeholder="단어/용어 (예: 대퇴골)" />
          <textarea id="defInput" rows="2" placeholder="뜻/설명 (예: 인체에서 가장 긴 뼈)"></textarea>
          <p id="wordError" class="error-msg"></p>
          <button id="addWordBtn" class="primary-btn">+ 단어 추가</button>
          <div class="row-btns top-gap">
            <button class="secondary-btn" data-go="/subject/${subjectId}/words/add-photo">+ 사진 추가</button>
            <button class="secondary-btn" data-go="/subject/${subjectId}/words/add-text">+ 글 추가</button>
          </div>
          <p class="hint">사진·글로 추가하면 “용어: 뜻”, “용어 → 뜻”, “용어 - 뜻” 형식의 줄을 단어로 정리합니다.</p>
        </section>

        <h2 class="section-label">단어 목록</h2>
        ${
          items.length === 0
            ? `<p class="empty">아직 단어가 없습니다.</p>`
            : `<ul class="card-list" id="wordList">
            ${items
              .map(
                (it) => `
              <li class="card word-row" data-word-id="${it.id}">
                <div class="word-view">
                  <div class="card-head">
                    <span class="card-title">${h(it.term)}</span>
                    <span class="pct small">${Math.round(it.studyLevel || 0)}%</span>
                  </div>
                  <div class="word-def">${h(it.definition)}</div>
                  ${progressBar(it.studyLevel || 0, true)}
                  <div class="row-actions">
                    <button class="link-btn" data-edit-word="${it.id}">수정</button>
                    <button class="link-btn danger" data-delete-word="${it.id}">삭제</button>
                  </div>
                </div>
              </li>`
              )
              .join("")}
          </ul>`
        }
        ${
          wordMaterials.length
            ? `<h2 class="section-label">가져온 자료</h2>
          <ul class="card-list">${wordMaterials
            .map(
              (m) => `<li class="card" data-go="/material/${m.id}">
                <div class="card-title">${h(m.title)}</div>
                <div class="card-sub">${m.type === "PHOTO" ? "사진 자료" : "글 자료"} · ${Utils.formatDate(m.createdAt)}</div>
              </li>`
            )
            .join("")}</ul>`
            : ""
        }
      </main>
    `);
    if (!shown) return;
    bindCommon();

    on("#addWordBtn", "click", async () => {
      const term = $("#termInput").value.trim();
      const definition = $("#defInput").value.trim();
      if (!term || !definition) {
        $("#wordError").textContent = "단어와 뜻을 모두 입력해주세요.";
        return;
      }
      await WordStudy.create({ subjectId, term, definition });
      renderWords(subjectId);
    });
    on("#studyBtn", "click", () => Router.navigate(`/study/words/${subjectId}`));
    on("#testBtn", "click", () => UIQuiz.startTest({ scope: "words", subjectId }));
    on("#wrongBtn", "click", () =>
      UIQuiz.startTest({ scope: "words", subjectId, targetIds: wrongIds, mode: "wrong-retry" })
    );

    $all("[data-delete-word]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("이 단어를 삭제할까요? 학습 기록도 함께 삭제됩니다.")) return;
        await WordStudy.remove(btn.dataset.deleteWord);
        renderWords(subjectId);
      })
    );
    $all("[data-edit-word]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.dataset.editWord;
        const it = items.find((i) => i.id === id);
        const li = root().querySelector(`[data-word-id="${id}"]`);
        li.innerHTML = `
          <input class="edit-term" type="text" value="${h(it.term)}" />
          <textarea class="edit-def" rows="2">${h(it.definition)}</textarea>
          <div class="row-btns">
            <button class="secondary-btn" data-cancel>취소</button>
            <button class="primary-btn" data-save>저장</button>
          </div>`;
        li.querySelector("[data-cancel]").addEventListener("click", () => renderWords(subjectId));
        li.querySelector("[data-save]").addEventListener("click", async () => {
          const term = li.querySelector(".edit-term").value.trim();
          const definition = li.querySelector(".edit-def").value.trim();
          if (!term || !definition) return;
          await WordStudy.update(id, { term, definition });
          renderWords(subjectId);
        });
      })
    );
  }

  /** 사진/글 자료에서 단어 항목을 뽑아 사용자가 확인·수정 후 저장하는 화면. */
  async function renderWordReview(subjectId, materialId) {
    const material = await Materials.get(materialId);
    if (!material) return renderNotFound("자료를 찾을 수 없습니다.", `/subject/${subjectId}/words`);
    loadingScreen("단어 정리", Ai.isConfigured() ? "AI가 자료에서 단어와 뜻을 정리하는 중…" : "자료에서 단어와 뜻을 찾는 중…");

    let result;
    try {
      result = await WordStudy.extractItems(Materials.textOf(material));
    } catch (err) {
      result = { ...WordStudy.parseItemsLocal(Materials.textOf(material)), origin: "local", aiError: err.message };
    }
    let rows = result.items.map((i) => ({ ...i }));
    const unparsed = result.unparsed || [];

    function draw() {
      const shown = show(`
        ${topBar("단어 확인", `/subject/${subjectId}/words`)}
        <main class="content">
          <p class="hint">‘${h(material.title)}’에서 찾은 단어입니다. 틀린 부분은 고치고, 필요 없는 줄은 지운 뒤 저장하세요.
          ${result.origin === "ai" ? "(AI 정리 · 근거 검증 통과분만 표시)" : "(기본 형식 인식)"}</p>
          ${result.aiError ? `<p class="error-msg">AI 정리 실패: ${h(result.aiError)} → 기본 방식으로 정리했습니다.</p>` : ""}
          <ul class="card-list">
            ${rows
              .map(
                (r, i) => `
              <li class="card review-row">
                <div class="row-head"><span class="chip">${i + 1}</span><button class="link-btn danger" data-remove-row="${i}">삭제</button></div>
                <input type="text" data-term="${i}" value="${h(r.term)}" placeholder="단어/용어" />
                <textarea rows="2" data-def="${i}" placeholder="뜻/설명">${h(r.definition)}</textarea>
                ${r.sourceExcerpt ? `<div class="source-mini">근거: ${h(r.sourceExcerpt)}</div>` : ""}
              </li>`
              )
              .join("")}
          </ul>
          <button id="addRowBtn" class="secondary-btn full">+ 직접 한 줄 추가</button>
          ${
            unparsed.length
              ? `<details class="panel top-gap"><summary>형식을 인식하지 못한 줄 ${unparsed.length}개</summary>
                  <ul class="plain-list">${unparsed
                    .map((u, i) => `<li><span>${h(u)}</span> <button class="link-btn" data-use-line="${i}">단어로 추가</button></li>`)
                    .join("")}</ul></details>`
              : ""
          }
          <p id="reviewError" class="error-msg"></p>
          <button id="saveItemsBtn" class="primary-btn">단어 ${rows.length}개 저장</button>
        </main>`);
      if (!shown) return;
      bindCommon();
      $all("[data-term]").forEach((el) => el.addEventListener("input", () => (rows[+el.dataset.term].term = el.value)));
      $all("[data-def]").forEach((el) => el.addEventListener("input", () => (rows[+el.dataset.def].definition = el.value)));
      $all("[data-remove-row]").forEach((el) =>
        el.addEventListener("click", () => {
          rows.splice(+el.dataset.removeRow, 1);
          draw();
        })
      );
      on("#addRowBtn", "click", () => {
        rows.push({ term: "", definition: "", sourceExcerpt: "" });
        draw();
      });
      $all("[data-use-line]").forEach((el) =>
        el.addEventListener("click", () => {
          const line = unparsed.splice(+el.dataset.useLine, 1)[0];
          rows.push({ term: line, definition: "", sourceExcerpt: line });
          draw();
        })
      );
      on("#saveItemsBtn", "click", async () => {
        const valid = rows.filter((r) => r.term.trim() && r.definition.trim());
        if (!valid.length) {
          $("#reviewError").textContent = "저장할 단어가 없습니다. 단어와 뜻을 모두 입력해주세요.";
          return;
        }
        // 사용자가 직접 추가/수정한 줄은 그 내용 자체를 근거로 남긴다.
        const prepared = valid.map((r) => {
          const src = Materials.textOf(material);
          const ok = r.sourceExcerpt && Ai.validateExcerpt(r.sourceExcerpt, src);
          return { term: r.term, definition: r.definition, sourceExcerpt: ok ? r.sourceExcerpt : `${r.term.trim()} → ${r.definition.trim()}` };
        });
        await WordStudy.createMany(subjectId, prepared, materialId);
        Router.navigate(`/subject/${subjectId}/words`);
      });
    }
    draw();
  }

  // ---------------------------------------------------------------------
  // 내용 암기: 단원 목록
  // ---------------------------------------------------------------------
  async function renderContent(subjectId) {
    const subject = await Subjects.get(subjectId);
    if (!subject) return renderNotFound("과목을 찾을 수 없습니다.", "/");
    const units = await Units.listBySubject(subjectId);
    const stats = [];
    for (const u of units) stats.push(await Learning.unitProgress(u.id));

    const shown = show(`
      ${topBar(`${subject.name} · 내용 암기`, `/subject/${subjectId}`)}
      <main class="content">
        ${aiBanner("content")}
        <div class="add-row">
          <input id="newUnitName" type="text" placeholder="새 단원 이름 (예: 1단원. 뼈)" />
          <button id="addUnitBtn" class="primary-btn narrow">+ 단원 추가</button>
        </div>
        ${
          units.length === 0
            ? `<p class="empty">아직 단원이 없습니다. 단원을 만들고 사진이나 글 자료를 넣어보세요.</p>`
            : `<ul class="card-list">
                ${units
                  .map((u, i) => {
                    const st = stats[i];
                    return `
                  <li class="card subject-card" data-go="/unit/${u.id}">
                    <div class="card-head"><span class="card-title">${h(u.name)}</span><span class="pct">${st.pct}%</span></div>
                    ${progressBar(st.pct)}
                    <div class="card-meta">
                      <span>자료 ${st.materialCount}개 · 암기 포인트 ${st.pointCount}개</span>
                      <span>${h(lastStudyText(st))}</span>
                    </div>
                    <div class="row-actions" data-stop>
                      <button class="link-btn" data-stop data-rename-unit="${u.id}" data-name="${h(u.name)}">이름 수정</button>
                      <button class="link-btn danger" data-stop data-delete-unit="${u.id}" data-name="${h(u.name)}">삭제</button>
                    </div>
                  </li>`;
                  })
                  .join("")}
              </ul>`
        }
      </main>
    `);
    if (!shown) return;
    bindCommon();

    const add = async () => {
      const name = $("#newUnitName").value.trim();
      if (!name) return;
      await Units.create(subjectId, name);
      renderContent(subjectId);
    };
    on("#addUnitBtn", "click", add);
    on("#newUnitName", "keydown", (e) => e.key === "Enter" && add());
    $all("[data-rename-unit]").forEach((btn) =>
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = prompt("단원 이름", btn.dataset.name);
        if (name && name.trim()) {
          await Units.rename(btn.dataset.renameUnit, name);
          renderContent(subjectId);
        }
      })
    );
    $all("[data-delete-unit]").forEach((btn) =>
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`‘${btn.dataset.name}’ 단원을 삭제할까요?\n단원의 자료·사진·시험 기록·학습 기록이 모두 삭제됩니다.`)) return;
        await Units.remove(btn.dataset.deleteUnit);
        renderContent(subjectId);
      })
    );
  }

  // ---------------------------------------------------------------------
  // 단원: 자료 + 학습하기 / 시험 시작 / 요약본 / 오답 다시 풀기
  // ---------------------------------------------------------------------
  async function renderUnit(unitId) {
    const unit = await Units.get(unitId);
    if (!unit) return renderNotFound("단원을 찾을 수 없습니다.", "/");
    const [materials, st, wrongIds, sessions] = await Promise.all([
      Materials.listByUnit(unitId),
      Learning.unitProgress(unitId),
      WrongAnswers.listWrongTargetIds({ unitId }),
      Quiz.listSessionsByUnit(unitId),
    ]);
    const points = await Storage.getAllByIndex("points", "unitId", unitId);
    const wrongCount = wrongIds.filter((id) => points.some((p) => p.id === id)).length;
    const recent = sessions.filter((s) => s.finishedAt).slice(0, 3);
    const has = materials.length > 0;

    const shown = show(`
      ${topBar(unit.name, `/subject/${unit.subjectId}/content`)}
      <main class="content">
        ${aiBanner("content")}
        <section class="overall">
          <div class="card-head"><span>단원 학습률 · 암기 포인트 ${st.pointCount}개</span><span class="pct big">${st.pct}%</span></div>
          ${progressBar(st.pct)}
          ${
            st.pointCount
              ? `<div class="imp-row">${[5, 4, 3, 2, 1]
                  .filter((k) => st.byImportance[k])
                  .map((k) => `<span class="imp imp-${k}">${TextAnalysis.IMPORTANCE_LABELS[k]} ${st.byImportance[k]}</span>`)
                  .join("")}${st.corePct !== null ? `<span class="imp-core">핵심·중요 학습률 ${st.corePct}%</span>` : ""}</div>`
              : ""
          }
          <div class="card-meta"><span>${h(lastStudyText(st))}</span></div>
        </section>

        <div class="btn-grid">
          <button id="studyBtn" class="secondary-btn" ${has ? "" : "disabled"}>학습하기</button>
          <button id="testBtn" class="primary-btn" ${has ? "" : "disabled"}>시험 시작</button>
          <button id="summaryBtn" class="secondary-btn" ${has ? "" : "disabled"}>요약본</button>
          <button id="wrongBtn" class="secondary-btn" ${wrongCount ? "" : "disabled"}>오답 다시 풀기${wrongCount ? ` (${wrongCount})` : ""}</button>
        </div>

        <h2 class="section-label">자료 ${materials.length}개</h2>
        <div class="row-btns">
          <button class="secondary-btn" data-go="/unit/${unitId}/add-photo">+ 사진 추가</button>
          <button class="secondary-btn" data-go="/unit/${unitId}/add-text">+ 글 추가</button>
        </div>
        ${
          materials.length === 0
            ? `<p class="empty">아직 자료가 없습니다. 교재·프린트 사진이나 글을 추가하세요.</p>`
            : `<ul class="card-list top-gap">
                ${materials
                  .map((m) => {
                    const mp = points.filter((p) => p.materialId === m.id);
                    return `
                  <li class="card" data-go="/material/${m.id}">
                    <div class="card-title">${h(m.title)}</div>
                    <div class="card-sub">${m.type === "PHOTO" ? `사진 ${(m.imageIds || []).length || ""}장` : "글 자료"} · 암기 포인트 ${mp.length}개${
                      m.aiCorrection && m.aiCorrection.uncertain && m.aiCorrection.uncertain.length
                        ? ` · <span class="warn-text">⚠️ 확인 필요 ${m.aiCorrection.uncertain.length}곳</span>`
                        : ""
                    }</div>
                    <div class="card-preview">${h(Utils.truncate(Materials.textOf(m), 80))}</div>
                  </li>`;
                  })
                  .join("")}
              </ul>`
        }

        ${
          recent.length
            ? `<h2 class="section-label">최근 시험</h2>
          <ul class="card-list">${recent
            .map(
              (s) => `<li class="card" data-go="/result/${s.id}">
                <div class="card-head"><span class="card-title">${s.scorePercent}점</span><span class="card-sub">${Utils.timeAgo(s.finishedAt)}</span></div>
                <div class="card-sub">${s.correctCount}/${s.totalQuestions} 정답${s.mode === "wrong-retry" ? " · 오답 다시 풀기" : ""}</div>
              </li>`
            )
            .join("")}</ul>`
            : ""
        }
      </main>
    `);
    if (!shown) return;
    bindCommon();
    on("#studyBtn", "click", () => Router.navigate(`/study/unit/${unitId}`));
    on("#summaryBtn", "click", () => Router.navigate(`/unit/${unitId}/summary`));
    on("#testBtn", "click", () => UIQuiz.startTest({ scope: "unit", subjectId: unit.subjectId, unitId }));
    on("#wrongBtn", "click", () =>
      UIQuiz.startTest({ scope: "unit", subjectId: unit.subjectId, unitId, targetIds: wrongIds, mode: "wrong-retry" })
    );
  }

  // ---------------------------------------------------------------------
  // 저장 직후 자동 분석: 중요 내용 추출 → 요약 생성 → 시험 준비 (사진 한 장으로 최대한 자동 처리)
  // ---------------------------------------------------------------------
  async function autoAnalyze(unitId) {
    const useAi = Ai.isConfigured();
    loadingScreen("자료 분석", useAi ? "AI가 내용 구조를 분석하고 중요 내용을 추출하는 중…" : "중요 내용을 추출하는 중…");
    let points = [];
    let aiFailed = false;
    try {
      const r = await Learning.refreshUnitPoints(unitId, { useAi });
      points = r.points;
      aiFailed = useAi && r.aiErrors.length > 0;
    } catch (err) {
      console.warn("자동 분석 실패:", err);
    }
    setLoadingText("요약본을 만드는 중…");
    let summaryOk = false;
    try {
      const g = await Summary.generate(unitId);
      summaryOk = true;
      if (g.fellBack) aiFailed = true;
    } catch (err) {
      console.warn("요약 자동 생성 실패:", err);
    }
    const core = points.filter((p) => (p.importance || 3) >= 5).length;
    const important = points.filter((p) => (p.importance || 3) === 4).length;
    flash(
      `분석 완료 · 암기 포인트 ${points.length}개 (핵심 ${core} · 중요 ${important})${summaryOk ? " · 요약본 준비됨" : ""} → 바로 시험을 볼 수 있습니다.`,
      "ok"
    );
    if (aiFailed) flash("AI 분석을 사용할 수 없어 기본 분석으로 생성했습니다.", "warn");
  }

  async function afterMaterialSaved(ctx, material) {
    if (ctx.studyMode === "content" && material.unitId) await autoAnalyze(material.unitId);
    Router.navigate(ctx.afterSave(material));
  }

  // ---------------------------------------------------------------------
  // 글로 자료 추가 (내용 암기 단원 / 단어 암기 공용)
  // ctx: { subjectId, unitId, studyMode, backPath, afterSave(material) }
  // ---------------------------------------------------------------------
  function renderAddText(ctx) {
    const shown = show(`
      ${topBar("+ 글 추가", ctx.backPath)}
      <main class="content">
        <input id="materialTitle" type="text" placeholder="자료 제목 (예: 한국사 1단원, 심장의 구조)" />
        <textarea id="materialText" rows="14" placeholder="${
          ctx.studyMode === "word"
            ? "한 줄에 하나씩 입력하세요.\n예)\n대퇴골: 인체에서 가장 긴 뼈\n해마 → 기억 형성에 중요한 뇌 구조"
            : "학습 자료 내용을 입력하세요. 긴 시험범위도 그대로 붙여넣을 수 있습니다."
        }"></textarea>
        <p id="errorMsg" class="error-msg"></p>
        <button id="saveBtn" class="primary-btn">자료 저장</button>
      </main>
    `);
    if (!shown) return;
    bindCommon();

    on("#saveBtn", "click", async () => {
      const title = $("#materialTitle").value.trim();
      const text = $("#materialText").value;
      const errorEl = $("#errorMsg");
      if (!title) return (errorEl.textContent = "제목을 입력해주세요.");
      if (!text.trim()) return (errorEl.textContent = "내용을 입력해주세요.");
      $("#saveBtn").disabled = true;
      try {
        const m = await Materials.createText({
          subjectId: ctx.subjectId,
          unitId: ctx.unitId,
          studyMode: ctx.studyMode,
          title,
          text,
        });
        await afterMaterialSaved(ctx, m);
      } catch (err) {
        $("#saveBtn").disabled = false;
        errorEl.textContent = "저장 실패: " + (err.message || err);
      }
    });
  }

  // ---------------------------------------------------------------------
  // 사진으로 자료 추가
  //   사진 선택 → OCR(원문 보존) → AI 문맥 보정(여러 장을 한 묶음으로) → 확인 → 저장 → 자동 분석
  // ---------------------------------------------------------------------
  function correctionBanner(c) {
    if (!c || c.status === "empty") return "";
    if (c.status === "ai") return `<div class="banner ok">✨ ${h(c.message)}</div>`;
    return `<div class="banner warn">${h(c.message)}</div>`;
  }

  function uncertainHtml(list, keyPrefix) {
    if (!list || !list.length) return "";
    return `<div class="uncertain-list">${list
      .map(
        (u, j) => `
        <div class="uncertain">
          <div class="uncertain-text">⚠️ ‘<b>${h(u.to)}</b>’(으)로 추정됨
            <div class="source-mini">원문: “${h(u.from)}” · ${h(u.reason || "")}</div></div>
          <div class="uncertain-btns">
            <button class="link-btn" data-accept="${keyPrefix}${j}">적용</button>
            <button class="link-btn muted" data-dismiss="${keyPrefix}${j}">무시</button>
          </div>
        </div>`
      )
      .join("")}</div>`;
  }

  function appliedHtml(applied, raw) {
    if (!applied.length && !raw) return "";
    return `<details class="panel slim"><summary>${applied.length ? `AI 보정 ${applied.length}곳 · ` : ""}OCR 원문 보기</summary>
      ${applied.length ? `<ul class="plain-list">${applied.map((a) => `<li>“${h(a.from)}” → “${h(a.to)}”</li>`).join("")}</ul>` : ""}
      ${raw ? `<p class="material-text muted">${h(raw)}</p>` : ""}
    </details>`;
  }

  /** 자료에 남길 분석 기록 (디버그·[AI 보정 내용 보기]용, 이미지 자체는 materialImages에) */
  function pipelineRecord(p) {
    return {
      version: 4,
      ms: p.ms,
      structured: p.structured,
      cleanup: { counts: p.cleanup.counts, watermark: p.cleanup.watermark, termMap: p.cleanup.termMap, log: p.cleanup.log.slice(0, 400) },
      ai: {
        status: p.ai.status,
        method: p.ai.method,
        message: p.ai.message,
        applied: p.ai.applied,
        rejected: (p.ai.rejected || []).slice(0, 100),
        restored: p.ai.restored,
        unverifiedCount: p.ai.unverified.length,
        errors: p.ai.errors,
      },
      images: p.images.map((im) => ({ pre: im.pre, preError: im.preError, ms: im.ms, ocrLog: im.ocrLog, dropped: im.regions.flatMap((r) => r.consensus.dropped) })),
    };
  }

  function renderAddPhoto(ctx) {
    const draftMaterialId = Utils.generateId();
    let pickedFiles = []; // File[]
    let reviewImages = []; // [{ file, rawOcrText, editedText, ocrFailed, applied, uncertain }]
    let correction = null;
    let pipeline = null; // DocPipeline.run 결과 (v4)
    let title = `사진 자료 ${Utils.formatDate(Date.now())}`;

    function renderPicking(errorText) {
      const shown = show(`
        ${topBar("+ 사진 추가", ctx.backPath)}
        <main class="content">
          <div class="row-btns">
            <button id="cameraBtn" class="secondary-btn">📷 카메라 촬영</button>
            <button id="galleryBtn" class="secondary-btn">🖼 갤러리에서 선택</button>
          </div>
          <input type="file" id="cameraInput" accept="image/*" capture="environment" hidden />
          <input type="file" id="galleryInput" accept="image/*" multiple hidden />

          <p class="section-label">선택한 사진 (${pickedFiles.length}장) · 이 순서대로 이어서 분석합니다</p>
          ${
            pickedFiles.length === 0
              ? `<p class="empty">교재, 프린트, 노트를 찍기만 하면 됩니다.<br/>여러 장이면 페이지 순서대로 추가하세요.</p>`
              : `<div class="thumb-row">
                  ${pickedFiles
                    .map(
                      (f, i) => `
                    <div class="thumb">
                      <img src="${objUrl(f)}" alt="사진 ${i + 1}" />
                      <span class="thumb-no">${i + 1}</span>
                      <button class="thumb-remove" data-remove-index="${i}" aria-label="사진 삭제">×</button>
                    </div>`
                    )
                    .join("")}
                </div>`
          }
          <p id="errorMsg" class="error-msg">${h(errorText || "")}</p>
          <button id="startOcrBtn" class="primary-btn" ${pickedFiles.length === 0 ? "disabled" : ""}>글자 인식 시작</button>
          ${Ai.isConfigured() ? `<p class="hint">인식 후 AI가 문맥을 보고 OCR 오타를 보정합니다. 원본 인식 결과는 그대로 보관됩니다.</p>` : ""}
        </main>
      `);
      if (!shown) return;
      bindCommon();

      on("#cameraBtn", "click", () => $("#cameraInput").click());
      on("#galleryBtn", "click", () => $("#galleryInput").click());
      const addFiles = (e) => {
        const files = Array.from(e.target.files || []).filter((f) => !f.type || f.type.startsWith("image/"));
        pickedFiles = pickedFiles.concat(files);
        renderPicking();
      };
      on("#cameraInput", "change", addFiles);
      on("#galleryInput", "change", addFiles);
      $all("[data-remove-index]").forEach((el) =>
        el.addEventListener("click", () => {
          pickedFiles.splice(Number(el.dataset.removeIndex), 1);
          renderPicking();
        })
      );
      on("#startOcrBtn", "click", async () => {
        if (pickedFiles.length === 0) return renderPicking("사진을 1장 이상 추가해주세요.");
        renderOcrProgress("prepare", 0, pickedFiles.length);
        // 같은 단원의 다른 자료 글: 용어 통일(문서 내 빈도)에 참고만 한다
        let extraTexts = [];
        try {
          if (ctx.unitId) extraTexts = (await Materials.listByUnit(ctx.unitId)).map((m) => Materials.textOf(m));
        } catch (e) {
          extraTexts = [];
        }
        pipeline = await DocPipeline.run(pickedFiles, {
          onProgress: (stage, done, total) => renderOcrProgress(stage, done, total),
          extraTexts,
        });
        correction = { status: pipeline.ai.status, message: pipeline.ai.message, rejected: pipeline.ai.rejected || [] };
        reviewImages = pickedFiles.map((file, i) => {
          const im = pipeline.images[i];
          return {
            file,
            rawOcrText: im.ocrFailed ? null : im.rawText,
            editedText: pipeline.texts[i] || "",
            ocrFailed: im.ocrFailed,
            applied: pipeline.perImage[i].applied.slice(),
            uncertain: pipeline.perImage[i].uncertain.slice(),
            info: im,
          };
        });
        renderReview();
      });
    }

    const STAGE_TEXT = {
      prepare: "사진을 준비하는 중…",
      preprocess: "사진을 보정하는 중… (조명 · 기울기 · 원근)",
      ocr: "사진에서 글자를 인식하는 중… (영역별로 여러 번 읽어 비교)",
      cleanup: "워터마크 · 쪽 번호를 지우고 용어를 정리하는 중…",
      ai: "AI가 사진과 OCR 결과를 함께 보고 문서 구조를 확인하는 중…",
      done: "정리하는 중…",
    };
    function renderOcrProgress(stage, done, total) {
      const n = Math.min(total, done + (stage === "preprocess" || stage === "ocr" ? 1 : 0));
      show(`
        ${topBar("+ 사진 추가", null)}
        <main class="content center">
          <div class="spinner"></div>
          <p>${h(STAGE_TEXT[stage] || STAGE_TEXT.ocr)}${stage === "preprocess" || stage === "ocr" ? ` (${n}/${total})` : ""}</p>
          <p class="hint">처음 한 번은 한국어 인식 데이터를 내려받느라 시간이 더 걸릴 수 있습니다.</p>
        </main>
      `);
    }

    /** 사진 한 장의 분석 요약 칩: 표 인식, 기울기·원근 보정, 워터마크·쪽 번호 제거 수 */
    function pipelineChips(img, i) {
      if (!pipeline || !img.info) return "";
      const pre = img.info.pre;
      const log = pipeline.cleanup.log.filter((l) => l.page === i + 1);
      const wm = log.filter((l) => l.type === "watermark").length;
      const pn = log.filter((l) => l.type === "pageNumber").length;
      const term = log.filter((l) => l.type === "term").length;
      const chips = [];
      if (pre && pre.layoutFound) chips.push("표 구조 인식");
      if (pre && Math.abs(pre.deskewAngle) >= 0.05) chips.push(`기울기 ${pre.deskewAngle > 0 ? "+" : ""}${pre.deskewAngle.toFixed(2)}° 보정`);
      if (pre && pre.perspective && pre.perspective.applied) chips.push("원근 보정");
      if (wm) chips.push(`워터마크 ${wm}곳 제거`);
      if (pn) chips.push("쪽 번호 제거");
      if (term) chips.push(`용어 통일 ${term}곳`);
      return chips.length ? `<div class="chip-row">${chips.map((c) => `<span class="chip muted">${h(c)}</span>`).join("")}</div>` : "";
    }

    function renderReview(errorText) {
      const pendingCount = reviewImages.reduce((s, i) => s + i.uncertain.length, 0);
      const shown = show(`
        ${topBar("인식 결과 확인", null)}
        <main class="content">
          ${correctionBanner(correction)}
          <p class="hint">${
            pendingCount
              ? `⚠️ 표시된 ${pendingCount}곳은 AI가 확신하지 못해 고치지 않았습니다. 맞으면 [적용]을 누르세요.`
              : "확인 후 저장하면 중요 내용 추출과 요약이 자동으로 진행됩니다. 틀린 곳이 보이면 직접 고칠 수도 있습니다."
          }</p>
          <input id="materialTitle" type="text" placeholder="자료 제목 (예: 해부학 Chapter 3)" value="${h(title)}" />
          ${reviewImages
            .map(
              (img, i) => `
            <div class="review-card">
              <div class="row-head"><span class="chip">사진 ${i + 1}</span>${img.applied.length ? `<span class="chip ok">AI 보정 ${img.applied.length}곳</span>` : ""}</div>
              ${pipelineChips(img, i)}
              <img src="${objUrl(img.file)}" class="review-img" alt="사진 ${i + 1}" />
              ${img.ocrFailed ? `<p class="error-msg">이 사진은 글자 인식에 실패했습니다. 아래에 직접 입력해주세요.</p>` : ""}
              ${uncertainHtml(img.uncertain, `${i}:`)}
              <textarea class="editedText" data-index="${i}" rows="7">${h(img.editedText)}</textarea>
              ${appliedHtml(img.applied, img.rawOcrText)}
            </div>`
            )
            .join("")}
          <p id="errorMsg" class="error-msg">${h(errorText || "")}</p>
          <div class="row-btns">
            <button id="cancelBtn" class="secondary-btn">취소</button>
            <button id="saveBtn" class="primary-btn">저장하고 분석</button>
          </div>
        </main>
      `);
      if (!shown) return;

      on("#materialTitle", "input", (e) => (title = e.target.value));
      $all(".editedText").forEach((el) =>
        el.addEventListener("input", () => (reviewImages[Number(el.dataset.index)].editedText = el.value))
      );
      $all("[data-accept]").forEach((el) =>
        el.addEventListener("click", () => {
          const [i, j] = el.dataset.accept.split(":").map(Number);
          const img = reviewImages[i];
          const item = img.uncertain[j];
          img.editedText = OcrCorrection.applySuggestion(img.editedText, item);
          img.uncertain.splice(j, 1);
          img.applied.push({ ...item, reason: "사용자 확인 후 적용" });
          renderReview();
        })
      );
      $all("[data-dismiss]").forEach((el) =>
        el.addEventListener("click", () => {
          const [i, j] = el.dataset.dismiss.split(":").map(Number);
          reviewImages[i].uncertain.splice(j, 1);
          renderReview();
        })
      );
      on("#cancelBtn", "click", () => {
        if (confirm("인식한 내용을 저장하지 않고 나갈까요?")) Router.navigate(ctx.backPath);
      });
      on("#saveBtn", "click", async () => {
        title = $("#materialTitle").value.trim();
        if (!title) return renderReview("제목을 입력해주세요.");
        if (reviewImages.every((i) => !i.editedText.trim())) {
          return renderReview("인식된 내용이 없습니다. 직접 텍스트를 입력해주세요.");
        }
        $("#saveBtn").disabled = true;
        try {
          const aiCorrection = correction
            ? {
                status: correction.status,
                message: correction.message,
                applied: reviewImages.flatMap((img, i) => img.applied.map((a) => ({ page: i + 1, ...a }))),
                uncertain: reviewImages.flatMap((img, i) => img.uncertain.map((u) => ({ page: i + 1, ...u }))),
                rejectedCount: (correction.rejected || []).length,
                at: Utils.now(),
              }
            : null;
          // v4: 확인 화면에서 고친 글까지 반영해 구조를 다시 읽는다 (구조 ↔ 글이 항상 같도록)
          const texts = reviewImages.map((img) => img.editedText || "");
          const structuredContent =
            pipeline && (pipeline.structured || texts.some((t) => DocStructure.hasStructureTags(t))) ? DocPipeline.structureFromTexts(texts, pipeline.structure) : null;
          const ocrPipeline = pipeline ? pipelineRecord(pipeline) : null;
          const m = await Materials.createPhotoFromOcrResults({
            materialId: draftMaterialId,
            subjectId: ctx.subjectId,
            unitId: ctx.unitId,
            studyMode: ctx.studyMode,
            title,
            images: reviewImages.map((img, i) => {
              const im = img.info || {};
              return {
                blob: img.file,
                rawOcrText: img.rawOcrText,
                editedText: img.editedText,
                processedBlob: im.processedBlob || null,
                preprocess: im.pre || null,
                layout: im.layoutRaw ? { found: im.layoutRaw.found, table: im.layoutRaw.table, regions: im.layoutRaw.regions } : null,
                ocrRegions: im.regions || null,
                structure: structuredContent && structuredContent.pages[i] ? structuredContent.pages[i] : null,
              };
            }),
            aiCorrection,
            structuredContent,
            ocrPipeline,
          });
          await afterMaterialSaved(ctx, m);
        } catch (err) {
          renderReview("저장 실패: " + (err.message || err));
        }
      });
    }

    renderPicking();
  }

  async function unitCtx(unitId) {
    const unit = await Units.get(unitId);
    if (!unit) return null;
    return {
      subjectId: unit.subjectId,
      unitId,
      studyMode: "content",
      backPath: `/unit/${unitId}`,
      afterSave: () => `/unit/${unitId}`,
    };
  }

  function wordCtx(subjectId) {
    return {
      subjectId,
      unitId: null,
      studyMode: "word",
      backPath: `/subject/${subjectId}/words`,
      afterSave: (m) => `/subject/${subjectId}/words/review/${m.id}`,
    };
  }

  // ---------------------------------------------------------------------
  // 자료 상세: 확인 / 수정 / 삭제 (원본 OCR 보존 확인 가능)
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // v4: 교재 구조 보기 (제목 · 질문 · 핵심 내용 · 신념화)
  // ---------------------------------------------------------------------
  function renderDocPage(p, pi) {
    const q = p.question;
    const lines = (arr) => arr.map((c) => `<p class="doc-line">${h(c)}</p>`).join("");
    const sections = p.sections
      .map(
        (s) => `
        <div class="doc-sec">
          ${s.title ? `<div class="doc-sec-title">${s.number ? `${h(s.number)}. ` : ""}${h(s.title)}</div>` : ""}
          ${lines(s.content)}
          ${s.subsections.map((sub) => `<div class="doc-sub"><div class="doc-sub-title">- ${h(sub.title)}</div>${lines(sub.content)}</div>`).join("")}
        </div>`
      )
      .join("");
    const tables = (p.tables || [])
      .map((t) => `<table class="doc-table">${t.rows.map((r) => `<tr>${r.map((c) => `<td>${h(c)}</td>`).join("")}</tr>`).join("")}</table>`)
      .join("");
    const unverified = (p.unverified || [])
      .map(
        (u, j) => `
        <div class="uncertain">
          <div class="uncertain-text">⚠️ AI만 읽은 줄: ‘<b>${h(u.text)}</b>’
            <div class="source-mini">${h(u.reason || "")} · 사진을 보고 맞으면 [추가]를 누르세요 (추가 전에는 학습에 쓰지 않음)</div></div>
          <div class="uncertain-btns">
            <button class="link-btn" data-unv-add="${pi}:${j}">추가</button>
            <button class="link-btn muted" data-unv-drop="${pi}:${j}">무시</button>
          </div>
        </div>`
      )
      .join("");
    return `
      <section class="doc-page">
        ${p.title ? `<div class="doc-title">${h(p.title)}</div>` : ""}
        ${
          q
            ? `<div class="doc-question"><div class="row-head">${q.number ? `<span class="chip">Q${h(q.number)}</span>` : ""}${
                q.starred ? `<span class="chip warn-chip">★ 중요</span>` : ""
              }${(q.tags || []).map((t) => `<span class="chip muted">${h(t)}</span>`).join("")}</div><div class="doc-q-text">${h(q.text)}</div></div>`
            : ""
        }
        ${sections || tables ? `<div class="doc-block"><div class="doc-label">핵심 내용</div>${sections}${tables}</div>` : ""}
        ${
          p.beliefContent.length
            ? `<div class="doc-block belief"><div class="doc-label">신념화</div><ul class="doc-belief">${p.beliefContent.map((b) => `<li>${h(b)}</li>`).join("")}</ul></div>`
            : ""
        }
        ${unverified}
        ${p.pageLabel ? `<div class="doc-page-label">${h(p.pageLabel)}</div>` : ""}
      </section>`;
  }

  /** 자료 한 개의 요약(교재 순서, 중요도)과 빈칸 카드 */
  function materialStudyHtml(points) {
    if (!points.length) return "";
    const ordered = points.slice().sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
    const summary = ordered
      .filter((p) => p.area !== "belief")
      .map((p) => `<li>${impChip(p.importance)} ${h(p.text)}</li>`)
      .join("");
    const belief = ordered.filter((p) => p.area === "belief");
    const cards = ordered
      .filter((p) => p.answer && p.blankText && p.blankText.includes(TextAnalysis.BLANK))
      .sort((a, b) => (b.importance || 3) - (a.importance || 3) || (a.orderIndex || 0) - (b.orderIndex || 0));
    return `
      <section class="panel"><h2 class="panel-title">요약</h2>
        <ul class="summary-list">${summary}</ul>
        ${belief.length ? `<p class="section-label">신념화 (마음가짐)</p><ul class="summary-list">${belief.map((p) => `<li>${impChip(p.importance)} ${h(p.text)}</li>`).join("")}</ul>` : ""}
      </section>
      <section class="panel"><h2 class="panel-title">빈칸 학습 <span class="card-sub">카드를 누르면 정답</span></h2>
        ${
          cards.length
            ? `<ul class="card-list">${cards
                .map(
                  (c) => `<li class="card blank-card mini" data-mcard>
                    <div class="row-head">${impChip(c.importance)}${c.questionLinked ? `<span class="chip muted">질문 연결</span>` : ""}</div>
                    <div class="blank-text" data-empty>${blankEmpty(c.blankText)}</div>
                    <div class="blank-text" data-filled hidden>${blankWithAnswer(c.blankText, c.answer)}</div></li>`
                )
                .join("")}</ul>`
            : `<p class="empty">빈칸으로 만들 핵심 구절이 없습니다.</p>`
        }
      </section>`;
  }

  /** [AI 보정 내용 보기]: 무엇을 왜 바꿨는지 (AI 교정 · 규칙 정리 · 되살린 줄) */
  function correctionDetailsHtml(material) {
    const pl = material.ocrPipeline;
    const corr = material.aiCorrection || {};
    const rows = [];
    for (const a of corr.applied || []) rows.push(`<li><span class="chip ok">AI 교정</span> “${h(a.from)}” → “${h(a.to)}”</li>`);
    if (pl && pl.cleanup) {
      const label = { watermark: "워터마크 제거", pageNumber: "쪽 번호 제거", noise: "잡음 줄 제거", term: "용어 통일", bullet: "기호 정리" };
      for (const l of pl.cleanup.log || []) {
        if (l.type === "bullet") continue;
        rows.push(`<li><span class="chip muted">${label[l.type] || l.type}</span> ${l.page ? `${l.page}쪽 ` : ""}“${h(l.from)}”${l.to ? ` → “${h(l.to)}”` : " 삭제"} <span class="source-mini">${h(l.why || "")}</span></li>`);
      }
    }
    if (pl && pl.ai) {
      for (const r of pl.ai.restored || []) rows.push(`<li><span class="chip muted">유지</span> “${h(r.text)}” <span class="source-mini">${h(r.reason)}</span></li>`);
      for (const r of (pl.ai.rejected || []).slice(0, 30))
        rows.push(`<li><span class="chip muted">AI 제안 거부</span> “${h(r.from || r.raw || "")}” → “${h(r.to || r.corrected || "")}” <span class="source-mini">${h(r.reason || r.why || "")}</span></li>`);
    }
    return rows.length ? `<ul class="plain-list corr-list">${rows.join("")}</ul>` : `<p class="empty">바뀐 곳이 없습니다.</p>`;
  }

  async function renderMaterialDetail(materialId) {
    const material = await Materials.get(materialId);
    if (!material) return renderNotFound("자료를 찾을 수 없습니다.", "/");
    const sc = material.structuredContent;
    if (sc && sc.structured && sc.pages && sc.pages.length && (material.studyMode || "content") === "content") {
      return renderStructuredMaterial(material);
    }
    const isWord = material.studyMode === "word";
    const backPath = isWord ? `/subject/${material.subjectId}/words` : `/unit/${material.unitId}`;
    const images = material.type === "PHOTO" ? await ImageStorage.getImages(materialId) : [];
    const finalText = Materials.textOf(material);
    const rawDiffers = material.rawText && material.rawText !== finalText;
    const points = isWord ? [] : await Storage.getAllByIndex("points", "materialId", materialId);
    const corr = material.aiCorrection || null;
    const pendingUncertain = (corr && corr.uncertain) || [];

    const shown = show(`
      ${topBar(material.title, backPath)}
      <main class="content">
        ${
          images.length
            ? `<div class="thumb-row">${images
                .map((img, i) => `<div class="thumb large"><img src="${objUrl(img.blob)}" alt="사진 ${i + 1}" /><span class="thumb-no">${i + 1}</span></div>`)
                .join("")}</div>`
            : ""
        }
        <div id="viewMode">
          <p class="card-sub">${material.type === "PHOTO" ? "사진 자료" : "글 자료"} · ${Utils.formatDate(material.updatedAt)}${
      isWord ? "" : ` · 암기 포인트 ${points.length}개`
    }</p>
          ${corr && corr.status === "ai" && corr.applied && corr.applied.length ? `<div class="banner ok">✨ AI 문맥 보정 ${corr.applied.length}곳 적용됨</div>` : ""}
          ${corr && (corr.status === "unavailable" || corr.status === "failed") ? `<div class="banner warn">${h(corr.message || "AI 분석을 사용할 수 없어 기본 분석으로 생성했습니다.")}</div>` : ""}
          ${uncertainHtml(pendingUncertain, "")}
          <p class="material-text">${h(finalText)}</p>
          ${
            rawDiffers || (corr && corr.applied && corr.applied.length)
              ? `<details class="panel"><summary>${material.type === "PHOTO" ? "원본 OCR 결과" : "처음 입력한 원본"}${
                  corr && corr.applied && corr.applied.length ? ` · AI 보정 내역 ${corr.applied.length}곳` : ""
                } 보기</summary>
                  ${corr && corr.applied && corr.applied.length ? `<ul class="plain-list">${corr.applied.map((a) => `<li>“${h(a.from)}” → “${h(a.to)}”</li>`).join("")}</ul>` : ""}
                  <p class="material-text muted">${h(material.rawText)}</p></details>`
              : ""
          }
          ${
            Ai.isConfigured()
              ? `<button id="aiFixBtn" class="secondary-btn full">AI로 OCR 오타 보정</button><p id="aiFixMsg" class="hint"></p>`
              : ""
          }
        </div>
        <div id="editMode" hidden>
          <input id="editTitle" type="text" value="${h(material.title)}" />
          <textarea id="editText" rows="14">${h(finalText)}</textarea>
          <p class="hint">수정해도 원본(${material.type === "PHOTO" ? "OCR 인식 결과" : "처음 입력"})은 따로 보관됩니다.</p>
        </div>
        <div class="detail-actions">
          <button id="editBtn" class="secondary-btn">수정</button>
          <button id="saveEditBtn" class="primary-btn" hidden>수정 완료</button>
          <button id="deleteBtn" class="danger-btn">삭제</button>
        </div>
        ${
          isWord
            ? `<button class="secondary-btn full top-gap" data-go="/subject/${material.subjectId}/words/review/${material.id}">이 자료에서 단어 다시 가져오기</button>`
            : ""
        }
      </main>
    `);
    if (!shown) return;
    bindCommon();

    // ⚠️ 추정 항목 적용/무시 → 최종 텍스트만 바뀌고 원본은 그대로
    const resolveUncertain = async (j, accept) => {
      const item = pendingUncertain[j];
      const nextText = accept ? OcrCorrection.applySuggestion(finalText, item) : finalText;
      const nextCorr = {
        ...(corr || {}),
        uncertain: pendingUncertain.filter((_, k) => k !== j),
        applied: accept ? ((corr && corr.applied) || []).concat({ ...item, reason: "사용자 확인 후 적용" }) : (corr && corr.applied) || [],
      };
      await Materials.setCorrection(materialId, nextText, nextCorr);
      renderMaterialDetail(materialId);
    };
    $all("[data-accept]").forEach((el) => el.addEventListener("click", () => resolveUncertain(Number(el.dataset.accept), true)));
    $all("[data-dismiss]").forEach((el) => el.addEventListener("click", () => resolveUncertain(Number(el.dataset.dismiss), false)));

    on("#aiFixBtn", "click", async () => {
      $("#aiFixBtn").disabled = true;
      $("#aiFixMsg").textContent = "AI가 문맥을 보고 OCR 오류를 찾는 중…";
      const r = await OcrCorrection.correctPages([finalText]);
      const page = r.pages[0];
      if (r.status !== "ai") {
        $("#aiFixMsg").textContent = r.message;
        $("#aiFixBtn").disabled = false;
        return;
      }
      await Materials.setCorrection(materialId, page.final, {
        status: "ai",
        message: r.message,
        applied: ((corr && corr.applied) || []).concat(page.applied.map((a) => ({ page: 1, ...a }))),
        uncertain: pendingUncertain.concat(page.uncertain.map((u) => ({ page: 1, ...u }))),
        rejectedCount: ((corr && corr.rejectedCount) || 0) + r.rejected.length,
        at: Utils.now(),
      });
      flash(r.message, "ok");
      renderMaterialDetail(materialId);
    });

    on("#editBtn", "click", () => {
      $("#viewMode").hidden = true;
      $("#editMode").hidden = false;
      $("#editBtn").hidden = true;
      $("#saveEditBtn").hidden = false;
    });
    on("#saveEditBtn", "click", async () => {
      const t = $("#editTitle").value.trim();
      const text = $("#editText").value;
      if (!t) return alert("제목을 입력해주세요.");
      await Materials.updateContent(materialId, t, text);
      renderMaterialDetail(materialId);
    });
    on("#deleteBtn", "click", async () => {
      const msg = isWord
        ? "자료를 삭제할까요?\n사진과 이 자료에서 가져온 단어(학습 기록 포함)도 함께 삭제됩니다."
        : "자료를 삭제할까요?\n사진과 이 자료의 암기 포인트·학습 기록도 함께 삭제되며 되돌릴 수 없습니다.";
      if (!confirm(msg)) return;
      await Materials.remove(materialId);
      Router.navigate(backPath);
    });
  }

  // ---------------------------------------------------------------------
  // v4: 교재 사진 자료 기본 화면
  //   [AI 분석 완료] 제목 · 질문 · 핵심 내용 · 요약 · 빈칸 학습
  //   [원본 OCR 보기] [AI 보정 내용 보기] [분석 과정] · 수정 · 삭제
  // ---------------------------------------------------------------------
  async function renderStructuredMaterial(material, openPanel) {
    const materialId = material.id;
    const sc = material.structuredContent;
    const backPath = `/unit/${material.unitId}`;
    const images = material.type === "PHOTO" ? await ImageStorage.getImages(materialId) : [];
    const points = await Storage.getAllByIndex("points", "materialId", materialId);
    const corr = material.aiCorrection || null;
    const pendingUncertain = (corr && corr.uncertain) || [];
    const pl = material.ocrPipeline || null;
    const aiDone = sc.source === "ai" || (corr && corr.status === "ai");
    const status = aiDone
      ? `<div class="banner ok">✨ AI 분석 완료${corr && corr.applied && corr.applied.length ? ` · 교정 ${corr.applied.length}곳` : ""}</div>`
      : `<div class="banner warn">${h((corr && corr.message) || DocPipeline.UNAVAILABLE_MSG)}</div>`;
    const panel = openPanel || null;

    const rawPanel = `
      <section class="panel" id="rawPanel" ${panel === "raw" ? "" : "hidden"}>
        <h2 class="panel-title">원본 OCR (고치기 전 그대로)</h2>
        ${images.map((img, i) => `<img src="${objUrl(img.blob)}" class="review-img" alt="원본 사진 ${i + 1}" />`).join("")}
        <p class="material-text muted">${h(material.rawText || "")}</p>
      </section>`;
    const corrPanel = `
      <section class="panel" id="corrPanel" ${panel === "corr" ? "" : "hidden"}>
        <h2 class="panel-title">AI 보정 · 정리 내용</h2>
        ${pl && pl.ai && pl.ai.message ? `<p class="hint">${h(pl.ai.message)}</p>` : ""}
        ${correctionDetailsHtml(material)}
      </section>`;
    const procPanel = `
      <section class="panel" id="procPanel" ${panel === "proc" ? "" : "hidden"}>
        <h2 class="panel-title">분석 과정</h2>
        ${images
          .map((img, i) => {
            const pre = img.preprocess;
            const regions = (img.layout && img.layout.regions) || [];
            return `<div class="proc-img">
              <p class="section-label">사진 ${i + 1}${pre ? ` · 기울기 ${pre.deskewAngle.toFixed(2)}° · 원근 ${pre.perspective && pre.perspective.applied ? "보정함" : "생략"} · 표 ${pre.layoutFound ? "인식" : "못 찾음"}` : ""}</p>
              ${img.processedBlob ? `<img src="${objUrl(img.processedBlob)}" class="review-img" alt="전처리 이미지 ${i + 1}" />` : `<p class="hint">전처리 이미지 없음 (예전 자료)</p>`}
              ${regions.length ? `<p class="source-mini">영역: ${regions.map((r) => `${r.kind}${r.index ?? ""}`).join(" · ")}</p>` : ""}
              ${
                img.ocrRegions
                  ? `<details class="panel slim"><summary>영역별 OCR 비교 (변형 A/B/C → 합의)</summary>${img.ocrRegions
                      .map(
                        (r) => `<div class="proc-region"><b>${h(r.kind)}${r.index ?? ""}</b>
                        ${Object.entries(r.variants || {})
                          .map(([v, x]) => `<div class="source-mini">${h(v)} (${x.confidence}): ${h(Utils.truncate(x.text.replace(/\n/g, " / "), 160))}</div>`)
                          .join("")}
                        <div class="source-mini">→ 합의: ${h(Utils.truncate(r.consensus.text.replace(/\n/g, " / "), 200))}</div></div>`
                      )
                      .join("")}</details>`
                  : ""
              }
            </div>`;
          })
          .join("")}
        <p class="hint">자세한 단계별 결과는 <a href="ocr-test.html" target="_blank" rel="noopener">OCR 테스트 페이지</a>에서 볼 수 있습니다.</p>
      </section>`;

    const shown = show(`
      ${topBar(material.title, backPath)}
      <main class="content">
        ${status}
        ${uncertainHtml(pendingUncertain, "")}
        <div id="viewMode">
          <div class="row-btns wrap">
            <button class="secondary-btn small" data-panel="raw">원본 OCR 보기</button>
            <button class="secondary-btn small" data-panel="corr">AI 보정 내용 보기</button>
            <button class="secondary-btn small" data-panel="proc">분석 과정</button>
          </div>
          ${rawPanel}${corrPanel}${procPanel}
          <div class="doc-view">${sc.pages.map(renderDocPage).join("")}</div>
          ${materialStudyHtml(points)}
          <p class="card-sub">사진 자료 · ${Utils.formatDate(material.updatedAt)} · 암기 포인트 ${points.length}개</p>
        </div>
        <div id="editMode" hidden>
          <input id="editTitle" type="text" value="${h(material.title)}" />
          <textarea id="editText" rows="18">${h(Materials.textOf(material))}</textarea>
          <p class="hint">[제목] [질문] [핵심 내용] [신념화] 표시와 “1.”(대제목) “- ”(소제목) “● ”(신념화 항목)을 지키면 구조가 그대로 유지됩니다. 원본 OCR은 따로 보관됩니다.</p>
        </div>
        <div class="detail-actions">
          <button id="editBtn" class="secondary-btn">수정</button>
          <button id="saveEditBtn" class="primary-btn" hidden>수정 완료</button>
          <button id="deleteBtn" class="danger-btn">삭제</button>
        </div>
        <div class="row-btns top-gap">
          <button class="secondary-btn" data-go="/unit/${material.unitId}/summary">단원 요약본</button>
          <button class="primary-btn" id="testBtn">이 단원 시험 보기</button>
        </div>
      </main>
    `);
    if (!shown) return;
    bindCommon();

    $all("[data-panel]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = { raw: "#rawPanel", corr: "#corrPanel", proc: "#procPanel" }[b.dataset.panel];
        const el = $(id);
        el.hidden = !el.hidden;
        if (!el.hidden) el.scrollIntoView({ block: "nearest" });
      })
    );
    $all("[data-mcard]").forEach((li) =>
      li.addEventListener("click", () => {
        li.querySelector("[data-empty]").hidden = !li.querySelector("[data-empty]").hidden;
        li.querySelector("[data-filled]").hidden = !li.querySelector("[data-filled]").hidden;
      })
    );
    on("#testBtn", "click", () => UIQuiz.startTest({ scope: "unit", subjectId: material.subjectId, unitId: material.unitId }));

    // AI 교정 중 확인이 필요한 항목 (적용/무시)
    const finalText = Materials.textOf(material);
    const resolveUncertain = async (j, accept) => {
      const item = pendingUncertain[j];
      const nextText = accept ? OcrCorrection.applySuggestion(finalText, item) : finalText;
      const nextCorr = {
        ...(corr || {}),
        uncertain: pendingUncertain.filter((_, k) => k !== j),
        applied: accept ? ((corr && corr.applied) || []).concat({ ...item, reason: "사용자 확인 후 적용" }) : (corr && corr.applied) || [],
      };
      await Materials.setCorrection(materialId, nextText, nextCorr);
      renderMaterialDetail(materialId);
    };
    $all("[data-accept]").forEach((el) => el.addEventListener("click", () => resolveUncertain(Number(el.dataset.accept), true)));
    $all("[data-dismiss]").forEach((el) => el.addEventListener("click", () => resolveUncertain(Number(el.dataset.dismiss), false)));

    // AI만 읽은 줄 (OCR 근거 없음): 사용자가 사진을 보고 추가/무시
    const resolveUnverified = async (key, add) => {
      const [pi, j] = key.split(":").map(Number);
      const pages = sc.pages.map((p) => ({ ...p }));
      const item = (pages[pi].unverified || [])[j];
      if (!item) return;
      pages[pi] = add ? DocStructure.insertUnverified(pages[pi], item) : { ...pages[pi], unverified: pages[pi].unverified.filter((_, k) => k !== j) };
      await Materials.setStructure(materialId, { ...sc, pages });
      renderMaterialDetail(materialId);
    };
    $all("[data-unv-add]").forEach((el) => el.addEventListener("click", () => resolveUnverified(el.dataset.unvAdd, true)));
    $all("[data-unv-drop]").forEach((el) => el.addEventListener("click", () => resolveUnverified(el.dataset.unvDrop, false)));

    on("#editBtn", "click", () => {
      $("#viewMode").hidden = true;
      $("#editMode").hidden = false;
      $("#editBtn").hidden = true;
      $("#saveEditBtn").hidden = false;
    });
    on("#saveEditBtn", "click", async () => {
      const t = $("#editTitle").value.trim();
      const text = $("#editText").value;
      if (!t) return alert("제목을 입력해주세요.");
      await Materials.updateContent(materialId, t, text);
      renderMaterialDetail(materialId);
    });
    on("#deleteBtn", "click", async () => {
      if (!confirm("자료를 삭제할까요?\n사진과 이 자료의 암기 포인트·학습 기록도 함께 삭제되며 되돌릴 수 없습니다.")) return;
      await Materials.remove(materialId);
      Router.navigate(backPath);
    });
  }

  // ---------------------------------------------------------------------
  // 요약본
  // ---------------------------------------------------------------------
  function impChip(importance) {
    const k = Utils.clamp(Math.round(importance || 3), 1, 5);
    return `<span class="imp imp-${k}">${TextAnalysis.IMPORTANCE_LABELS[k]}</span>`;
  }

  /** "대한민국의 수도는 [      ]이다." → 빈칸 자리에 정답만 [서울]로 표시 */
  function blankWithAnswer(blankText, answer) {
    const parts = String(blankText).split(TextAnalysis.BLANK);
    return parts.map(h).join(`<mark class="blank-answer">[${h(answer)}]</mark>`);
  }
  function blankEmpty(blankText) {
    const parts = String(blankText).split(TextAnalysis.BLANK);
    return parts.map(h).join(`<span class="blank-slot">[&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;]</span>`);
  }

  async function renderSummary(unitId, initialTab) {
    const unit = await Units.get(unitId);
    if (!unit) return renderNotFound("단원을 찾을 수 없습니다.", "/");
    const tab = initialTab || "summary";
    const { summary, outdated, hasMaterial } = await Summary.load(unitId);

    const itemHtml = (it) => {
      if (typeof it === "string") return `<li>${h(it)}</li>`; // v1 형식 호환
      const showSrc = it.sourceExcerpt && Utils.normalizeText(it.sourceExcerpt) !== Utils.normalizeText(it.text);
      return `<li>${it.importance ? impChip(it.importance) + " " : ""}${h(it.text)}${
        showSrc ? `<div class="source-mini">근거: “${h(it.sourceExcerpt)}”</div>` : ""
      }</li>`;
    };

    const tabs = `<div class="tabs">
        <button class="tab ${tab === "summary" ? "active" : ""}" data-tab="summary">요약본</button>
        <button class="tab ${tab === "blank" ? "active" : ""}" data-tab="blank">빈칸 학습</button>
      </div>`;

    let body = "";
    if (tab === "summary") {
      body = `
        ${!hasMaterial ? `<p class="empty">요약할 자료가 없습니다.</p>` : ""}
        ${outdated ? `<div class="banner warn">자료가 바뀌었어요. 요약을 다시 만들면 최신 내용이 반영됩니다.</div>` : ""}
        ${
          summary && summary.sections && summary.sections.length
            ? `<p class="card-sub">${
                summary.origin === "ai"
                  ? "AI 구조화 요약 (자료 근거 검증 통과 항목만)"
                  : summary.origin === "structure"
                  ? "교재 구조 요약 (질문 → 핵심 내용 → 신념화 순서, 질문과 연결된 내용은 ‘핵심’)"
                  : "기본 요약 (자료 문장을 중요도·분류별로 정리)"
              } · ${Utils.timeAgo(summary.updatedAt)}</p>
              ${summary.sections
                .map((sec) => `<section class="panel"><h2 class="panel-title">${h(sec.title)}</h2><ul class="summary-list">${(sec.items || []).map(itemHtml).join("")}</ul></section>`)
                .join("")}`
            : hasMaterial
            ? `<p class="empty">아직 요약본이 없습니다.</p>`
            : ""
        }
        ${
          hasMaterial
            ? `<button id="genBtn" class="primary-btn">${summary ? "요약 다시 만들기" : "요약 만들기"}${Ai.isConfigured() ? " (AI)" : ""}</button>`
            : ""
        }`;
    } else {
      const cards = await Summary.blankCards(unitId);
      body = cards.length
        ? `<div class="blank-toolbar">
             <label class="check"><input type="checkbox" id="coreOnly" /> 핵심·중요만</label>
             <button id="revealAll" class="link-btn">정답 모두 보기</button>
           </div>
           <p class="hint">빈칸에 들어갈 말을 떠올린 뒤 카드를 눌러 확인하세요. 정답 자리에는 핵심어만 표시됩니다.</p>
           <ul class="card-list">${cards
             .map(
               (c, i) => `
             <li class="card blank-card" data-card="${i}" data-imp="${c.importance}">
               <div class="row-head">${impChip(c.importance)}<span class="card-sub">학습 ${Math.round(c.studyLevel)}%</span></div>
               <div class="blank-text" data-empty>${blankEmpty(c.blankText)}</div>
               <div class="blank-text" data-filled hidden>${blankWithAnswer(c.blankText, c.answer)}</div>
               <div class="row-btns" data-judge hidden>
                 <button class="danger-btn small" data-unknown="${i}">몰랐음</button>
                 <button class="primary-btn small" data-known="${i}">알았음</button>
               </div>
             </li>`
             )
             .join("")}</ul>`
        : `<p class="empty">빈칸으로 만들 핵심어가 있는 내용이 아직 없습니다.</p>`;
      body = `<div id="blankArea">${body}</div>`;
      // 카드 데이터는 이벤트에서 사용
      renderSummary._cards = cards;
    }

    const shown = show(`
      ${topBar(`${unit.name} · 요약본`, `/unit/${unitId}`)}
      <main class="content">
        ${aiBanner("content")}
        ${tabs}
        ${body}
        <p id="errorMsg" class="error-msg"></p>
      </main>`);
    if (!shown) return;
    bindCommon();
    $all("[data-tab]").forEach((b) => b.addEventListener("click", () => renderSummary(unitId, b.dataset.tab)));

    on("#genBtn", "click", async () => {
      loadingScreen("요약본", Ai.isConfigured() ? "AI가 자료 전체를 분석해 구조화 요약을 만드는 중…" : "자료를 중요도·분류별로 정리하는 중…");
      try {
        const g = await Summary.generate(unitId);
        if (g.fellBack) flash(g.message, "warn");
      } catch (err) {
        showError(err);
      }
      renderSummary(unitId, "summary");
    });

    if (tab === "blank") {
      const cards = renderSummary._cards || [];
      const reveal = (li) => {
        li.querySelector("[data-empty]").hidden = true;
        li.querySelector("[data-filled]").hidden = false;
        const judge = li.querySelector("[data-judge]");
        if (judge && !li.dataset.done) judge.hidden = false;
      };
      $all(".blank-card").forEach((li) =>
        li.addEventListener("click", (e) => {
          if (e.target.closest("button")) return;
          reveal(li);
        })
      );
      on("#revealAll", "click", () => $all(".blank-card").forEach(reveal));
      on("#coreOnly", "change", (e) => {
        $all(".blank-card").forEach((li) => (li.hidden = e.target.checked && Number(li.dataset.imp) < 4));
      });
      const judge = async (i, ok) => {
        const card = cards[i];
        const p = await Storage.get("points", card.pointId);
        if (p) {
          Learning.applyResult(p, ok, 0.5);
          await Storage.put("points", p);
        }
        const li = root().querySelector(`[data-card="${i}"]`);
        li.dataset.done = "1";
        li.querySelector("[data-judge]").hidden = true;
        li.classList.add(ok ? "done-ok" : "done-bad");
        li.querySelector(".card-sub").textContent = `학습 ${Math.round(p ? p.studyLevel : 0)}%`;
      };
      $all("[data-known]").forEach((b) => b.addEventListener("click", () => judge(Number(b.dataset.known), true)));
      $all("[data-unknown]").forEach((b) => b.addEventListener("click", () => judge(Number(b.dataset.unknown), false)));
    }
  }

  // ---------------------------------------------------------------------
  // 설정: AI 서버 주소 (키 아님)
  // ---------------------------------------------------------------------
  async function renderSettings() {
    let usage = "";
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        usage = `${(est.usage / 1024 / 1024).toFixed(1)}MB 사용 중`;
      }
    } catch (e) {
      /* 무시 */
    }
    const shown = show(`
      ${topBar("설정", "/")}
      <main class="content">
        <section class="panel">
          <h2 class="panel-title">AI 연결 · <span class="${Ai.isConfigured() ? "ok" : "warn-text"}">${h(Ai.statusText())}</span></h2>
          <p class="hint">요약·문제 생성을 처리할 <b>내 AI 서버(프록시) 주소</b>를 입력하세요.
          <b>API 키는 여기에 넣지 마세요.</b> 키는 서버 쪽에만 보관해야 안전합니다.
          (예시 서버 코드: ai-proxy-worker.example.js)</p>
          <input id="aiUrl" type="url" placeholder="https://내-서버-주소" value="${h(Config.getAiUrl())}" />
          <div class="row-btns">
            <button id="clearAi" class="secondary-btn">연결 해제</button>
            <button id="saveAi" class="primary-btn">저장</button>
          </div>
          <p id="aiMsg" class="hint"></p>
        </section>
        <section class="panel">
          <h2 class="panel-title">저장소</h2>
          <p class="hint">모든 자료와 학습 기록은 이 기기의 브라우저(IndexedDB)에 저장됩니다. ${h(usage)}<br/>
          브라우저의 “사이트 데이터 삭제”를 하면 학습 기록도 지워지니 주의하세요.</p>
        </section>
      </main>`);
    if (!shown) return;
    bindCommon();
    on("#saveAi", "click", () => {
      const url = $("#aiUrl").value.trim();
      if (/sk-ant-|sk-[a-z0-9]{20,}/i.test(url)) {
        $("#aiUrl").value = "";
        $("#aiMsg").textContent = "API 키처럼 보이는 값이라 저장하지 않았습니다. 키가 아니라 서버 주소를 입력하세요.";
        return;
      }
      if (url && !/^https?:\/\//.test(url)) {
        $("#aiMsg").textContent = "http:// 또는 https:// 로 시작하는 주소를 입력하세요.";
        return;
      }
      Config.setAiUrl(url);
      renderSettings();
    });
    on("#clearAi", "click", () => {
      Config.setAiUrl("");
      renderSettings();
    });
  }

  function renderNotFound(message, backPath) {
    const shown = show(`${topBar("알 수 없음", backPath)}<main class="content"><p class="empty">${h(message)}</p></main>`);
    if (shown) bindCommon();
  }

  // ---------------------------------------------------------------------
  // 라우팅 디스패치
  // ---------------------------------------------------------------------
  async function render() {
    screenHash = window.location.hash || "";
    const route = Router.parseHash();
    switch (route.name) {
      case "home":
        return renderHome();
      case "settings":
        return renderSettings();
      case "subject":
        return renderSubject(route.subjectId);
      case "words":
        return renderWords(route.subjectId);
      case "wordAddText":
        return renderAddText(wordCtx(route.subjectId));
      case "wordAddPhoto":
        return renderAddPhoto(wordCtx(route.subjectId));
      case "wordReview":
        return renderWordReview(route.subjectId, route.materialId);
      case "content":
        return renderContent(route.subjectId);
      case "unit":
        return renderUnit(route.unitId);
      case "addText": {
        const ctx = await unitCtx(route.unitId);
        return ctx ? renderAddText(ctx) : renderNotFound("단원을 찾을 수 없습니다.", "/");
      }
      case "addPhoto": {
        const ctx = await unitCtx(route.unitId);
        return ctx ? renderAddPhoto(ctx) : renderNotFound("단원을 찾을 수 없습니다.", "/");
      }
      case "summary":
        return renderSummary(route.unitId);
      case "material":
        return renderMaterialDetail(route.materialId);
      case "studyWords":
        return UIQuiz.renderStudy({ scope: "words", subjectId: route.subjectId });
      case "studyUnit":
        return UIQuiz.renderStudy({ scope: "unit", unitId: route.unitId });
      case "test":
        return UIQuiz.renderTest(route.sessionId);
      case "result":
        return UIQuiz.renderResult(route.sessionId);
      default:
        return renderHome();
    }
  }

  return {
    render,
    // uiQuiz.js에서 공통 조각 재사용
    show,
    topBar,
    bindCommon,
    progressBar,
    loadingScreen,
    setLoadingText,
    renderNotFound,
    showError,
    flash,
    $,
    $all,
    on,
  };
})();
