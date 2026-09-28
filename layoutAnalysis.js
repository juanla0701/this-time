// layoutAnalysis.js
// 교재 사진의 "표 구조"를 찾아 영역으로 나눈다 (OCR 전에 실행).
//
//   ┌ 제목 ─────────────────────────────────────┐   ← header  (표 위)
//   ├───────────────────────────────────────────┤   ← 표 윗선
//   │ Q3. (★…) 질문 …                           │   ← question
//   ├──────┬────────────────────────────────────┤   ← 질문 아래 선
//   │ 핵심 │ 1. …  - …  본문 …                   │   ← block 1 (라벨 열 | 본문)
//   │ 내용 │                                    │
//   ├──────┼────────────────────────────────────┤
//   │신념화│ ● …                                │   ← block 2
//   └──────┴────────────────────────────────────┘   ← 표 아랫선
//                  정신전력 - 5                        ← footer (쪽 번호)
//
// 원리: 이진화된 이미지에서 "아주 긴 가로/세로 잉크 줄"(괘선)을 찾는다. 글자 줄은 낱말 사이
// 공백 때문에 길게 이어지지 않으므로 괘선과 구별된다. 괘선을 못 찾으면 페이지 전체를 한 영역으로 둔다.
window.LayoutAnalysis = (function () {
  const GAP = 4; // 괘선 위 작은 끊김(인쇄·촬영 잡음) 허용 픽셀

  /** 한 줄(1차원 배열)에서 끊김 GAP까지 허용한 가장 긴 잉크 구간 → {len, start, end} */
  function longestRun(get, n) {
    let best = { len: 0, start: 0, end: 0 };
    let start = -1;
    let lastInk = -1;
    for (let i = 0; i < n; i++) {
      if (get(i)) {
        if (start < 0 || i - lastInk > GAP + 1) start = i;
        lastInk = i;
        const len = lastInk - start + 1;
        if (len > best.len) best = { len, start, end: lastInk };
      }
    }
    return best;
  }

  function group(cands, key) {
    const out = [];
    for (const c of cands) {
      const last = out[out.length - 1];
      if (last && c[key] - last.to <= 3) {
        last.to = c[key];
        last.items.push(c);
      } else out.push({ from: c[key], to: c[key], items: [c] });
    }
    return out.map((g) => {
      const best = g.items.reduce((a, b) => (b.len > a.len ? b : a));
      return { pos: Math.round((g.from + g.to) / 2), thickness: g.to - g.from + 1, len: best.len, start: best.start, end: best.end };
    });
  }

  /**
   * 기울어지거나 살짝 휜 괘선도 찾는 방법:
   *   1) 각 줄(행/열)에서 "얇은" 잉크 조각을 찾는다 — 조각 위아래(또는 좌우) 8px 줄이 비어 있어야 한다.
   *      글자 줄은 위아래로도 잉크가 있어서 여기서 걸러진다.
   *   2) 조각들을 완만한 기울기로 이어 붙여(체인) 긴 선을 만든다.
   * horizontal=false면 가로·세로를 바꿔서 같은 계산을 한다.
   */
  function findLines(bin, w, h, horizontal, minFrac) {
    const L = horizontal ? w : h; // 선 방향 길이
    const M = horizontal ? h : w; // 선에 수직인 방향 길이
    const at = horizontal ? (t, u) => bin[u * w + t] : (t, u) => bin[t * w + u];
    const MIN_SEG = Math.max(40, Math.round(L * 0.025));
    const segsByU = new Array(M);
    const coverage = (u, a, b) => {
      if (u < 0 || u >= M) return 0;
      let ink = 0;
      for (let t = a; t <= b; t += 2) if (at(t, u)) ink++;
      return ink / (Math.floor((b - a) / 2) + 1);
    };
    for (let u = 0; u < M; u++) {
      let start = -1;
      let last = -1;
      const list = [];
      const flush = () => {
        if (start >= 0 && last - start + 1 >= MIN_SEG) {
          const off = Math.max(coverage(u - 8, start, last), coverage(u - 10, start, last), coverage(u + 8, start, last), coverage(u + 10, start, last));
          if (off < 0.3) list.push({ u, a: start, b: last });
        }
      };
      for (let t = 0; t < L; t++) {
        if (at(t, u)) {
          if (start < 0 || t - last > GAP + 1) {
            flush();
            start = t;
          }
          last = t;
        }
      }
      flush();
      segsByU[u] = list;
    }
    // 체인: 긴 조각부터 씨앗으로 삼아 좌우로 이어 붙인다
    const all = [];
    for (let u = 0; u < M; u++) for (const sg of segsByU[u]) all.push(sg);
    all.sort((p, q) => q.b - q.a - (p.b - p.a));
    const used = new Set();
    const lines = [];
    const findNext = (endT, endU, dir) => {
      let best = null;
      for (let du = -4; du <= 4; du++) {
        const list = segsByU[endU + du];
        if (!list) continue;
        for (const sg of list) {
          if (used.has(sg)) continue;
          const gap = dir > 0 ? sg.a - endT : endT - sg.b;
          if (gap < -20 || gap > 60) continue;
          const score = Math.abs(du) * 10 + Math.max(0, gap);
          if (!best || score < best.score) best = { sg, score };
        }
      }
      return best && best.sg;
    };
    for (const seed of all) {
      if (used.has(seed)) continue;
      used.add(seed);
      const chain = [seed];
      let right = seed;
      for (let nx = findNext(right.b, right.u, 1); nx; nx = findNext(right.b, right.u, 1)) {
        used.add(nx);
        chain.push(nx);
        right = nx;
      }
      let left = seed;
      for (let nx = findNext(left.a, left.u, -1); nx; nx = findNext(left.a, left.u, -1)) {
        used.add(nx);
        chain.push(nx);
        left = nx;
      }
      const start = Math.min(...chain.map((c) => c.a));
      const end = Math.max(...chain.map((c) => c.b));
      if (end - start + 1 < L * minFrac) continue;
      // 두께 방향으로 겹친 조각들(같은 선의 윗줄/아랫줄)도 사용 처리
      const uMin = Math.min(...chain.map((c) => c.u)) - 6;
      const uMax = Math.max(...chain.map((c) => c.u)) + 6;
      for (let u = Math.max(0, uMin); u <= Math.min(M - 1, uMax); u++) {
        for (const sg of segsByU[u]) if (sg.b >= start && sg.a <= end) used.add(sg);
      }
      const leftMost = chain.reduce((p, q) => (q.a < p.a ? q : p));
      const rightMost = chain.reduce((p, q) => (q.b > p.b ? q : p));
      const covered = chain.reduce((acc, c) => acc + (c.b - c.a + 1), 0);
      lines.push({
        pos: Math.round(chain.reduce((s, c) => s + c.u * (c.b - c.a + 1), 0) / covered),
        start,
        end,
        len: end - start + 1,
        covered,
        uStart: leftMost.u,
        uEnd: rightMost.u,
        slope: (rightMost.u - leftMost.u) / Math.max(1, rightMost.b - leftMost.a),
        thickness: 1 + Math.max(0, uMax - uMin - 12),
      });
    }
    // 거의 같은 위치의 선은 하나로
    lines.sort((p, q) => p.pos - q.pos);
    const merged = [];
    for (const ln of lines) {
      const prev = merged[merged.length - 1];
      // 같은 높이(±12px)의 선은 중간이 끊겼어도 한 선 (사진에서 괘선 일부가 흐린 경우)
      if (prev && Math.abs(prev.pos - ln.pos) <= 12) {
        prev.start = Math.min(prev.start, ln.start);
        prev.end = Math.max(prev.end, ln.end);
        prev.len = prev.end - prev.start + 1;
        prev.covered += ln.covered;
      } else merged.push({ ...ln });
    }
    return merged;
  }

  function horizontalRules(bin, w, h, minFrac) {
    return findLines(bin, w, h, true, minFrac);
  }

  function verticalRules(bin, w, h, minFrac) {
    return findLines(bin, w, h, false, minFrac);
  }

  /** 선으로 인정: 이어 붙인 조각이 전체 길이의 75% 이상을 채워야 한다 (글자 조각 우연 연결 방지). */
  function isSolidLine(rule) {
    return rule.covered / rule.len >= 0.75;
  }

  /**
   * @param {Uint8Array} bin  1 = 잉크
   * @returns {{found, rules:{h,v}, table, regions:[{kind, x, y, w, h, index?}]}}
   */
  function detect(bin, w, h) {
    const hRules = horizontalRules(bin, w, h, 0.4).filter(isSolidLine);
    const vRules = verticalRules(bin, w, h, 0.2).filter(isSolidLine);
    const result = { found: false, rules: { h: hRules, v: vRules }, table: null, regions: [] };
    if (hRules.length < 2) {
      result.regions = [{ kind: "page", x: 0, y: 0, w, h }];
      return result;
    }

    const top = hRules[0];
    const bottom = hRules[hRules.length - 1];
    const long = vRules.filter((v) => v.len >= (bottom.pos - top.pos) * 0.35);
    // 표 좌우: 긴 세로 테두리가 있으면 그것을, 없으면 가로 괘선들의 양 끝을 쓴다
    const leftV = long.filter((v) => v.pos < w * 0.2);
    const rightV = long.filter((v) => v.pos > w * 0.8);
    const tableLeft = Math.max(0, (leftV.length ? leftV[0].pos : Math.min(...hRules.map((r) => r.start))) - 2);
    const tableRight = Math.min(w, (rightV.length ? rightV[rightV.length - 1].pos : Math.max(...hRules.map((r) => r.end))) + 2);
    const tableW = tableRight - tableLeft;

    // 라벨 열 구분선: 표 왼쪽 15% 안의 세로 괘선 중 가장 오른쪽 것 (왼쪽 테두리가 잘린 사진도 대응)
    const leftSide = long.filter((v) => v.pos - tableLeft < tableW * 0.15 && v.pos - tableLeft > tableW * 0.015);
    const divider = leftSide.length ? leftSide[leftSide.length - 1] : null;

    // 질문 칸 아래 선: 윗선 바로 아래(표 높이 20% 이내)의 괘선
    const inner = hRules.slice(1, -1);
    const tableH = bottom.pos - top.pos;
    let qRule = inner.find((r) => r.pos - top.pos < tableH * 0.2 && r.pos - top.pos > 12);
    // 질문 칸이 표 윗선 위에 있고 윗선이 곧 질문 아래 선인 경우 (제목과 표 사이에 질문)
    const blocksTop = qRule ? qRule.pos : top.pos;
    const separators = inner.filter((r) => r.pos > blocksTop + 20 && r.pos < bottom.pos - 20 && r.len >= tableW * 0.35);

    result.found = true;
    result.table = { left: tableLeft, right: tableRight, top: top.pos, bottom: bottom.pos, divider: divider ? divider.pos : null };
    const regions = [];
    if (top.pos > 20) regions.push({ kind: "header", x: 0, y: 0, w, h: top.pos - 2 });
    if (qRule) regions.push({ kind: "question", x: tableLeft, y: top.pos + 3, w: tableW, h: qRule.pos - top.pos - 6 });
    const cuts = [blocksTop].concat(separators.map((s) => s.pos)).concat([bottom.pos]);
    for (let i = 0; i < cuts.length - 1; i++) {
      const y0 = cuts[i] + 3;
      const y1 = cuts[i + 1] - 3;
      if (y1 - y0 < 20) continue;
      if (divider) {
        regions.push({ kind: "label", index: i, x: tableLeft, y: y0, w: divider.pos - tableLeft - 3, h: y1 - y0 });
        regions.push({ kind: "block", index: i, x: divider.pos + 4, y: y0, w: tableRight - divider.pos - 4, h: y1 - y0 });
      } else {
        regions.push({ kind: "block", index: i, x: tableLeft, y: y0, w: tableW, h: y1 - y0 });
      }
    }
    if (h - bottom.pos > 20) regions.push({ kind: "footer", x: 0, y: bottom.pos + 3, w, h: h - bottom.pos - 3 });
    result.regions = regions;
    return result;
  }

  /** 괘선 위 잉크 점들로 직선을 맞춘다 (원근 보정용). horizontal: y = a·x + b / vertical: x = a·y + b */
  function fitRuleLine(bin, w, h, rule, horizontal) {
    const pts = [];
    const span = horizontal ? [rule.start, rule.end] : [rule.start, rule.end];
    for (let t = span[0]; t <= span[1]; t += 3) {
      let sum = 0;
      let n = 0;
      const center = rule.uStart !== undefined ? rule.uStart + (t - rule.start) * (rule.slope || 0) : rule.pos;
      for (let d = -8; d <= 8; d++) {
        const u = Math.round(center) + d;
        const idx = horizontal ? u * w + t : t * w + u;
        if (u >= 0 && (horizontal ? u < h : u < w) && bin[idx]) {
          sum += u;
          n++;
        }
      }
      if (n) pts.push([t, sum / n]);
    }
    if (pts.length < 10) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pts) {
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    const n = pts.length;
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const b = (sy - a * sx) / n;
    return { a, b, from: span[0], to: span[1] };
  }

  return { detect, horizontalRules, verticalRules, fitRuleLine };
})();
