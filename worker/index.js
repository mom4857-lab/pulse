// Cloudflare Worker entry point.
// Routes POST /api/analyze-period to the AI period-analysis handler
// (server-side, keeps the API key secret) and everything else to the
// static site (dist/).

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/analyze-period" && request.method === "POST") {
      return handleAnalyzePeriod(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleAnalyzePeriod(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }

  const periodLabelText = (body.periodLabel || "").toString().slice(0, 100);
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 200) : [];

  if (!entries.length) {
    return json({ error: "no_entries" }, 400);
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "server_not_configured" }, 500);
  }

  const digest = entries
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
    .map((e) => {
      const tags = [...(e.industryTags || []), ...(e.stockTags || [])].map((t) => "#" + t).join(" ");
      const summaryLines = (e.summary || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ");
      return `[${e.date || ""}] ${e.title || ""}\n${summaryLines}\n${tags}`;
    })
    .join("\n\n")
    .slice(0, 12000);

  const prompt =
    `다음은 한 개인 투자자가 ${periodLabelText} 기간 동안 직접 읽고 정리한 뉴스 기록 목록이다.\n\n` +
    "이 기록들을 종합해서 이번 기간의 흐름을 한국어로 분석해줘. 아래 세 항목을 포함해서 정리해:\n" +
    "1) 이번 기간 핵심 흐름 (2~3문장)\n" +
    "2) 기록들 사이의 연결고리나 반복되는 주제\n" +
    "3) 특별히 주목할 만한 변화나 신호\n\n" +
    "각 항목 앞에는 위와 같은 번호와 소제목을 그대로 붙이고, 항목 사이는 빈 줄로 구분해라. " +
    "문장은 짧고 명확하게 쓰고, 과도한 확신이나 투자 추천, 매수·매도 권유는 하지 마라. " +
    "기록의 문장을 그대로 옮기지 말고 종합적인 분석으로 정리해라.\n\n---\n" +
    digest;

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
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return json({ error: "anthropic_error", detail }, 502);
    }

    const data = await res.json();
    const analysis = (data.content || [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    if (!analysis) {
      return json({ error: "empty_response" }, 502);
    }

    return json({ analysis });
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
