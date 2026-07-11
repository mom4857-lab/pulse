// Cloudflare Worker entry point.
// Routes POST /api/analyze-period and /api/entry-keywords to the AI handlers
// (server-side, keeps the API key secret) and everything else to the
// static site (dist/).

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/analyze-period" && request.method === "POST") {
      return handleAnalyzePeriod(request, env);
    }
    if (url.pathname === "/api/entry-keywords" && request.method === "POST") {
      return handleEntryKeywords(request, env);
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

  // Fetch the actual article content for each linked URL in this period
  // (up to 20, in parallel, with a per-request timeout) so the keyword
  // recommendation can be grounded in the real articles, not just notes.
  const urls = entries
    .map((e) => (e.url || "").toString().trim())
    .filter(Boolean)
    .slice(0, 20);

  const articleTexts = await Promise.all(urls.map((u) => fetchArticleText(u)));
  const articlesDigest = articleTexts
    .filter(Boolean)
    .map((t, i) => `[기사 ${i + 1} 본문] ${t}`)
    .join("\n\n")
    .slice(0, 15000);

  const singleTermRule =
    "각 키워드는 반드시 하나의 단일 용어여야 한다. 괄호, 슬래시(/), 쉼표, '·' 등으로 여러 개념을 한 키워드에 묶지 마라. " +
    "정말 연관성이 가장 높은 것 하나만 골라 짧은 단일 용어로 써라.";
  const koreanOnlyRule =
    "모든 키워드는 반드시 한글로 표기해라. 영문 회사명이나 기술명도 한글 표기로 바꿔서 써라 " +
    "(예: NVIDIA → 엔비디아, Anthropic → 앤스로픽). 이미 통용되는 한글 표기가 있으면 그것을 그대로 사용해라.";

  const prompt =
    `다음은 한 개인 투자자가 ${periodLabelText} 기간 동안 직접 읽고 정리한 뉴스 기록 목록과, 그 기록에 첨부된 뉴스 링크의 실제 본문이다.\n\n` +
    "이 자료를 종합해서 이번 기간의 흐름을 분석해줘. 아래 네 가지를 작성해:\n" +
    "1) coreFlow: 이번 기간 핵심 흐름 (한국어 2~3문장)\n" +
    "2) connections: 기록들 사이의 연결고리나 반복되는 주제 (한국어 2~3문장)\n" +
    "3) signals: 특별히 주목할 만한 변화나 신호 (한국어 2~3문장)\n" +
    "4) keywords: 이 기간 전체를 관통하는, 실제로 연관성이 높은 키워드 정확히 5개. " +
    "산업군, 기업, 기술, 제품, 소재 등 무엇이든 될 수 있다. 뉴스 본문과 기록을 바탕으로 밸류체인과 시장 상황을 종합적으로 판단해서 골라라. " +
    "직접 언급되지 않았더라도 같은 밸류체인(공급망, 고객사, 경쟁사, 후공정/소부장 등)에 속해 실질적으로 연관된 항목이면 포함해라. " +
    "기업명을 추천할 때는 반드시 국내외 증권거래소에 상장되어 있는 기업만 추천하고 비상장 기업은 제외해라. " +
    singleTermRule +
    " " +
    koreanOnlyRule +
    "\n\n문장은 짧고 명확하게 쓰고, 과도한 확신이나 투자 추천, 매수·매도 권유는 하지 마라. " +
    "기록이나 기사 문장을 그대로 옮기지 말고 종합적인 분석으로 정리해라. " +
    '반드시 아래 JSON 형식으로만 응답해. 코드블록 표시(```)나 다른 설명 문장 없이 JSON 객체 하나만 출력해.\n' +
    '{"coreFlow": "...", "connections": "...", "signals": "...", "keywords": ["단일 용어 5개"]}\n\n' +
    `---\n[사용자 기록]\n${digest}` +
    (articlesDigest ? `\n\n---\n[뉴스 본문]\n${articlesDigest}` : "");

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
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
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
      // Model didn't return clean JSON — put everything in coreFlow as a fallback.
      parsed = { coreFlow: rawText, connections: "", signals: "", keywords: [] };
    }

    return json({
      coreFlow: (parsed.coreFlow || "").toString().trim(),
      connections: (parsed.connections || "").toString().trim(),
      signals: (parsed.signals || "").toString().trim(),
      keywords: normalizeKeywords(parsed.keywords, 5),
    });
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
}

// Fetches a news page and extracts its readable text, with a timeout so one
// slow or blocked site doesn't hold up the whole analysis.
async function handleEntryKeywords(request, env) {
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
    const text = await fetchArticleText(articleUrl);
    if (text && text.length > 200) {
      sourceContent = text;
      sourceType = "article";
    }
  }

  if (!sourceContent) {
    if (!fallbackText) return json({ error: "no_content" }, 400);
    sourceContent = fallbackText;
    sourceType = "notes";
  }

  const singleTermRule =
    "각 키워드는 반드시 하나의 단일 용어여야 한다. 괄호, 슬래시(/), 쉼표, '·' 등으로 여러 개념을 한 키워드에 묶지 마라. " +
    "정말 연관성이 가장 높은 것 하나만 골라 짧은 단일 용어로 써라.";
  const koreanOnlyRule =
    "모든 키워드는 반드시 한글로 표기해라. 영문 회사명이나 기술명도 한글 표기로 바꿔서 써라 " +
    "(예: NVIDIA → 엔비디아, Anthropic → 앤스로픽). 이미 통용되는 한글 표기가 있으면 그것을 그대로 사용해라.";

  const instruction =
    sourceType === "article"
      ? "다음은 한 뉴스 기사 본문에서 추출한 텍스트다. 이 기사의 밸류체인과 시장 상황을 전반적으로 분석해서, 실제로 연관성이 높은 키워드를 총 5개 이내로 추천해줘: " +
        "(1) 산업군/섹터 키워드 최대 2개. " +
        "(2) 관련 키워드 최대 3개 — 기업명, 기술명, 제품·소재명 중 무엇이든 될 수 있다. " +
        "기사에 직접 언급되지 않았더라도, 같은 밸류체인(공급망, 고객사, 경쟁사, 후공정/소부장 등)에 속해 수요나 실적에 실질적으로 영향을 받을 만한 항목이면 포함해라. " +
        "단, 기업명을 추천할 때는 반드시 국내외 증권거래소에 상장되어 있는 기업만 추천하고 비상장 기업은 제외해. 기술명·제품명에는 이 제한이 없다. " +
        singleTermRule +
        " " +
        koreanOnlyRule
      : "다음은 한 개인 투자자가 직접 읽고 정리한 뉴스 기록의 요점들이다. 이 내용의 밸류체인과 시장 상황을 전반적으로 분석해서, 실제로 연관성이 높은 키워드를 총 5개 이내로 추천해줘: " +
        "(1) 산업군/섹터 키워드 최대 2개. " +
        "(2) 관련 키워드 최대 3개 — 기업명, 기술명, 제품·소재명 중 무엇이든 될 수 있다. " +
        "직접 언급되지 않았더라도, 같은 밸류체인(공급망, 고객사, 경쟁사, 후공정/소부장 등)에 속해 수요나 실적에 실질적으로 영향을 받을 만한 항목이면 포함해라. " +
        "단, 기업명을 추천할 때는 반드시 국내외 증권거래소에 상장되어 있는 기업만 추천하고 비상장 기업은 제외해. 기술명·제품명에는 이 제한이 없다. " +
        singleTermRule +
        " " +
        koreanOnlyRule;

  const jsonInstruction =
    '반드시 아래 JSON 형식으로만 응답해. 코드블록 표시(```)나 다른 설명 문장 없이 JSON 객체 하나만 출력해.\n' +
    '{"industryKeywords": ["단일 용어 산업군/섹터 키워드 (최대 2개, 괄호/슬래시 금지)"], ' +
    '"stockKeywords": ["단일 용어 기업(상장사)/기술/제품 키워드 (최대 3개, 괄호/슬래시 금지)"]}';

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
        max_tokens: 300,
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
      parsed = { industryKeywords: [], stockKeywords: [] };
    }

    return json({
      industryKeywords: normalizeKeywords(parsed.industryKeywords, 2),
      stockKeywords: normalizeKeywords(parsed.stockKeywords, 3),
      source: sourceType,
    });
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
}

async function fetchArticleText(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return "";
    const html = await res.text();
    const text = await extractReadableText(html);
    return text.slice(0, 2500);
  } catch (e) {
    return "";
  }
}

// Extracts readable text from an HTML page using Cloudflare's native
// HTMLRewriter (streaming HTML parser), stripping script/style/nav/header/footer.
async function extractReadableText(html) {
  let text = "";
  let insideSkip = 0;

  const rewriter = new HTMLRewriter()
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

// Safety net in case the model still returns compound keywords despite the
// prompt instruction — splits on slash/comma, unwraps "A(B)" into A and B as
// separate candidates, dedupes, and caps to maxCount.
function normalizeKeywords(arr, maxCount) {
  if (!Array.isArray(arr)) return [];

  let candidates = [];
  for (const raw of arr) {
    if (typeof raw !== "string") continue;
    const bracketMatch = raw.match(/^\s*([^()（）]+?)\s*[\(（]([^()）]+)[\)）]\s*$/);
    if (bracketMatch) {
      candidates.push(bracketMatch[1]);
      candidates.push(bracketMatch[2]);
    } else {
      candidates.push(raw.replace(/[()（）]/g, ""));
    }
  }

  let out = [];
  for (const c of candidates) {
    out.push(...c.split(/[\/,、·]/));
  }

  const seen = new Set();
  const deduped = [];
  for (const k of out) {
    const clean = k.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(clean);
  }
  return deduped.slice(0, maxCount);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
