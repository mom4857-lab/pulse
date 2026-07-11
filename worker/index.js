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
  const periodType = (body.periodType || "week").toString();
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
      const tags = [...(e.industryTags || []), ...(e.stockTags || []), ...(e.techTags || [])]
        .map((t) => "#" + t)
        .join(" ");
      const summaryLines = (e.summary || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ");
      return `[${e.date || ""}] ${e.title || ""}\n${summaryLines}\n${tags}`;
    })
    .join("\n\n")
    .slice(0, 16000);

  const singleTermRule =
    "각 키워드는 반드시 하나의 단일 용어여야 한다. 괄호, 슬래시(/), 쉼표, '·' 등으로 여러 개념을 한 키워드에 묶지 마라. " +
    "정말 연관성이 가장 높은 것 하나만 골라 짧은 단일 용어로 써라.";
  const koreanOnlyRule =
    "회사명은 반드시 한글로 표기해라. 영문 회사명도 한글 표기로 바꿔서 써라 (예: NVIDIA → 엔비디아, Anthropic → 앤스로픽). " +
    "이미 통용되는 한글 표기가 있는 회사명은 그것을 그대로 사용해라. " +
    "다만 기술·제품·부품명에 업계에서 널리 쓰이는 약어가 있으면 풀어쓰지 말고 그 약어를 그대로 사용해라 " +
    "(예: 고대역폭메모리 → HBM, 소형모듈원자로 → SMR, 극자외선 노광장비 → EUV).";

  const isDetailed = periodType === "month" || periodType === "year";
  const detailInstruction = isDetailed
    ? "이번 분석 대상 기간은 " +
      (periodType === "year" ? "1년" : "1개월") +
      " 단위로 비교적 길기 때문에, coreFlow·connections·signals 각 항목을 4~6문장으로 좀 더 상세하게 작성해줘. " +
      "필요하면 기간 내 시간 흐름(초반/중반/후반)이나 하위 주제별로 나눠서 설명해도 좋다."
    : "coreFlow·connections·signals 각 항목은 2~3문장으로 간결하게 작성해줘.";

  const prompt =
    `다음은 한 개인 투자자가 ${periodLabelText} 기간 동안 직접 읽고 정리한 뉴스 기록 목록이다.\n\n` +
    "이 기록들을 종합해서 이번 기간의 흐름을 분석해줘. 아래 네 가지를 작성해:\n" +
    "1) coreFlow: 이번 기간 핵심 흐름\n" +
    "2) connections: 기록들 사이의 연결고리나 반복되는 주제\n" +
    "3) signals: 특별히 주목할 만한 변화나 신호\n" +
    detailInstruction +
    "\n" +
    "4) keywords: 이 기간 전체를 관통하는, 실제로 연관성이 높은 키워드 정확히 10개. " +
    "기업명, 핵심 부품·소재, 기술, 제품 등 무엇이든 될 수 있다 (산업군/섹터 같은 큰 범주 키워드는 추천하지 마라). " +
    "기록을 바탕으로 밸류체인과 시장 상황을 두루 판단해서 골라라. " +
    "직접 언급되지 않았더라도 같은 밸류체인(공급망, 고객사, 경쟁사, 후공정/소부장 등)에 속해 실질적으로 연관된 항목이면 포함해라. " +
    "기업명을 추천할 때는 반드시 국내외 증권거래소에 상장되어 있는 기업만 추천하고 비상장 기업은 제외해라. " +
    singleTermRule +
    " " +
    koreanOnlyRule +
    "\n\n과도한 확신이나 투자 추천, 매수·매도 권유는 하지 마라. " +
    "기록의 문장을 그대로 옮기지 말고 종합적인 분석으로 정리해라. " +
    '반드시 아래 JSON 형식으로만 응답해. 코드블록 표시(```)나 다른 설명 문장 없이 JSON 객체 하나만 출력해.\n' +
    '{"coreFlow": "...", "connections": "...", "signals": "...", "keywords": ["단일 용어 10개"]}\n\n' +
    `---\n[사용자 기록]\n${digest}`;

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
        max_tokens: isDetailed ? 1500 : 1000,
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
      keywords: normalizeKeywords(parsed.keywords, 10),
    });
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
}

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
    "회사명은 반드시 한글로 표기해라. 영문 회사명도 한글 표기로 바꿔서 써라 (예: NVIDIA → 엔비디아, Anthropic → 앤스로픽). " +
    "이미 통용되는 한글 표기가 있는 회사명은 그것을 그대로 사용해라. " +
    "다만 기술·제품·부품명에 업계에서 널리 쓰이는 약어가 있으면 풀어쓰지 말고 그 약어를 그대로 사용해라 " +
    "(예: 고대역폭메모리 → HBM, 소형모듈원자로 → SMR, 극자외선 노광장비 → EUV).";

  const instruction =
    sourceType === "article"
      ? "다음은 한 뉴스 기사 본문에서 추출한 텍스트다. 이 기사의 밸류체인과 시장 상황을 두루 분석해서, 실제로 연관성이 높은 키워드를 총 10개 추천해줘: " +
        "(1) 종목 키워드 최대 5개 — 반드시 국내외 증권거래소에 상장되어 있는 기업명만. 비상장 기업은 제외해. " +
        "(2) 기술 키워드 최대 5개 — 핵심 부품·소재명, 기술명, 제품명 중 무엇이든 될 수 있다 (기업명 제외). " +
        "기사에 직접 언급되지 않았더라도, 같은 밸류체인(공급망, 고객사, 경쟁사, 후공정/소부장 등)에 속해 수요나 실적에 실질적으로 영향을 받을 만한 항목이면 포함해라. " +
        singleTermRule +
        " " +
        koreanOnlyRule
      : "다음은 한 개인 투자자가 직접 읽고 정리한 뉴스 기록의 요점들이다. 이 내용의 밸류체인과 시장 상황을 두루 분석해서, 실제로 연관성이 높은 키워드를 총 10개 추천해줘: " +
        "(1) 종목 키워드 최대 5개 — 반드시 국내외 증권거래소에 상장되어 있는 기업명만. 비상장 기업은 제외해. " +
        "(2) 기술 키워드 최대 5개 — 핵심 부품·소재명, 기술명, 제품명 중 무엇이든 될 수 있다 (기업명 제외). " +
        "직접 언급되지 않았더라도, 같은 밸류체인(공급망, 고객사, 경쟁사, 후공정/소부장 등)에 속해 수요나 실적에 실질적으로 영향을 받을 만한 항목이면 포함해라. " +
        singleTermRule +
        " " +
        koreanOnlyRule;

  const jsonInstruction =
    '반드시 아래 JSON 형식으로만 응답해. 코드블록 표시(```)나 다른 설명 문장 없이 JSON 객체 하나만 출력해.\n' +
    '{"stockKeywords": ["단일 용어 상장기업 키워드 (최대 5개, 괄호/슬래시 금지)"], ' +
    '"techKeywords": ["단일 용어 핵심부품/기술/제품 키워드 (최대 5개, 괄호/슬래시 금지)"]}';

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
        max_tokens: 450,
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
      parsed = { stockKeywords: [], techKeywords: [] };
    }

    return json({
      stockKeywords: normalizeKeywords(parsed.stockKeywords, 5),
      techKeywords: normalizeKeywords(parsed.techKeywords, 5),
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
