// state.js
// 페이지를 새로 불러오지 않고 화면을 전환하는 가벼운 해시 라우터.
//
// 화면 흐름: 과목 → 학습 방식(단어 암기 / 내용 암기) → 단원 → 자료 → 학습/시험
const ROUTES = [
  ["/", "home"],
  ["/settings", "settings"],
  ["/subject/:subjectId", "subject"],
  ["/subject/:subjectId/words", "words"],
  ["/subject/:subjectId/words/add-text", "wordAddText"],
  ["/subject/:subjectId/words/add-photo", "wordAddPhoto"],
  ["/subject/:subjectId/words/review/:materialId", "wordReview"],
  ["/subject/:subjectId/content", "content"],
  ["/unit/:unitId", "unit"],
  ["/unit/:unitId/add-text", "addText"],
  ["/unit/:unitId/add-photo", "addPhoto"],
  ["/unit/:unitId/summary", "summary"],
  ["/material/:materialId", "material"],
  ["/study/words/:subjectId", "studyWords"],
  ["/study/unit/:unitId", "studyUnit"],
  ["/test/:sessionId", "test"],
  ["/result/:sessionId", "result"],
];

window.Router = (function () {
  function match(pattern, parts) {
    const p = pattern.split("/").filter(Boolean);
    if (p.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < p.length; i++) {
      if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (p[i] !== parts[i]) return null;
    }
    return params;
  }

  function parseHash() {
    const hash = window.location.hash.replace(/^#/, "") || "/";
    const parts = hash.split("?")[0].split("/").filter(Boolean);
    for (const [pattern, name] of ROUTES) {
      const params = match(pattern, parts);
      if (params) return { name, ...params };
    }
    return { name: "home" };
  }

  function navigate(path) {
    if (window.location.hash === "#" + path) {
      // 같은 주소로 이동하면 hashchange가 안 생기므로 직접 다시 그린다.
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      window.location.hash = path;
    }
  }

  /** 기록을 남기지 않고 이동 (시험 생성 → 시험 화면처럼 되돌아가면 안 되는 경우). */
  function replace(path) {
    const url = window.location.href.split("#")[0] + "#" + path;
    window.location.replace(url);
  }

  function back() {
    window.history.back();
  }

  function onChange(handler) {
    window.addEventListener("hashchange", handler);
    window.addEventListener("load", handler);
  }

  return { parseHash, navigate, replace, back, onChange };
})();
