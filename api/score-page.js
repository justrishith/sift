// Sift - page scoring endpoint (Vercel serverless function)
// Holds the Gemini key server-side. The extension never sees it.

const MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
].filter(Boolean);

const PROMPT = `You classify news article text for a tool that protects older readers from AI-generated slop.

Decide whether this reads like:
- "synthetic": fabricated article or AI-generated content posing as reporting
- "content_farm": mass-produced, low-quality, machine-written content
- "editorial": genuine journalism, even if opinionated or low quality

Be conservative. Only use "synthetic" or "content_farm" with strong evidence.
Never label a real news article as synthetic without clear signs.
Give short, concrete reasons a non-technical person could understand.

Return JSON only.`;

const SCHEMA = {
  type: "object",
  properties: {
    slop: { type: "number", description: "0 to 1" },
    category: { type: "string", enum: ["synthetic", "content_farm", "editorial"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["slop", "category", "confidence", "reasons"],
};

const cache = new Map();

async function callGemini(apiKey, title, text) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${PROMPT}\n\nTITLE: ${title}\n\nARTICLE:\n${text}` }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    },
  };

  let lastError = "unknown";
  for (const model of MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        lastError = `${model}: HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) {
        lastError = `${model}: empty response`;
        continue;
      }
      const parsed = JSON.parse(raw);
      return { ...parsed, model };
    } catch (e) {
      lastError = `${model}: ${e.message}`;
    }
  }
  throw new Error(lastError);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "sift-score" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "GEMINI_API_KEY not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const title = String(body?.title || "").slice(0, 300);
  const text = String(body?.text || "").slice(0, 6000);
  if (text.length < 200) {
    return res.status(400).json({ ok: false, error: "text too short" });
  }

  const key = `${title}|${text.length}|${text.slice(0, 80)}`;
  if (cache.has(key)) return res.status(200).json({ ok: true, ...cache.get(key) });

  try {
    const r = await callGemini(apiKey, title, text);
    const out = {
      slop: Number(r.slop) || 0,
      category: r.category || "editorial",
      confidence: r.confidence || "low",
      reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 4) : [],
      model: r.model,
      blur: (r.category || "editorial") !== "editorial" && Number(r.slop) >= 0.75,
    };
    if (cache.size > 500) cache.clear();
    cache.set(key, out);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
};
