// imagePreprocess.js
// OCR 전에 사진을 "읽기 좋은 문서 이미지"로 만든다. 원본 사진(Blob)은 절대 수정하지 않는다.
//
//   원본 → 회색조 → 조명 평탄화(그림자·누런 종이 제거) → 대비 강화 → 기울기 보정
//        → 표 괘선으로 원근 보정 → OCR용 변형 3가지
//           A: 평탄화 회색조      (Tesseract가 직접 이진화)
//           B: Otsu 이진화        (일반적인 흑백)
//           C: 진한 글자만        (연한 워터마크·뒷면 비침 제거에 강함)
//
// 무거운 처리(딥러닝 원근 보정 등)는 하지 않는다. 대신 AI 서버가 연결되면 원본 이미지를 함께 보내
// AI가 직접 사진을 보고 구조를 이해하게 한다(ai.js analyzeDocument).
window.ImagePreprocess = (function () {
  const MAX_SIDE = 2400;

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  async function loadBitmap(blob) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(blob, { imageOrientation: "from-image" });
      } catch (e) {
        /* 아래 방법으로 */
      }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function toGray(imageData) {
    const d = imageData.data;
    const g = new Uint8ClampedArray(d.length / 4);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    return g;
  }

  /**
   * "잉크 진하기" 채널: RGB 중 가장 어두운 값.
   * 빨강·파랑 글씨(예: ★민주주의와 헌법수호)는 밝기로 바꾸면 회색 워터마크만큼 연해지지만,
   * 가장 어두운 채널로 보면 검은 글씨처럼 진하게 남는다. 회색 워터마크는 세 채널이 같아서 그대로 연하다.
   */
  function toInk(imageData) {
    const d = imageData.data;
    const g = new Uint8ClampedArray(d.length / 4);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = Math.min(d[i], d[i + 1], d[i + 2]);
    return g;
  }

  function grayToCanvas(g, w, h) {
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(w, h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g[j];
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function canvasToGray(c) {
    const ctx = c.getContext("2d");
    return toGray(ctx.getImageData(0, 0, c.width, c.height));
  }

  // ------------------------------------------------------------------
  // 조명 평탄화: 배경(종이) 밝기를 추정해 나눈다 → 그림자, 한쪽만 어두운 조명, 누런 종이 제거
  // ------------------------------------------------------------------
  function flatten(g, w, h) {
    const f = 8; // 1/8 크기에서 배경 추정
    const sw = Math.max(1, Math.floor(w / f));
    const sh = Math.max(1, Math.floor(h / f));
    const small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let s = 0;
        for (let dy = 0; dy < f; dy++) {
          const row = (y * f + dy) * w + x * f;
          for (let dx = 0; dx < f; dx++) s += g[row + dx];
        }
        small[y * sw + x] = s / (f * f);
      }
    // 글자(어두운 점)를 지우도록 최댓값 필터 → 평균 필터
    const maxed = new Float32Array(sw * sh);
    const R = 3;
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let m = 0;
        for (let dy = -R; dy <= R; dy++) {
          const yy = Math.min(sh - 1, Math.max(0, y + dy));
          for (let dx = -R; dx <= R; dx++) {
            const v = small[yy * sw + Math.min(sw - 1, Math.max(0, x + dx))];
            if (v > m) m = v;
          }
        }
        maxed[y * sw + x] = m;
      }
    const bg = new Float32Array(sw * sh);
    const B = 4;
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -B; dy <= B; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= sh) continue;
          for (let dx = -B; dx <= B; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= sw) continue;
            s += maxed[yy * sw + xx];
            n++;
          }
        }
        bg[y * sw + x] = s / n;
      }
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1.001, Math.max(0, y / f - 0.5));
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1.001, Math.max(0, x / f - 0.5));
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const i00 = bg[y0 * sw + x0];
        const i10 = bg[y0 * sw + Math.min(sw - 1, x0 + 1)];
        const i01 = bg[Math.min(sh - 1, y0 + 1) * sw + x0];
        const i11 = bg[Math.min(sh - 1, y0 + 1) * sw + Math.min(sw - 1, x0 + 1)];
        const b = i00 * (1 - tx) * (1 - ty) + i10 * tx * (1 - ty) + i01 * (1 - tx) * ty + i11 * tx * ty;
        out[y * w + x] = Math.min(255, (g[y * w + x] / Math.max(b, 1)) * 245);
      }
    }
    return out;
  }

  function histogram(g) {
    const hst = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hst[g[i]]++;
    return hst;
  }

  function stretch(g) {
    const hst = histogram(g);
    const n = g.length;
    let acc = 0;
    let lo = 0;
    let hi = 255;
    for (let i = 0; i < 256; i++) {
      acc += hst[i];
      if (acc >= n * 0.01) {
        lo = i;
        break;
      }
    }
    acc = 0;
    for (let i = 255; i >= 0; i--) {
      acc += hst[i];
      if (acc >= n * 0.02) {
        hi = i;
        break;
      }
    }
    const range = Math.max(1, hi - lo);
    const out = new Uint8ClampedArray(g.length);
    for (let i = 0; i < g.length; i++) out[i] = ((g[i] - lo) * 255) / range;
    return out;
  }

  function otsu(g) {
    const hst = histogram(g);
    const total = g.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hst[i];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    let t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hst[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hst[i];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        t = i;
      }
    }
    return t;
  }

  /** 잉크로 분류된 픽셀만 다시 Otsu → 진한 글자 / 연한 워터마크·비침을 가르는 두 번째 문턱 */
  function secondOtsu(g, t) {
    const hst = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < g.length; i++)
      if (g[i] < t) {
        hst[g[i]]++;
        n++;
      }
    if (n < 100) return t;
    let sum = 0;
    for (let i = 0; i < t; i++) sum += i * hst[i];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    let t2 = t;
    for (let i = 0; i < t; i++) {
      wB += hst[i];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += i * hst[i];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        t2 = i + 1;
      }
    }
    // 가는 본문 글씨까지 깎아먹지 않도록: 잉크의 85% 이상은 남아야 한다
    // (워터마크·뒷면 비침은 전체 잉크의 작은 일부라서 이 범위 안에서 지워진다)
    let kept = 0;
    for (let i = 0; i < t2; i++) kept += hst[i];
    if (kept / n < 0.85) {
      let acc = 0;
      for (let i = 0; i < t; i++) {
        acc += hst[i];
        if (acc / n >= 0.85) return i + 1;
      }
    }
    return t2;
  }

  function binarize(g, t) {
    const out = new Uint8Array(g.length);
    for (let i = 0; i < g.length; i++) out[i] = g[i] < t ? 1 : 0;
    return out;
  }

  function binToGray(bin) {
    const out = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin[i] ? 0 : 255;
    return out;
  }

  // ------------------------------------------------------------------
  // 기울기 추정: 글자 줄이 수평일 때 가로 투영의 분산이 가장 크다
  // ------------------------------------------------------------------
  function estimateSkew(bin, w, h) {
    const step = 2;
    const pts = [];
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (bin[y * w + x]) pts.push(x, y);
    const score = (deg) => {
      const r = (deg * Math.PI) / 180;
      const s = Math.sin(r);
      const c = Math.cos(r);
      const bins = new Float32Array(h + w);
      for (let i = 0; i < pts.length; i += 2) {
        const yy = Math.round(pts[i + 1] * c - pts[i] * s + w);
        bins[yy >> 1] += 1;
      }
      let v = 0;
      for (let i = 0; i < bins.length; i++) v += bins[i] * bins[i];
      return v;
    };
    let best = 0;
    let bestScore = -1;
    for (let d = -5; d <= 5.001; d += 0.25) {
      const sc = score(d);
      if (sc > bestScore) {
        bestScore = sc;
        best = d;
      }
    }
    for (let d = best - 0.25; d <= best + 0.25; d += 0.05) {
      const sc = score(d);
      if (sc > bestScore) {
        bestScore = sc;
        best = d;
      }
    }
    return Math.round(best * 100) / 100;
  }

  function rotateGray(g, w, h, deg) {
    if (Math.abs(deg) < 0.05) return g;
    const src = grayToCanvas(g, w, h);
    const dst = makeCanvas(w, h);
    const ctx = dst.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((-deg * Math.PI) / 180);
    ctx.drawImage(src, -w / 2, -h / 2);
    return canvasToGray(dst);
  }

  // ------------------------------------------------------------------
  // 원근 보정: 표의 네 테두리 선으로 사다리꼴 → 직사각형
  // ------------------------------------------------------------------
  function solveHomography(src, dst) {
    // dst → src 로 가는 3x3 행렬 (역방향 매핑용)
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = dst[i];
      const [u, v] = src[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      [b[c], b[p]] = [b[p], b[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const hm = b.map((v, i) => v / A[i][i]);
    return [hm[0], hm[1], hm[2], hm[3], hm[4], hm[5], hm[6], hm[7], 1];
  }

  function warp(g, w, h, H) {
    const out = new Uint8ClampedArray(w * h).fill(255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const z = H[6] * x + H[7] * y + H[8];
        const u = (H[0] * x + H[1] * y + H[2]) / z;
        const v = (H[3] * x + H[4] * y + H[5]) / z;
        if (u < 0 || v < 0 || u >= w - 1 || v >= h - 1) continue;
        const x0 = u | 0;
        const y0 = v | 0;
        const tx = u - x0;
        const ty = v - y0;
        const i = y0 * w + x0;
        out[y * w + x] =
          g[i] * (1 - tx) * (1 - ty) + g[i + 1] * tx * (1 - ty) + g[i + w] * (1 - tx) * ty + g[i + w + 1] * tx * ty;
      }
    }
    return out;
  }

  function intersect(hl, vl) {
    // y = a1 x + b1 ; x = a2 y + b2
    const y = (hl.a * vl.b + hl.b) / (1 - hl.a * vl.a);
    const x = vl.a * y + vl.b;
    return [x, y];
  }

  function perspectiveCorrect(g, bin, w, h) {
    const lay = LayoutAnalysis.detect(bin, w, h);
    if (!lay.found) return { g, applied: false, reason: "표 테두리를 찾지 못함" };
    const hr = lay.rules.h;
    const tableH = lay.table.bottom - lay.table.top;
    const vr = lay.rules.v.filter((v) => v.len >= tableH * 0.35);
    if (hr.length < 2 || vr.length < 2) return { g, applied: false, reason: "네 변 중 일부 괘선이 없음" };
    const top = LayoutAnalysis.fitRuleLine(bin, w, h, hr[0], true);
    const bottom = LayoutAnalysis.fitRuleLine(bin, w, h, hr[hr.length - 1], true);
    const left = LayoutAnalysis.fitRuleLine(bin, w, h, vr[0], false);
    const right = LayoutAnalysis.fitRuleLine(bin, w, h, vr[vr.length - 1], false);
    if (!top || !bottom || !left || !right) return { g, applied: false, reason: "괘선 직선 맞추기 실패" };
    const tilt = Math.max(Math.abs(top.a - bottom.a), Math.abs(left.a - right.a), Math.abs(top.a), Math.abs(left.a));
    if (tilt < 0.0025) return { g, applied: false, reason: "원근 왜곡이 작아 생략", tilt };
    const tl = intersect(top, left);
    const tr = intersect(top, right);
    const bl = intersect(bottom, left);
    const br = intersect(bottom, right);
    const x0 = (tl[0] + bl[0]) / 2;
    const x1 = (tr[0] + br[0]) / 2;
    const y0 = (tl[1] + tr[1]) / 2;
    const y1 = (bl[1] + br[1]) / 2;
    if (x1 - x0 < w * 0.3 || y1 - y0 < h * 0.3) return { g, applied: false, reason: "표 크기가 비정상" };
    const H = solveHomography(
      [tl, tr, br, bl],
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ]
    );
    if (!H) return { g, applied: false, reason: "보정 행렬 계산 실패" };
    return { g: warp(g, w, h, H), applied: true, tilt, corners: { tl, tr, br, bl } };
  }

  // ------------------------------------------------------------------
  // 전체 전처리
  // ------------------------------------------------------------------
  /**
   * @param {Blob} blob 원본 사진 (수정하지 않음)
   * @returns {Promise<{width, height, gray, bin, variants:[{name, label, gray}], layout, deskewAngle, perspective, timings}>}
   */
  async function process(blob) {
    const t0 = performance.now();
    const bmp = await loadBitmap(blob);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    let g = toInk(ctx.getImageData(0, 0, w, h));
    const timings = {};

    g = stretch(flatten(g, w, h));
    timings.flatten = performance.now() - t0;

    let bin = binarize(g, otsu(g));
    const deskewAngle = estimateSkew(bin, w, h);
    if (Math.abs(deskewAngle) >= 0.05) {
      g = rotateGray(g, w, h, deskewAngle);
      bin = binarize(g, otsu(g));
    }
    timings.deskew = performance.now() - t0;

    const tp = otsu(g);
    const persp = perspectiveCorrect(g, binarize(g, Math.min(235, Math.round(tp + (255 - tp) * 0.35))), w, h);
    if (persp.applied) {
      g = persp.g;
      bin = binarize(g, otsu(g));
    }
    timings.perspective = performance.now() - t0;

    const t = otsu(g);
    // 괘선 찾기용 민감한 이진화: 얇고 연한 표 선까지 잡는다 (글자는 굵어져도 두께 검사로 걸러짐)
    const lineBin = binarize(g, Math.min(235, Math.round(t + (255 - t) * 0.35)));
    const layout = LayoutAnalysis.detect(lineBin, w, h);
    timings.layout = performance.now() - t0;

    const t2 = secondOtsu(g, t);
    const variants = [
      { name: "A", label: "평탄화 회색조", gray: g },
      { name: "B", label: "Otsu 이진화", gray: binToGray(bin) },
      { name: "C", label: "진한 글자만 (워터마크 억제)", gray: binToGray(binarize(g, t2)), threshold: t2 },
    ];
    return {
      width: w,
      height: h,
      scale,
      gray: g,
      bin,
      threshold: t,
      variants,
      layout,
      deskewAngle,
      perspective: { applied: persp.applied, reason: persp.reason || "", tilt: persp.tilt || 0 },
      timings,
    };
  }

  /** 영역을 잘라 OCR용 캔버스로 (작은 글씨는 확대). */
  function cropCanvas(gray, w, h, region, upscale) {
    const x = Math.max(0, Math.round(region.x));
    const y = Math.max(0, Math.round(region.y));
    const rw = Math.min(w - x, Math.round(region.w));
    const rh = Math.min(h - y, Math.round(region.h));
    const src = grayToCanvas(gray, w, h);
    const k = upscale || 1;
    const out = makeCanvas(Math.max(1, Math.round(rw * k)), Math.max(1, Math.round(rh * k)));
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, x, y, rw, rh, 0, 0, out.width, out.height);
    return out;
  }

  async function canvasToBlob(c, type, quality) {
    if (c.convertToBlob) return c.convertToBlob({ type: type || "image/png", quality });
    return new Promise((res) => c.toBlob(res, type || "image/png", quality));
  }

  /** AI 서버로 보낼 축소 JPEG (base64, 긴 변 1600px) */
  async function toJpegBase64(blob, maxSide) {
    const bmp = await loadBitmap(blob);
    const s = Math.min(1, (maxSide || 1600) / Math.max(bmp.width, bmp.height));
    const c = makeCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const out = await canvasToBlob(c, "image/jpeg", 0.85);
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** 디버그용: 전처리 이미지 위에 찾은 괘선·영역을 그린다. */
  function drawLayoutOverlay(gray, w, h, layout) {
    const c = grayToCanvas(gray, w, h);
    const ctx = c.getContext("2d");
    const colors = { header: "#8b5cf6", question: "#2563eb", label: "#f59e0b", block: "#16a34a", footer: "#9ca3af", page: "#ef4444" };
    ctx.lineWidth = 4;
    for (const r of layout.rules.h) {
      ctx.strokeStyle = "rgba(239,68,68,0.6)";
      ctx.beginPath();
      ctx.moveTo(r.start, r.pos);
      ctx.lineTo(r.end, r.pos);
      ctx.stroke();
    }
    for (const r of layout.rules.v) {
      ctx.strokeStyle = "rgba(236,72,153,0.6)";
      ctx.beginPath();
      ctx.moveTo(r.pos, r.start);
      ctx.lineTo(r.pos, r.end);
      ctx.stroke();
    }
    ctx.font = "bold 28px sans-serif";
    for (const reg of layout.regions) {
      ctx.strokeStyle = colors[reg.kind] || "#000";
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(reg.x, reg.y, reg.w, reg.h);
      ctx.setLineDash([]);
      ctx.fillStyle = colors[reg.kind] || "#000";
      ctx.fillText(reg.kind + (reg.index !== undefined ? reg.index : ""), reg.x + 8, reg.y + 30);
    }
    return c;
  }

  return { process, cropCanvas, canvasToBlob, grayToCanvas, toJpegBase64, drawLayoutOverlay, estimateSkew, otsu, binarize, flatten, stretch };
})();
