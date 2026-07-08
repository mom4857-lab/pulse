// Cloudflare Worker entry point.
// Routes POST /api/summarize to the AI summary handler (server-side, keeps
// the API key secret) and everything else to the static site (dist/).

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/summarize" && request.method === "POST") {
      return handleSummarize(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleSummarize(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }

  const text = (body.text || "").toString().slice(0, 4000).trim();
  if (!text) {
    return json({ error: "empty_text" }, 400);
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "server_not_configured" }, 500);
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 80,
        messages: [
          {
            role: "user",
            content:
              "다음은 한 개인 투자자가 직접 읽고 정리한 뉴스 기록의 요점들이다. " +
              "이 내용을 핵심만 담아 한국어 한 문장(40자 이내)으로 요약해줘. " +
              "설명이나 접두사 없이 요약 문장 하나만 출력해.\n\n" +
              text,
          },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return json({ error: "anthropic_error", detail }, 502);
    }

    const data = await res.json();
    const summary = (data.content || [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    if (!summary) {
      return json({ error: "empty_response" }, 502);
    }

    return json({ summary });
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
