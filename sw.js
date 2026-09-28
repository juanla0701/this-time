// sw.js
// 앱 셸(HTML/CSS/JS)만 캐시한다. IndexedDB의 실제 학습 데이터는 서비스워커와
// 무관하게 브라우저에 계속 남아있다.
//
// 전략: "네트워크 우선, 실패하면 캐시". GitHub에서 파일을 고쳐 올리면 다음 접속 때
// 바로 새 코드가 적용되고, 오프라인일 때만 캐시된 앱 셸을 쓴다.
// 캐시/네트워크가 모두 실패해도 첫 실행 자체를 막지 않는다.
const CACHE_NAME = "exam-memo-cache-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./utils.js",
  "./storage.js",
  "./state.js",
  "./config.js",
  "./textAnalysis.js",
  "./ai.js",
  "./ocrCorrection.js",
  "./learning.js",
  "./subjects.js",
  "./units.js",
  "./imageStorage.js",
  "./materials.js",
  "./ocr.js",
  "./layoutAnalysis.js",
  "./imagePreprocess.js",
  "./ocrConsensus.js",
  "./docCleanup.js",
  "./docStructure.js",
  "./structureLearning.js",
  "./docPipeline.js",
  "./ocrDebug.js",
  "./ocr-test.html",
  "./summary.js",
  "./quiz.js",
  "./questionQuality.js",
  "./quizGenerator.js",
  "./wordStudy.js",
  "./quizResult.js",
  "./wrongAnswers.js",
  "./ui.js",
  "./uiQuiz.js",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.warn("앱 셸 캐싱 실패 (치명적이지 않음):", err))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // 외부 요청(Tesseract CDN, AI 서버 등)과 GET이 아닌 요청은 관여하지 않는다.
  if (event.request.method !== "GET" || !event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
