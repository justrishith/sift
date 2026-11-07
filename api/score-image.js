// Sift - per-image vision scoring (Vercel serverless function)
// Receives one image as base64 from the extension, asks Gemini whether the
// pixels look AI-generated. The Gemini key never leaves the server.

const crypto = require("crypto");

const MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
].filter(Boolean);

const PROMPT = `You are an image forensics assistant for a tool that protects readers from AI-generated images.

Decide whether this image is an AI-generated photograph (including photorealistic output from diffusion or GAN models) or something else.

Score high only when the pixels show generative artifacts: impossible anatomy, melted or garbled text, inconsistent lighting or shadows, repeating textures, oversmooth skin, warped background geometry, synthetic bokeh, or diffusion noise.

Score low for real photographs, screenshots, charts, infographics, logos, illustrations, memes, and images of text. An image that merely depicts or explains AI is not itself AI-generated.

Be conservative. Return JSON only.`;

const SCHEMA = {
  type: "object",
  properties: {
    ai: { type: "number", description: "0 to 1 probability that this is an AI-generated photograph" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["ai", "confidence", "reasons"],
};

const cache = new Map();

async function callGemini(apiKey, data, mime) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: mime, data } }, { text: PROMPT }],
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
      const json = await res.json();
      const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) {
        lastError = `${model}: empty response`;
        continue;
      }
      return { ...JSON.parse(raw), model };
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
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "sift-image" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: "GEMINI_API_KEY not configured" });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const image = typeof body?.image === "string" ? body.image : "";
  const mime = /^image\/(jpeg|png|webp|gif)$/.test(body?.mime) ? body.mime : "image/jpeg";

  if (image.length < 100) return res.status(400).json({ ok: false, error: "image too small" });
  if (image.length > 3_000_000) return res.status(413).json({ ok: false, error: "image too large" });

  const hash = crypto.createHash("sha256").update(image).digest("hex");
  if (cache.has(hash)) return res.status(200).json({ ok: true, ...cache.get(hash) });

  try {
    const r = await callGemini(apiKey, image, mime);
    const ai = Math.max(0, Math.min(1, Number(r.ai) || 0));
    const out = {
      ai,
      confidence: r.confidence || "low",
      reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 3) : [],
      model: r.model,
      blur: ai >= 0.75 && (r.confidence || "low") !== "low",
    };

    if (cache.size > 400) cache.clear();
    cache.set(hash, out);

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
};
