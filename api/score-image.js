// Sift - per-image vision scoring (Vercel serverless function)
// Receives one or more images as base64 from the extension, asks Gemini
// whether the pixels look AI-generated. The Gemini key never leaves the server.
//
// Batch mode is the fast path: one request for up to 8 images. One Gemini
// call with six small images is far quicker than six separate calls.

const crypto = require("crypto");

// gemini-3.1-flash-lite is gone; 3.5-flash-lite is the verified primary.
const MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
].filter(Boolean);

const BATCH_MAX = 8;
const MAX_IMAGE_CHARS = 3_000_000;

const PROMPT = (n) => `You will receive ${n} image${n === 1 ? "" : "s"}, each preceded by a label (Image 1${n > 1 ? `..Image ${n}` : ""}).

For each image, decide whether it is an AI-generated photograph (including photorealistic output from diffusion or GAN models).

Score high only when the pixels show generative artifacts: impossible anatomy, melted or garbled text, inconsistent lighting or shadows, repeating textures, oversmooth skin, warped background geometry, synthetic bokeh, or diffusion noise.

Score low for real photographs, screenshots, charts, infographics, logos, illustrations, memes, and images of text. An image that merely depicts or explains AI is not itself AI-generated.

Be conservative. Return exactly ${n} result${n === 1 ? "" : "s"}, one per image, in order. JSON only.`;

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "1-based image number" },
          ai: { type: "number", description: "0 to 1 probability that this is an AI-generated photograph" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["index", "ai", "confidence"],
      },
    },
  },
  required: ["results"],
};

const cache = new Map();

async function callGemini(apiKey, images) {
  const parts = [];
  images.forEach((image, i) => {
    parts.push({ text: `Image ${i + 1}` });
    parts.push({ inlineData: { mimeType: image.mime, data: image.image } });
  });
  parts.push({ text: PROMPT(images.length) });

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0,
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
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.results)) {
        lastError = `${model}: missing results`;
        continue;
      }
      return { results: parsed.results, model };
    } catch (e) {
      lastError = `${model}: ${e.message}`;
    }
  }
  throw new Error(lastError);
}

function normalize(results, count) {
  const byIndex = new Map();
  results.forEach((result, i) => {
    const index = Number.isInteger(result?.index) ? result.index : i + 1;
    byIndex.set(index, result);
  });

  return Array.from({ length: count }, (_, i) => {
    const result = byIndex.get(i + 1) || results[i] || {};
    const ai = Math.max(0, Math.min(1, Number(result.ai) || 0));
    const confidence = result.confidence || "low";
    return {
      ai,
      confidence,
      blur: ai >= 0.75 && confidence !== "low",
    };
  });
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

  const batch = Array.isArray(body?.images);
  const rawImages = batch ? body.images : [body];

  if (!rawImages.length) return res.status(400).json({ ok: false, error: "no images" });
  if (rawImages.length > BATCH_MAX) {
    return res.status(400).json({ ok: false, error: `too many images (max ${BATCH_MAX})` });
  }

  const images = [];
  for (const item of rawImages) {
    const image = typeof item?.image === "string" ? item.image : "";
    const mime = /^image\/(jpeg|png|webp|gif)$/.test(item?.mime) ? item.mime : "image/jpeg";

    if (image.length < 100) return res.status(400).json({ ok: false, error: "image too small" });
    if (image.length > MAX_IMAGE_CHARS) {
      return res.status(413).json({ ok: false, error: "image too large" });
    }

    images.push({ image, mime });
  }

  const hash = crypto.createHash("sha256");
  for (const image of images) {
    hash.update(image.image);
    hash.update("|");
  }
  const key = hash.digest("hex");

  if (cache.has(key)) {
    const hit = cache.get(key);
    const payload = { ok: true, results: hit.results, model: hit.model, cached: true };
    if (batch) return res.status(200).json(payload);
    return res.status(200).json({ ...payload, ...hit.results[0] });
  }

  try {
    const r = await callGemini(apiKey, images);
    const results = normalize(r.results, images.length);
    const entry = { results, model: r.model };

    if (cache.size > 400) cache.clear();
    cache.set(key, entry);

    if (batch) return res.status(200).json({ ok: true, ...entry });
    return res.status(200).json({ ok: true, ...entry, ...results[0] });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
};
