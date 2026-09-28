// ocrCorrection.js
// OCR 결과를 AI가 문맥으로 보정하되, "교정은 허용 · 지식 추가는 금지"를 코드로 강제한다.
//
//   사진 → OCR → [OCR 원문 보존] → AI 문맥 보정 제안 → 안전장치 검사 → 정제된 학습자료
//
// AI는 "바꿔야 할 부분"만 { page, raw(원문 그대로), corrected, confidence, reason } 목록으로 돌려준다.
// 앱은 제안 하나하나를 검사해서
//   - 적용(apply):  띄어쓰기·줄바꿈·구두점만 다름, 또는 자모 한두 개 차이의 오인식 교정
//   - 확인(confirm): AI가 확신하지 못함 / 숫자가 바뀜 / 변경 폭이 큼 → 자동 수정하지 않고
//                    "⚠️ ‘대한민국’으로 추정됨"처럼 사용자에게 보여준다
//   - 거부(reject): 원문보다 내용이 늘어남(새 정보 추가 의심) 또는 원문과 너무 다름
// OCR 원문(rawText / rawOcrText)은 어떤 경우에도 수정하지 않는다.
window.OcrCorrection = (function () {
  const TA = () => TextAnalysis;

  const LOOKALIKE_DIGITS = { l: "1", I: "1", "|": "1", "ㅣ": "1", O: "0", o: "0", "ㅇ": "0", S: "5", B: "8", Z: "2", g: "9" };

  function digitsOf(s) {
    return String(s || "").replace(/\D/g, "");
  }

  /** 숫자가 섞인 낱말 안의 비슷한 모양 글자(l→1, O→0 …)를 숫자로 본 결과 */
  function lookalikeDigits(s) {
    return String(s || "")
      .split(/\s+/)
      .map((tok) => (/[0-9]/.test(tok) ? tok.replace(/[lI|ㅣOoㅇSBZg]/g, (c) => LOOKALIKE_DIGITS[c]) : tok))
      .join(" ")
      .replace(/\D/g, "");
  }

  /**
   * 제안 하나를 판정한다.
   * @returns {{verdict: 'apply'|'confirm'|'reject', why: string}}
   */
  function judgeChange(raw, corrected, confidence) {
    const nr = Utils.normalizeText(raw);
    const nc = Utils.normalizeText(corrected);
    if (!nr || !String(corrected || "").trim()) return { verdict: "reject", why: "빈 제안" };
    if (nr === nc) return { verdict: "apply", why: "띄어쓰기·줄바꿈·기호 정리" };

    const jr = TA().toJamo(raw).length;
    const growth = TA().toJamo(corrected).length - jr;
    const ratio = TA().jamoEditRatio(raw, corrected);
    if (growth > Math.max(3, jr * 0.25)) return { verdict: "reject", why: "원문보다 내용이 늘어남 (새 정보 추가 의심)" };
    if (ratio > 0.45) return { verdict: "reject", why: "원문과 너무 다름" };

    const dr = digitsOf(raw);
    const dc = digitsOf(corrected);
    if (dr !== dc && lookalikeDigits(raw) !== dc) return { verdict: "confirm", why: "숫자가 바뀌는 수정이라 확인이 필요합니다" };
    if (confidence === "low") return { verdict: "confirm", why: "AI가 확신하지 못한 부분입니다" };
    if (ratio > 0.3) return { verdict: "confirm", why: "변경 폭이 커서 확인이 필요합니다" };
    return { verdict: "apply", why: "OCR 오인식 교정" };
  }

  /** 공백 차이를 무시하고 needle을 찾는다. → { index, length } | null */
  function findLoose(text, needle, from) {
    const chars = Array.from(String(needle || "").replace(/\s+/g, ""));
    if (!chars.length) return null;
    const pattern = chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
    const re = new RegExp(pattern, "g");
    re.lastIndex = from || 0;
    const m = re.exec(text);
    return m ? { index: m.index, length: m[0].length } : null;
  }

  /** 한 페이지 텍스트에 제안들을 검사·적용한다. */
  function applyToText(text, changes) {
    const accepted = [];
    const applied = [];
    const uncertain = [];
    const rejected = [];
    let cursor = 0;
    const overlaps = (a) => accepted.some((b) => a.index < b.index + b.length && b.index < a.index + a.length);

    for (const ch of changes) {
      const raw = String(ch.raw || "");
      const corrected = String(ch.corrected || "");
      let pos = findLoose(text, raw, cursor) || findLoose(text, raw, 0);
      if (!pos || overlaps(pos)) {
        rejected.push({ from: raw, to: corrected, why: "원문에서 해당 부분을 찾지 못함" });
        continue;
      }
      const found = text.slice(pos.index, pos.index + pos.length);
      const { verdict, why } = judgeChange(found, corrected, ch.confidence);
      if (verdict === "apply") {
        accepted.push({ ...pos, corrected });
        applied.push({ from: found, to: corrected, reason: ch.reason || why });
        cursor = pos.index + pos.length;
      } else if (verdict === "confirm") {
        uncertain.push({ from: found, to: corrected, reason: ch.reason ? `${ch.reason} · ${why}` : why });
      } else {
        rejected.push({ from: found, to: corrected, why });
      }
    }
    let out = text;
    for (const a of accepted.sort((x, y) => y.index - x.index)) {
      out = out.slice(0, a.index) + a.corrected + out.slice(a.index + a.length);
    }
    return { text: out, applied, uncertain, rejected };
  }

  /**
   * 여러 장(페이지)을 한 묶음으로 보정한다. 페이지가 이어지는 문맥을 AI가 함께 보도록
   * 모든 페이지를 한 번에 보낸다.
   * @param {string[]} pageTexts OCR 원문 (페이지 순서대로)
   * @returns {Promise<{status, message, pages:[{raw, final, applied, uncertain}], rejected}>}
   */
  async function correctPages(pageTexts) {
    const pages = pageTexts.map((t) => ({ raw: t || "", final: t || "", applied: [], uncertain: [] }));
    if (!pageTexts.some((t) => (t || "").trim())) {
      return { status: "empty", message: "", pages, rejected: [] };
    }
    if (!Ai.isConfigured()) {
      return { status: "unavailable", message: "AI 분석을 사용할 수 없어 기본 분석으로 생성했습니다. (OCR 원문을 그대로 사용합니다)", pages, rejected: [] };
    }
    let changes;
    try {
      changes = await Ai.correctOcr({ pages: pageTexts.map((text, i) => ({ page: i + 1, text })) });
    } catch (err) {
      console.warn("AI 문맥 보정 실패:", err);
      return {
        status: "failed",
        message: `AI 분석을 사용할 수 없어 기본 분석으로 생성했습니다. (OCR 원문을 그대로 사용합니다 · ${err.message || err})`,
        pages,
        rejected: [],
      };
    }
    const rejected = [];
    pages.forEach((p, i) => {
      const mine = changes.filter((c) => Number(c.page || 1) === i + 1);
      const r = applyToText(p.raw, mine);
      p.final = r.text;
      p.applied = r.applied;
      p.uncertain = r.uncertain;
      rejected.push(...r.rejected.map((x) => ({ page: i + 1, ...x })));
    });
    const appliedCount = pages.reduce((s, p) => s + p.applied.length, 0);
    const uncertainCount = pages.reduce((s, p) => s + p.uncertain.length, 0);
    return {
      status: "ai",
      message: appliedCount || uncertainCount ? `AI 문맥 보정 ${appliedCount}곳 적용${uncertainCount ? ` · 확인 필요 ${uncertainCount}곳` : ""}` : "AI가 확인한 결과 고칠 OCR 오류가 없습니다.",
      pages,
      rejected,
    };
  }

  /** 사용자가 "⚠️ 추정" 항목을 적용할 때: 해당 부분만 바꾼다. */
  function applySuggestion(text, item) {
    const pos = findLoose(text, item.from, 0);
    if (!pos) return text;
    return text.slice(0, pos.index) + item.to + text.slice(pos.index + pos.length);
  }

  return { correctPages, applyToText, judgeChange, applySuggestion, findLoose };
})();
