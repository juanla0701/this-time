// config.js
// GitHub Pages는 정적 호스팅이라 이 파일에 넣은 값은 누구나 브라우저 개발자 도구로
// 볼 수 있다. 그래서 Claude/OpenAI API 키 같은 비밀 값은 절대 여기 넣지 않는다.
//
// 여기에는 "AI 요청을 대신 처리해 줄 내 백엔드/서버리스 함수의 주소(endpoint)"만 둔다.
// 실제 API 키는 그 백엔드(예: Cloudflare Workers, Vercel Functions)의 환경변수에만
// 저장한다. 요청/응답 형식은 ai.js 상단 주석과 ai-proxy-worker.example.js 참고.
//
// AI_API_URL을 비워두면 앱은 "AI 연결 필요" 상태로 동작한다. 이때도 과목/단원/자료/
// OCR/단어 시험/기본 출제 시험은 모두 정상 동작한다 (기본 출제는 자료 문장만 사용).
window.Config = (function () {
  // 예: "https://exam-memo-ai.내계정.workers.dev"
  const AI_API_URL = "";

  // 코드를 수정하지 않고도 앱의 [설정] 화면에서 주소를 넣을 수 있게 한다.
  // (endpoint 주소는 비밀이 아니므로 브라우저에 저장해도 된다. 키는 절대 저장하지 않는다.)
  const LOCAL_KEY = "examMemo.aiApiUrl";

  function getAiUrl() {
    try {
      const saved = localStorage.getItem(LOCAL_KEY);
      if (saved && saved.trim()) return saved.trim();
    } catch (e) {
      /* 사생활 보호 모드 등에서 localStorage 접근이 막혀도 앱은 계속 동작 */
    }
    return AI_API_URL;
  }

  function setAiUrl(url) {
    try {
      if (url && url.trim()) localStorage.setItem(LOCAL_KEY, url.trim());
      else localStorage.removeItem(LOCAL_KEY);
    } catch (e) {
      console.warn("AI 주소 저장 실패:", e);
    }
  }

  function isAiConfigured() {
    const url = getAiUrl();
    return typeof url === "string" && /^https?:\/\//.test(url);
  }

  return { AI_API_URL, getAiUrl, setAiUrl, isAiConfigured };
})();
