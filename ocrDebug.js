// ocrDebug.js
// 사진 OCR 파이프라인을 사람이 확인하기 위한 도구 (ocr-test.html과 자동 테스트에서 사용, 앱 동작에는 영향 없음).
//  - 글자 오류율(CER): 정답 글과 비교 (공백 무시, 자모가 아니라 글자 단위)
//  - 구조 정확도: 정답 전사본(JSON)과 제목·질문·대제목·소제목·본문·신념화를 칸별로 비교
//  - 워터마크 잔존: 워터마크 조각이 결과에 남았는지
window.OcrDebug = (function () {
  const squash = (s) => String(s || "").replace(/\s+/g, "");

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Uint32Array(b.length + 1).map((_, i) => i);
    let cur = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }

  /** 글자 오류율 (0 = 완벽). ref가 길면 앞뒤 3000자씩만 비교하지 않고 줄 단위로 나눠 합산한다. */
  function cer(ref, hyp) {
    const r = squash(ref);
    const h = squash(hyp);
    if (!r.length) return h.length ? 1 : 0;
    if (r.length * h.length < 40e6) return levenshtein(r, h) / r.length;
    return Math.abs(r.length - h.length) / r.length; // 너무 길면 근사
  }

  /** 정답 전사본 한 쪽 → 사람이 읽는 순서의 글 (본문 비교용) */
  function groundTruthText(g) {
    const out = [];
    out.push(`${g.chapter} (${g.lesson})`);
    out.push(g.question.text);
    for (const s of g.sections) {
      out.push(s.title);
      out.push(...s.content);
      for (const sub of s.subsections) {
        out.push(sub.title);
        out.push(...sub.content);
      }
    }
    out.push(...g.beliefContent);
    return out.join("\n");
  }

  /** 구조 결과 한 쪽 → 같은 순서의 글 */
  function pageText(p) {
    const out = [];
    if (p.title) out.push(p.title);
    if (p.question) out.push(p.question.text);
    for (const s of p.sections) {
      if (s.title) out.push(s.title);
      out.push(...s.content);
      for (const sub of s.subsections) {
        out.push(sub.title);
        out.push(...sub.content);
      }
    }
    out.push(...p.beliefContent);
    return out.join("\n");
  }

  /** 칸별 비교. 반환: { total, exact, items:[{field, ok, got, want}] } */
  function compareStructure(p, g) {
    const n = (s) => Utils.normalizeText(s || "");
    const items = [];
    const chk = (field, got, want) => items.push({ field, ok: n(got) === n(want), got: got == null ? null : String(got), want: String(want) });
    p = p || DocStructure.emptyPage();
    chk("chapter(제목)", p.chapter, g.chapter);
    chk("lesson(소단원)", p.lesson, g.lesson);
    chk("question.number", p.question && p.question.number, g.question.number);
    chk("question.text", p.question && p.question.text, g.question.text);
    chk("question.starred", String(!!(p.question && p.question.starred)), String(!!g.question.starred));
    chk("question.tags", p.question && p.question.tags.join(","), g.question.tags.join(","));
    chk("pageLabel(쪽 번호)", p.pageLabel, g.pageLabel);
    chk("sections 수", p.sections.length, g.sections.length);
    g.sections.forEach((s, k) => {
      const ps = p.sections[k] || { content: [], subsections: [] };
      chk(`${k + 1}. 대제목`, ps.title, s.title);
      chk(`${k + 1}. 본문 줄 수`, ps.content.length, s.content.length);
      s.content.forEach((c, j) => chk(`${k + 1}. 본문 ${j + 1}`, ps.content[j], c));
      chk(`${k + 1}. 소제목 수`, ps.subsections.length, s.subsections.length);
      s.subsections.forEach((sub, j) => {
        const psub = ps.subsections[j] || { content: [] };
        chk(`${k + 1}-${j + 1} 소제목`, psub.title, sub.title);
        sub.content.forEach((c, m) => chk(`${k + 1}-${j + 1} 본문 ${m + 1}`, psub.content[m], c));
      });
    });
    chk("신념화 항목 수", p.beliefContent.length, g.beliefContent.length);
    g.beliefContent.forEach((b, j) => chk(`신념화 ${j + 1}`, p.beliefContent[j], b));
    return { total: items.length, exact: items.filter((i) => i.ok).length, items };
  }

  /** 결과 글에 워터마크 조각이 남아 있는지 */
  function watermarkLeft(text, watermark) {
    if (!watermark) return [];
    const pieces = String(watermark)
      .split(/[\/\s]+/)
      .filter((p) => p.length >= 2);
    return pieces.filter((p) => String(text).includes(p));
  }

  /** 파이프라인 결과 + 정답(선택) → 한 번에 보는 리포트 */
  function report(result, groundtruth) {
    const pages = result.images.map((im, i) => {
      const struct = result.structure.pages[i] || null;
      const out = {
        page: i + 1,
        ms: im.ms,
        preprocess: im.pre,
        regions: im.regions.map((r) => ({ kind: r.kind, index: r.index, variants: Object.keys(r.variants), lines: r.consensus.lines.length, dropped: r.consensus.dropped.length })),
        cleanup: result.cleanup.log.filter((l) => l.page === i + 1).length,
      };
      const g = groundtruth && groundtruth.pages ? groundtruth.pages[i] : null;
      if (g) {
        const gt = groundTruthText(g);
        const rawNoWm = im.rawText;
        out.cerRaw = cer(gt, rawNoWm);
        out.cerFinal = struct ? cer(gt, pageText(struct)) : null;
        const cmp = struct ? compareStructure(struct, g) : null;
        out.structure = cmp ? { exact: cmp.exact, total: cmp.total, pct: Math.round((cmp.exact / cmp.total) * 1000) / 10, misses: cmp.items.filter((x) => !x.ok) } : null;
        out.watermarkLeft = watermarkLeft(struct ? pageText(struct) : result.texts[i], groundtruth.watermark);
        out.watermarkInRaw = watermarkLeft(im.rawText, groundtruth.watermark);
      }
      return out;
    });
    const tot = pages.filter((p) => p.structure);
    return {
      pages,
      summary: tot.length
        ? {
            structurePct: Math.round((tot.reduce((s, p) => s + p.structure.exact, 0) / tot.reduce((s, p) => s + p.structure.total, 0)) * 1000) / 10,
            cerRaw: Math.round((tot.reduce((s, p) => s + p.cerRaw, 0) / tot.length) * 1000) / 10,
            cerFinal: Math.round((tot.reduce((s, p) => s + p.cerFinal, 0) / tot.length) * 1000) / 10,
            watermarkLeftPages: tot.filter((p) => p.watermarkLeft.length).length,
          }
        : null,
      cleanupCounts: result.cleanup.counts,
      termMap: result.cleanup.termMap,
      watermark: result.cleanup.watermark,
      ai: { status: result.ai.status, method: result.ai.method, applied: result.ai.applied.length, uncertain: result.ai.uncertain.length, unverified: result.ai.unverified.length },
      ms: result.ms,
    };
  }

  return { cer, levenshtein, groundTruthText, pageText, compareStructure, watermarkLeft, report };
})();
