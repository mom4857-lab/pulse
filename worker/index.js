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

  const articleUrl = (body.url || "").toString().trim();
  const fallbackText = (body.text || "").toString().slice(0, 4000).trim();

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "server_not_configured" }, 500);
  }

  let sourceContent = "";
  let sourceType = "notes";

  if (articleUrl) {
    try {
      const pageRes = await fetch(articleUrl, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const extracted = await extractReadableText(html);
        if (extracted.length > 200) {
          sourceContent = extracted.slice(0, 6000);
          sourceType = "article";
        }
      }
    } catch (e) {
      // network/parse failure — fall through to notes fallback below
    }
  }

  if (!sourceContent) {
    if (!fallbackText) return json({ error: "no_content" }, 400);
    sourceContent = fallbackText;
    sourceType = "notes";
  }

  const instruction =
    sourceType === "article"
      ? "다음은 한 뉴스 기사 페이지에서 추출한 본문 텍스트다. 이 기사의 핵심 내용을 한국어 2~3줄로, 완결된 문장으로 요약해줘. " +
        "원문 문장을 그대로 옮기지 말고 핵심만 너의 표현으로 정리해줘. " +
        "그리고 이 기사의 밸류체인과 시장 상황을 전반적으로 분석해서, 실제로 연관성이 높은 키워드를 총 5개 이내로 추천해줘: " +
        "(1) 산업군/섹터 키워드 최대 2개. " +
        "(2) 관련 키워드 최대 3개 — 기업명, 기술명, 제품·소재명 중 무엇이든 될 수 있다. " +
        "기사에 직접 언급되지 않았더라도, 같은 밸류체인(공급망, 고객사, 경쟁사, 후공정/소부장 등)에 속해 수요나 실적에 실질적으로 영향을 받을 만한 항목이면 포함해라. " +
        "예를 들어 HBM 수요 확대 기사라면 관련 패키징 기판(FC-BGA)이나 후공정 장비처럼 함께 움직일 만한 항목도 추천 대상이다. " +
        "단, 기업명을 추천할 때는 반드시 국내외 증권거래소에 상장되어 있는 기업만 추천하고 비상장 기업은 제외해. 기술명·제품명에는 이 제한이 없다."
      : "다음은 한 개인 투자자가 직접 읽고 정리한 뉴스 기록의 요점들이다. 이 내용을 핵심만 담아 한국어 2~3줄로, 완결된 문장으로 요약해줘. " +
        "그리고 이 내용의 밸류체인과 시장 상황을 전반적으로 분석해서, 실제로 연관성이 높은 키워드를 총 5개 이내로 추천해줘: " +
        "(1) 산업군/섹터 키워드 최대 2개. " +
        "(2) 관련 키워드 최대 3개 — 기업명, 기술명, 제품·소재명 중 무엇이든 될 수 있다. " +
        "직접 언급되지 않았더라도, 같은 밸류체인(공급망, 고객사, 경쟁사, 후공정/소부장 등)에 속해 수요나 실적에 실질적으로 영향을 받을 만한 항목이면 포함해라. " +
        "예를 들어 HBM 수요 확대 내용이라면 관련 패키징 기판(FC-BGA)이나 후공정 장비처럼 함께 움직일 만한 항목도 추천 대상이다. " +
        "단, 기업명을 추천할 때는 반드시 국내외 증권거래소에 상장되어 있는 기업만 추천하고 비상장 기업은 제외해. 기술명·제품명에는 이 제한이 없다.";

  const jsonInstruction =
    '반드시 아래 JSON 형식으로만 응답해. 코드블록 표시(```)나 다른 설명 문장 없이 JSON 객체 하나만 출력해.\n' +
    '{"summary": "한국어 2~3줄 요약, 줄 사이는 \\n로 구분, 번호나 기호 없이 완결된 문장", ' +
    '"industryKeywords": ["산업군/섹터 키워드 (최대 2개)"], ' +
    '"stockKeywords": ["관련 기업(상장사)/기술/제품 키워드 (최대 3개)"]}';

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
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `${instruction}\n\n${jsonInstruction}\n\n---\n${sourceContent}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return json({ error: "anthropic_error", detail }, 502);
    }

    const data = await res.json();
    const rawText = (data.content || [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    if (!rawText) {
      return json({ error: "empty_response" }, 502);
    }

    let parsed;
    try {
      let cleaned = rawText.trim();
      cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "");
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      // Model didn't return clean JSON — fall back to using the raw text as the summary.
      parsed = { summary: rawText, industryKeywords: [], stockKeywords: [] };
    }

    return json({
      summary: (parsed.summary || rawText).toString(),
      industryKeywords: Array.isArray(parsed.industryKeywords) ? parsed.industryKeywords.slice(0, 2) : [],
      stockKeywords: Array.isArray(parsed.stockKeywords) ? parsed.stockKeywords.slice(0, 3) : [],
      source: sourceType,
    });
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
}

// Extracts readable text from an HTML page using Cloudflare's native
// HTMLRewriter (streaming HTML parser). Prefers <article> content when
// present, strips script/style/nav/header/footer, and collapses whitespace.
async function extractReadableText(html) {
  let text = "";
  let sawArticle = false;
  let insideSkip = 0;

  const rewriter = new HTMLRewriter()
    .on("article", {
      element() {
        sawArticle = true;
      },
    })
    .on("script, style, nav, header, footer, noscript", {
      element(el) {
        insideSkip++;
        el.onEndTag(() => {
          insideSkip = Math.max(0, insideSkip - 1);
        });
      },
    })
    .on("*", {
      text(t) {
        if (insideSkip === 0) text += t.text;
      },
    });

  const res = new Response(html, { headers: { "content-type": "text/html" } });
  const transformed = rewriter.transform(res);
  await transformed.text();

  return text.replace(/\s+/g, " ").trim();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
