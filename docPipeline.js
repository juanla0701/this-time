// docPipeline.js
// 사진 → 학습용 문서까지의 전체 흐름을 한곳에서 조율한다.
//
//   사진(원본 보존)
//    → ImagePreprocess.process : 조명 평탄화 · 대비 · 기울기 · 원근 보정 · 변형 A/B/C
//    → LayoutAnalysis(내부)   : 표 괘선으로 제목 / 질문 / 라벨 / 본문 칸 / 신념화 칸 / 쪽 번호 영역 나누기
//    → Ocr.recognizeRegion     : 영역별로, 변형별로 읽기 (B·C 먼저, 둘이 다르면 A·원본까지)
//    → OcrConsensus.merge      : 줄 맞추기 + 낱말 투표
//    → DocCleanup              : 워터마크 · 쪽 번호 · 잡음 제거, 기호 정리, 문서 내 빈도로 용어 통일
//    → DocStructure            : 제목 · 질문 · 대제목 · 소제목 · 본문 · 신념화 구조(JSON)
//    → (AI 연결 시) Ai.analyzeDocument : 원본 이미지 + OCR + 이전 쪽 구조 → AI 구조
//         → DocStructure.mergeAi : 교정만 받아들이고, 근거 없는 줄은 사용자 확인 대기
//       (analyzeDocument를 지원하지 않는 AI 서버면 예전 correctOcr 보정으로 대체)
//   AI가 없으면 OCR + 규칙 교정 + 구조 추정까지만 한다.
//
// 결과의 rawText는 OCR이 읽은 그대로(합의 결과, 정리 전), finalText는 정리·보정·구조화된 글이다.
window.DocPipeline = (function () {
  const UNAVAILABLE_MSG = "AI 분석을 사용할 수 없어 기본 분석으로 생성했습니다. (OCR + 규칙 교정 + 구조 추정 결과를 사용합니다)";

  function regionOrder(r) {
    const order = { header: 0, question: 1, label: 2, block: 2, footer: 9, page: 5 };
    return (order[r.kind] ?? 5) * 100 + (r.index || 0) * 2 + (r.kind === "block" ? 1 : 0);
  }

  async function readRegion(file, pre, region, pageIndex, log) {
    const results = [];
    const w = pre ? pre.width : 0;
    const h = pre ? pre.height : 0;
    const upscale = region.kind === "label" ? 2 : pre && pre.width < 1800 ? 1.5 : 1;
    const variantOf = (name) => pre && pre.variants.find((v) => v.name === name);
    const run = async (name) => {
      let image;
      if (name === "orig") image = file;
      else {
        const v = variantOf(name);
        if (!v) return;
        image = ImagePreprocess.cropCanvas(v.gray, w, h, region, upscale);
      }
      const t0 = performance.now();
      const r = await Ocr.recognizeRegion(image, { pageIndex, region, variant: name });
      log.push({ page: pageIndex + 1, region: region.kind + (region.index ?? ""), variant: name, ms: Math.round(performance.now() - t0), ok: r.success, chars: r.text.length, confidence: Math.round(r.confidence) });
      results.push({ variant: name, ...r });
    };
    const textOf = (n) => (results.find((r) => r.variant === n) || {}).text || "";

    if (!pre) {
      await run("orig");
    } else if (region.kind === "label" || region.kind === "footer") {
      await run("B");
    } else {
      await run("B");
      await run("C");
      const agree = textOf("B").trim() && TextAnalysis.similarity(textOf("B"), textOf("C")) >= 0.97;
      if (!agree) await run("A");
      // 표를 못 찾은 사진(일반 노트·프린트): 전처리 결과가 비어 있거나 서로 다르면 원본 사진으로도 읽는다
      if (region.kind === "page" && !agree) await run("orig");
    }
    const merged = OcrConsensus.merge(results.filter((r) => r.success));
    return {
      kind: region.kind,
      index: region.index,
      box: { x: region.x, y: region.y, w: region.w, h: region.h },
      variants: Object.fromEntries(results.map((r) => [r.variant, { text: r.text, confidence: Math.round(r.confidence), ok: r.success, error: r.error || null }])),
      consensus: {
        text: merged.text,
        base: merged.base,
        lines: merged.lines.map((l) => ({ text: l.text, agree: l.agree, of: l.of, method: l.method, confidence: Math.round(l.confidence) })),
        dropped: merged.dropped,
      },
      failed: results.length > 0 && results.every((r) => !r.success),
    };
  }

  async function processedBlobOf(pre) {
    try {
      const c = ImagePreprocess.grayToCanvas(pre.gray, pre.width, pre.height);
      return await ImagePreprocess.canvasToBlob(c, "image/jpeg", 0.85);
    } catch (e) {
      return null;
    }
  }

  /** 사진 한 장: 전처리 → 영역 → 영역별 다중 OCR → 합의 */
  async function readImage(file, pageIndex, onStage, keepDebug) {
    const t0 = performance.now();
    const ocrLog = [];
    let pre = null;
    let preError = null;
    try {
      onStage && onStage("preprocess");
      pre = await ImagePreprocess.process(file);
    } catch (err) {
      preError = String(err && err.message ? err.message : err);
      console.warn("이미지 전처리 실패 → 원본 사진으로 OCR:", err);
    }
    const regions = pre && pre.layout && pre.layout.found ? pre.layout.regions.slice() : [{ kind: "page", x: 0, y: 0, w: pre ? pre.width : 0, h: pre ? pre.height : 0 }];
    regions.sort((a, b) => regionOrder(a) - regionOrder(b));
    onStage && onStage("ocr");
    const read = [];
    for (const r of regions) read.push(await readRegion(file, pre, r, pageIndex, ocrLog));
    const rawText = read
      .filter((r) => r.kind !== "label")
      .map((r) => r.consensus.text)
      .filter((t) => t.trim())
      .join("\n");
    return {
      file,
      pageIndex,
      pre: pre
        ? {
            width: pre.width,
            height: pre.height,
            scale: pre.scale,
            deskewAngle: pre.deskewAngle,
            perspective: pre.perspective,
            layoutFound: !!pre.layout.found,
            table: pre.layout.table,
            timings: Object.fromEntries(Object.entries(pre.timings).map(([k, v]) => [k, Math.round(v)])),
          }
        : null,
      preError,
      processedBlob: pre ? await processedBlobOf(pre) : null,
      layoutRaw: pre ? pre.layout : null,
      debug: keepDebug && pre ? { gray: pre.gray, width: pre.width, height: pre.height, variants: pre.variants.map((v) => ({ name: v.name, label: v.label })) } : null,
      regions: read,
      rawText,
      ocrFailed: !rawText.trim(),
      ocrLog,
      ms: Math.round(performance.now() - t0),
    };
  }

  function countBy(list, key) {
    const out = {};
    for (const x of list) out[x[key]] = (out[x[key]] || 0) + 1;
    return out;
  }

  /**
   * 전체 실행.
   * @param {Blob[]} files  페이지 순서대로
   * @param {{onProgress?:(stage:string, done:number, total:number)=>void, extraTexts?:string[], previousStructure?:object, useAi?:boolean}} opts
   */
  async function run(files, opts) {
    const o = opts || {};
    const progress = (stage, done) => o.onProgress && o.onProgress(stage, done, files.length);
    const t0 = performance.now();

    // 1) 사진별 전처리 + 다중 OCR
    const images = [];
    for (let i = 0; i < files.length; i++) {
      progress("ocr", i);
      images.push(await readImage(files[i], i, (s) => progress(s, i), !!o.keepDebug));
    }
    progress("cleanup", files.length);

    // 2) 문서 전체 정리 (워터마크·쪽 번호·잡음·용어 통일은 여러 쪽을 함께 봐야 정확하다)
    const cleanup = DocCleanup.cleanDocument(
      images.map((im) => ({ regions: im.regions.map((r) => ({ kind: r.kind, index: r.index, text: r.consensus.text })) })),
      { extraTexts: o.extraTexts || [] }
    );

    // 3) 구조 복원
    const localPages = cleanup.pages.map((p) => DocStructure.fromRegions(p));
    const localDoc = { version: 4, source: "local", pages: localPages };
    const structured = DocStructure.isStructured(localDoc);
    const plainText = (i) =>
      cleanup.pages[i].regions
        .filter((r) => r.kind !== "label")
        .map((r) => r.text)
        .filter((t) => t.trim())
        .join("\n");
    const localTexts = images.map((_, i) => (structured ? DocStructure.renderPage(localPages[i]) : plainText(i)));

    // 4) AI 문서 분석 (선택)
    const ai = { status: "unavailable", message: UNAVAILABLE_MSG, applied: [], uncertain: [], rejected: [], restored: [], unverified: [], errors: [], method: null };
    let pages = localPages.map((p) => JSON.parse(JSON.stringify(p)));
    let texts = localTexts.slice();
    const perImage = images.map(() => ({ applied: [], uncertain: [] }));
    const useAi = o.useAi !== false && window.Ai && Ai.isConfigured() && texts.some((t) => t.trim());
    if (useAi) {
      progress("ai", files.length);
      let analyzed = 0;
      if (structured) {
        let prev = o.previousStructure || null;
        for (let i = 0; i < images.length; i++) {
          try {
            const imageBase64 = await ImagePreprocess.toJpegBase64(images[i].file, 1600).catch(() => null);
            const aiPage = await Ai.analyzeDocument({
              pageIndex: i,
              pageCount: images.length,
              imageBase64,
              ocrRegions: images[i].regions.map((r) => ({ kind: r.kind, index: r.index, text: r.consensus.text })),
              ocrText: images[i].rawText,
              cleanedText: localTexts[i],
              localStructure: localPages[i],
              previousStructure: prev,
            });
            const m = DocStructure.mergeAi(localPages[i], aiPage);
            pages[i] = m.page;
            texts[i] = DocStructure.renderPage(m.page);
            perImage[i].applied = m.applied;
            perImage[i].uncertain = m.uncertain;
            ai.applied.push(...m.applied.map((x) => ({ page: i + 1, ...x })));
            ai.uncertain.push(...m.uncertain.map((x) => ({ page: i + 1, ...x })));
            ai.rejected.push(...m.rejected.map((x) => ({ page: i + 1, ...x })));
            ai.restored.push(...m.restored.map((x) => ({ page: i + 1, ...x })));
            ai.unverified.push(...m.unverified.map((x) => ({ page: i + 1, ...x })));
            prev = m.page;
            analyzed++;
          } catch (err) {
            ai.errors.push(`${i + 1}쪽: ${err.message || err}`);
            console.warn("AI 문서 분석 실패:", err);
            prev = localPages[i];
          }
        }
      }
      if (analyzed > 0) {
        ai.status = "ai";
        ai.method = "analyzeDocument";
        ai.message = `AI가 사진과 OCR 결과를 함께 보고 문서 구조를 확인했습니다 (교정 ${ai.applied.length}곳${ai.uncertain.length ? `, 확인 필요 ${ai.uncertain.length}곳` : ""}${ai.unverified.length ? `, OCR 근거 없는 줄 ${ai.unverified.length}개는 학습에서 제외` : ""}).`;
      } else {
        // 예전 방식 AI 보정(correctOcr)으로 대체 — analyzeDocument를 지원하지 않는 AI 서버 호환
        const corr = await OcrCorrection.correctPages(texts);
        if (corr.status === "ai") {
          ai.status = "ai";
          ai.method = "correctOcr";
          ai.message = corr.message;
          corr.pages.forEach((p, i) => {
            texts[i] = p.final;
            perImage[i].applied = p.applied.slice();
            perImage[i].uncertain = p.uncertain.slice();
            ai.applied.push(...p.applied.map((x) => ({ page: i + 1, ...x })));
            ai.uncertain.push(...p.uncertain.map((x) => ({ page: i + 1, ...x })));
          });
          ai.rejected = (corr.rejected || []).slice();
          if (structured) pages = texts.map((t, i) => keepMeta(DocStructure.parseText(t).pages[0] || localPages[i], localPages[i]));
        } else {
          ai.status = corr.status === "empty" ? "empty" : "failed";
          const why = ai.errors[0] || (corr.status === "failed" ? String(corr.message || "").split(" · ").pop().replace(/\)$/, "").trim() : "");
          ai.message = corr.status === "empty" ? "" : `${UNAVAILABLE_MSG.replace(/\)$/, "")}${why ? ` · 원인: ${why}` : ""})`;
        }
      }
    }

    const structure = { version: 4, source: ai.status === "ai" ? "ai" : "local", structured, pages };
    progress("done", files.length);
    return {
      images,
      rawText: images.map((im) => im.rawText).join("\n\n"),
      rawTexts: images.map((im) => im.rawText),
      localTexts,
      texts,
      finalText: texts.join("\n\n"),
      localStructure: localDoc,
      structure,
      structured,
      perImage,
      cleanup: {
        log: cleanup.log,
        counts: countBy(cleanup.log, "type"),
        watermark: { samples: cleanup.watermark.samples, words: cleanup.watermark.words, digits: cleanup.watermark.digits },
        termMap: cleanup.termMap,
      },
      ai,
      ms: Math.round(performance.now() - t0),
    };
  }

  function keepMeta(page, from) {
    if (!page) return from;
    page.pageLabel = page.pageLabel || (from && from.pageLabel) || null;
    return page;
  }

  /**
   * 사용자가 확인 화면에서 글을 고친 뒤 저장할 때: 최종 글에서 구조를 다시 읽고,
   * 글에 드러나지 않는 정보(쪽 번호, 확인 대기 줄)는 분석 결과에서 이어받는다.
   */
  function structureFromTexts(texts, analyzed) {
    const pages = [];
    const prevPages = (analyzed && analyzed.pages) || [];
    texts.forEach((t) => {
      for (const p of DocStructure.parseText(t).pages) {
        // 쪽 순서대로 이어받되, 같은 쪽인지 질문으로 한 번 더 확인 (쪽 순서가 바뀐 경우 대비)
        const g = pages.length;
        const byQuestion = p.question ? prevPages.find((x) => x && x.question && x.question.text === p.question.text) : null;
        const from = byQuestion || prevPages[g] || null;
        if (from) {
          p.pageLabel = p.pageLabel || from.pageLabel || null;
          p.unverified = (from.unverified || []).slice();
        }
        pages.push(p);
      }
    });
    const doc = { version: 4, source: analyzed ? analyzed.source : "local", pages };
    doc.structured = DocStructure.isStructured(doc);
    return doc;
  }

  return { run, readImage, structureFromTexts, UNAVAILABLE_MSG };
})();
