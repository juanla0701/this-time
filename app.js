// app.js
// 앱 시작점. index.html이 모든 모듈 스크립트를 로드한 뒤 마지막에 실행된다.
(function () {
  // 화면을 떠난 뒤 늦게 끝난 작업(OCR, AI 등)은 ui.js의 show()가 무시하므로
  // 여기서는 렌더를 줄 세우지 않고 바로 그린다 (뒤로가기가 막히지 않도록).
  Router.onChange(() => {
    UI.render().catch((err) => console.error("화면을 그리는 중 오류:", err));
  });

  // 브라우저가 저장 공간이 부족할 때 이 앱 데이터를 임의로 지우지 않도록 요청 (지원 브라우저만).
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // PWA: 서비스워커는 있으면 좋지만 없어도 기본 웹 실행은 정상 동작해야 한다.
  window.addEventListener("load", () => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch((err) => {
        console.warn("서비스워커 등록 실패 (앱 실행에는 영향 없음):", err);
      });
    }
  });
})();
