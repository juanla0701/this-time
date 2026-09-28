// ocr.js
// 브라우저에서 동작하는 한국어 OCR (영어 전용 OCR 사용 금지).
// Tesseract.js(WebAssembly 기반)를 CDN에서 불러와 사용한다 (index.html 참고).
// 'kor' 학습 데이터는 최초 인식 시 한 번 받아오고 브라우저가 캐시한다.
//
// v4: 사진 한 장을 통째로 읽지 않고, 전처리된 이미지의 "영역"(제목·질문·본문 칸·신념화 칸·쪽 번호)을
//     잘라서 영역별로 읽는다. 같은 영역을 전처리 방식이 다른 이미지 2~3개로 읽어 ocrConsensus.js가 합의한다.
//   - recognize(blob)                    : 예전 방식(사진 전체) — 기존 호출부 호환
//   - recognizeRegion(image, opts)       : 영역 하나 → { text, confidence, lines:[{text, confidence, bbox}] }
//   - 엔진 교체 훅: window.__OCR_ENGINE_OVERRIDE = async (image, meta) => ({ text, confidence, lines })
//       meta = { pageIndex, region:{kind,index,x,y,w,h}, variant:"A"|"B"|"C", psm }
//     테스트(실제 사진 + 정답 전사본)와 다른 OCR 엔진을 붙일 때 쓴다.
window.Ocr = (function () {
  let workerPromise = null;
  let currentPsm = null;

  async function getWorker() {
    if (!workerPromise) {
      if (typeof Tesseract === "undefined") {
        throw new Error("Tesseract.js가 로드되지 않았습니다. 네트워크 연결을 확인해주세요.");
      }
      workerPromise = Tesseract.createWorker("kor");
    }
    return workerPromise;
  }

  /** 사진 한 장을 인식한다 (예전 방식). 실패해도 예외를 던지지 않고 success:false로 알려준다. */
  async function recognize(blobOrUrl) {
    try {
      if (window.__OCR_ENGINE_OVERRIDE) {
        const r = await window.__OCR_ENGINE_OVERRIDE(blobOrUrl, { pageIndex: 0, region: { kind: "page" }, variant: "orig", psm: 3 });
        return { success: true, text: String((r && r.text) || "").trim() };
      }
      const worker = await getWorker();
      await setPsm(worker, "3");
      const { data } = await worker.recognize(blobOrUrl);
      const text = data && data.text ? data.text.trim() : "";
      return { success: true, text };
    } catch (err) {
      console.warn("OCR 실패 (사용자에게 직접 입력 안내):", err);
      return { success: false, text: "", error: String(err) };
    }
  }

  async function setPsm(worker, psm) {
    if (currentPsm === psm || !worker.setParameters) return;
    try {
      await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: "1" });
      currentPsm = psm;
    } catch (e) {
      console.warn("PSM 설정 실패 (기본값으로 진행):", e);
    }
  }

  /** Tesseract 결과에서 줄 목록 꺼내기 (버전별로 lines 위치가 다름). */
  function linesOf(data) {
    let lines = Array.isArray(data.lines) ? data.lines : [];
    if (!lines.length && Array.isArray(data.blocks)) {
      for (const b of data.blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push(l);
    }
    return lines
      .map((l) => ({ text: String(l.text || "").replace(/\s+$/g, ""), confidence: Number(l.confidence) || 0, bbox: l.bbox || null }))
      .filter((l) => l.text.trim());
  }

  /** 영역 종류별 Tesseract 페이지 분할 모드: 한 줄짜리는 7, 여러 줄 칸은 6(균일한 글 덩어리). */
  function psmFor(kind) {
    if (kind === "header" || kind === "footer") return "7";
    if (kind === "label") return "6";
    return "6";
  }

  /**
   * 잘라낸 영역 이미지 하나를 읽는다.
   * @param {HTMLCanvasElement|Blob} image
   * @param {{pageIndex:number, region:object, variant:string}} meta
   * @returns {Promise<{success:boolean, text:string, confidence:number, lines:object[], error?:string}>}
   */
  async function recognizeRegion(image, meta) {
    const psm = psmFor(meta && meta.region && meta.region.kind);
    try {
      let r;
      if (window.__OCR_ENGINE_OVERRIDE) {
        r = await window.__OCR_ENGINE_OVERRIDE(image, { ...(meta || {}), psm: Number(psm) });
        r = r || {};
        const lines = Array.isArray(r.lines)
          ? r.lines.map((l) => ({ text: String(l.text || ""), confidence: Number(l.confidence) || 0, bbox: l.bbox || null }))
          : String(r.text || "")
              .split(/\r?\n/)
              .filter((t) => t.trim())
              .map((t) => ({ text: t, confidence: Number(r.confidence) || 70, bbox: null }));
        const text = lines.map((l) => l.text).join("\n");
        const confidence = lines.length ? lines.reduce((s, l) => s + l.confidence, 0) / lines.length : 0;
        return { success: true, text, confidence, lines };
      }
      const worker = await getWorker();
      await setPsm(worker, psm);
      const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
      let lines = linesOf(data || {});
      const conf = Number(data && data.confidence) || 0;
      if (!lines.length && data && data.text) {
        // 줄 정보가 없는 결과(구버전·다른 엔진): 글을 줄로 나누고 전체 신뢰도를 쓴다
        lines = String(data.text)
          .split(/\r?\n/)
          .filter((t) => t.trim())
          .map((t) => ({ text: t.replace(/\s+$/g, ""), confidence: conf || 60, bbox: null }));
      }
      const text = lines.map((l) => l.text).join("\n");
      return { success: true, text, confidence: conf, lines };
    } catch (err) {
      console.warn("영역 OCR 실패:", meta, err);
      return { success: false, text: "", confidence: 0, lines: [], error: String(err) };
    }
  }

  /** 여러 장을 순서대로 처리한다 (예전 방식). 일부가 실패해도 나머지는 계속 진행한다. */
  async function recognizeMany(blobs, onProgress) {
    const results = [];
    for (let i = 0; i < blobs.length; i++) {
      const result = await recognize(blobs[i]);
      results.push(result);
      if (onProgress) onProgress(i + 1, blobs.length);
    }
    return results;
  }

  return { recognize, recognizeRegion, recognizeMany, psmFor };
})();
