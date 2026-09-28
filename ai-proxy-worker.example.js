// ai-proxy-worker.example.js
// ※ 이 파일은 앱(index.html)이 불러오지 않는다. AI 백엔드를 만들 때 참고용 예시다.
//
// Cloudflare Workers에 올리는 최소 프록시 예시.
//   1) Cloudflare 대시보드 → Workers → 새 Worker 만들기 → 이 코드 붙여넣기
//   2) Settings → Variables → Secret 추가:
//        ANTHROPIC_API_KEY = (내 Claude API 키)      ← 키는 여기에만 둔다
//        ALLOWED_ORIGIN    = https://<내아이디>.github.io  (내 앱에서만 호출 허용)
//        MODEL             = claude-sonnet-5  (선택)
//   3) 배포된 Worker 주소를 앱의 [설정] 화면 또는 config.js의 AI_API_URL에 넣는다.
//
// 앱(ai.js)과의 약속: 요청 { version, task, instructions, input, images? } → 응답 { ok, result }
//   images: [{ mediaType: "image/jpeg", data: "<base64>" }]  (교재 사진 문서 분석 때만)
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed || origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405, cors);
    if (allowed && origin !== allowed) return json({ ok: false, error: "origin not allowed" }, 403, cors);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: "invalid json" }, 400, cors);
    }
    const { instructions, input, images } = body || {};
    if (!instructions || !input) return json({ ok: false, error: "missing fields" }, 400, cors);

    // v4: 교재 사진 분석(analyzeDocument)은 이미지를 함께 보낸다 → Claude 메시지의 image 블록으로 전달
    const content = [];
    for (const img of Array.isArray(images) ? images.slice(0, 4) : []) {
      if (img && typeof img.data === "string" && img.data.length < 6_000_000) {
        content.push({ type: "image", source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.data } });
      }
    }
    content.push({ type: "text", text: JSON.stringify(input) });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.MODEL || "claude-sonnet-5",
        max_tokens: 8000,
        system: instructions,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) return json({ ok: false, error: `upstream ${res.status}` }, 502, cors);
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    return json({ ok: true, result: text }, 200, cors);
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
