/*
 * Sift — service worker
 * ---------------------
 * Two network calls, both server-side:
 *   - scorePage:   article text -> /api/score-page  -> one verdict for the page
 *   - scoreImages: up to 6 images -> /api/score-image -> one verdict per picture
 *
 * Vision calls are batched. One request for six pictures is much faster than
 * six requests, and it keeps the free tier happier.
 *
 * Verdicts are cached in chrome.storage.local for a week, so a reload is
 * instant and repeat pictures never hit Gemini again.
 *
 * The Gemini key lives on the server. It never enters this bundle.
 *
 * If either endpoint is down, the verdict is { blur: false } and the page is
 * left alone. Sift fails open on purpose: a broken classifier must never
 * break the reader's page.
 */

const PAGE_URL = "https://sift-steel.vercel.app/api/score-page";
const IMAGE_URL = "https://sift-steel.vercel.app/api/score-image";
const PAGE_TIMEOUT_MS = 15000;
const IMAGE_TIMEOUT_MS = 15000;
const PAGE_CACHE_LIMIT = 200;
const IMAGE_CACHE_KEY = "siftImageVerdicts";
const IMAGE_CACHE_MAX = 600;
const IMAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_BATCH_MAX = 8;
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_ITEM_BASE64 = 1_600_000;
const MAX_BATCH_BASE64 = 3_500_000;

const pageCache = new Map();
const imageCache = new Map(); // "u:<url>" or "h:<hash>" -> { verdict, ts }

/* ------------------------------------------------------------------ */
/* image cache                                                         */
/* ------------------------------------------------------------------ */

const cacheReady = (async () => {
  try {
    const stored = await chrome.storage.local.get(IMAGE_CACHE_KEY);
    const saved = stored && stored[IMAGE_CACHE_KEY];
    if (!saved || typeof saved !== "object") return;

    const now = Date.now();
    for (const [key, entry] of Object.entries(saved)) {
      if (imageCache.size >= IMAGE_CACHE_MAX) break;
      if (!entry || typeof entry !== "object" || !entry.verdict) continue;
      if (typeof entry.ts !== "number" || now - entry.ts > IMAGE_CACHE_TTL_MS) continue;
      imageCache.set(key, entry);
    }
  } catch {
    /* cache is an optimisation; never fail because of it */
  }
})();

let persistTimer = null;

function scheduleCachePersist() {
  if (persistTimer) return;

  persistTimer = setTimeout(async () => {
    persistTimer = null;

    const saved = {};
    let count = 0;
    for (const [key, entry] of imageCache) {
      if (count >= IMAGE_CACHE_MAX) break;
      saved[key] = entry;
      count += 1;
    }

    try {
      await chrome.storage.local.set({ [IMAGE_CACHE_KEY]: saved });
    } catch {
      /* ignore */
    }
  }, 800);
}

function hashData(data) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;

  for (let i = 0; i < data.length; i += 1) {
    const c = data.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }

  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

function getCached(src, hash) {
  const now = Date.now();
  const keys = [hash ? `h:${hash}` : "", `u:${src}`].filter(Boolean);

  for (const key of keys) {
    const entry = imageCache.get(key);
    if (!entry) continue;

    if (now - entry.ts > IMAGE_CACHE_TTL_MS) {
      imageCache.delete(key);
      continue;
    }

    return entry.verdict;
  }

  return null;
}

function setCached(src, hash, verdict) {
  const entry = { verdict, ts: Date.now() };
  imageCache.set(`u:${src}`, entry);
  if (hash) imageCache.set(`h:${hash}`, entry);

  if (imageCache.size > IMAGE_CACHE_MAX) {
    let excess = imageCache.size - IMAGE_CACHE_MAX;
    for (const key of imageCache.keys()) {
      if (excess <= 0) break;
      imageCache.delete(key);
      excess -= 1;
    }
  }

  scheduleCachePersist();
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function freshStats() {
  return { week: weekKey(), pages: 0, images: 0 };
}

async function getState() {
  const stored = await chrome.storage.local.get(["enabled", "blurImages", "stats"]);
  return {
    enabled: stored.enabled ?? true,
    blurImages: stored.blurImages ?? true,
    stats: stored.stats && stored.stats.week === weekKey() ? stored.stats : freshStats()
  };
}

/* ------------------------------------------------------------------ */
/* page scoring                                                        */
/* ------------------------------------------------------------------ */

async function scorePage(msg) {
  const text = String(msg.text || "").slice(0, 6000);
  const title = String(msg.title || "").slice(0, 300);

  if (text.length < 200) return { ok: false, blur: false, error: "text-too-short" };

  const key = `${title}|${text.length}|${text.slice(0, 120)}`;
  if (pageCache.has(key)) return pageCache.get(key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);

  try {
    const res = await fetch(PAGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, text }),
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`score ${res.status}`);

    const data = await res.json();
    const verdict = {
      ok: true,
      slop: Number(data.slop) || 0,
      category: data.category || "editorial",
      confidence: data.confidence || "low",
      blur: Boolean(data.blur)
    };

    if (verdict.blur) {
      pending.pages += 1;
      scheduleFlush();
    }

    if (pageCache.size >= PAGE_CACHE_LIMIT) pageCache.clear();
    pageCache.set(key, verdict);
    return verdict;
  } catch (e) {
    return { ok: false, blur: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* image scoring                                                       */
/* ------------------------------------------------------------------ */

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x2000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* Downscale before sending. Fewer tokens, smaller payload, same verdict. */
async function prepareImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const max = 512;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return {
    mime: "image/jpeg",
    data: toBase64(await out.arrayBuffer())
  };
}

async function fetchAndPrepare(src, signal) {
  const imgRes = await fetch(src, {
    credentials: "omit",
    cache: "force-cache",
    referrerPolicy: "no-referrer",
    signal
  });

  if (!imgRes.ok) throw new Error(`image ${imgRes.status}`);

  const blob = await imgRes.blob();
  if (!/^image\//.test(blob.type)) throw new Error("not-an-image");
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("image-too-large");

  try {
    return await prepareImage(blob);
  } catch {
    return {
      mime: /^image\/(png|jpeg|webp|gif)$/.test(blob.type) ? blob.type : "image/jpeg",
      data: toBase64(await blob.arrayBuffer())
    };
  }
}

async function scoreImages(msg) {
  const items = Array.isArray(msg.items) ? msg.items.slice(0, IMAGE_BATCH_MAX) : [];
  if (!items.length) return { ok: false, results: [] };

  await cacheReady;

  const results = new Array(items.length).fill(null);
  const missing = [];

  for (let i = 0; i < items.length; i += 1) {
    const src = String(items[i].src || "");
    if (!/^https?:\/\//.test(src)) {
      results[i] = { ok: false, blur: false, error: "bad-src" };
      continue;
    }

    const cached = getCached(src, null);
    if (cached) {
      results[i] = { ok: true, ...cached, cached: true };
      continue;
    }

    missing.push({ index: i, src, alt: String(items[i].alt || "").slice(0, 200) });
  }

  if (!missing.length) {
    return {
      ok: true,
      results: items.map((item, i) => ({ src: item.src, ...(results[i] || { ok: false, blur: false }) }))
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const prepared = await Promise.allSettled(
      missing.map((item) => fetchAndPrepare(item.src, controller.signal))
    );

    const payload = [];
    for (let i = 0; i < missing.length; i += 1) {
      const item = missing[i];
      const outcome = prepared[i];

      if (outcome.status !== "fulfilled") {
        results[item.index] = {
          ok: false,
          blur: false,
          error: String((outcome.reason && outcome.reason.message) || outcome.reason)
        };
        continue;
      }

      if (outcome.value.data.length > MAX_ITEM_BASE64) {
        results[item.index] = { ok: false, blur: false, error: "image-too-large" };
        continue;
      }

      const hash = hashData(outcome.value.data);
      const cached = getCached(item.src, hash);
      if (cached) {
        results[item.index] = { ok: true, ...cached, cached: true };
        continue;
      }

      payload.push({ ...item, ...outcome.value, hash });
    }

    if (!payload.length) {
      return {
        ok: true,
        results: items.map((item, i) => ({ src: item.src, ...(results[i] || { ok: false, blur: false }) }))
      };
    }

    let total = 0;
    const sent = [];
    for (const item of payload) {
      if (total + item.data.length > MAX_BATCH_BASE64) break;
      total += item.data.length;
      sent.push(item);
    }
    for (const item of payload.slice(sent.length)) {
      results[item.index] = { ok: false, blur: false, error: "batch-too-large" };
    }

    const res = await fetch(IMAGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: sent.map(({ mime, data }) => ({ image: data, mime }))
      }),
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`vision ${res.status}`);

    const data = await res.json();
    if (!data || data.ok === false) throw new Error((data && data.error) || "vision-failed");

    const list = Array.isArray(data.results) ? data.results : [];

    for (let i = 0; i < sent.length; i += 1) {
      const item = sent[i];
      const result = list[i];

      if (!result) {
        results[item.index] = { ok: false, blur: false, error: "no-verdict" };
        continue;
      }

      const verdict = {
        ai: Number(result.ai) || 0,
        confidence: result.confidence || "low",
        blur: Boolean(result.blur)
      };

      results[item.index] = { ok: true, ...verdict };
      setCached(item.src, item.hash, verdict);
    }
  } catch (e) {
    const error = String((e && e.message) || e);
    for (const item of missing) {
      if (!results[item.index]) results[item.index] = { ok: false, blur: false, error };
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    ok: true,
    results: items.map((item, i) => ({ src: item.src, ...(results[i] || { ok: false, blur: false }) }))
  };
}

/* ------------------------------------------------------------------ */
/* stats                                                               */
/* ------------------------------------------------------------------ */

const pending = { pages: 0, images: 0 };
let flushTimer = null;

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushStats, 1200);
}

async function flushStats() {
  if (!pending.pages && !pending.images) return;

  const state = await getState();
  const stats = state.stats.week === weekKey() ? state.stats : freshStats();
  stats.pages += pending.pages;
  stats.images += pending.images;

  pending.pages = 0;
  pending.images = 0;

  await chrome.storage.local.set({ stats });
  await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  await chrome.action.setBadgeText({ text: stats.images ? String(stats.images) : "" });
}

/* ------------------------------------------------------------------ */
/* messaging                                                           */
/* ------------------------------------------------------------------ */

async function handle(msg) {
  switch (msg.type) {
    case "getState":
      return getState();

    case "scorePage":
      return scorePage(msg);

    case "scoreImages":
      return scoreImages(msg);

    case "scoreImage": {
      const reply = await scoreImages({ items: [{ src: msg.src, alt: msg.alt }] });
      return (reply.results && reply.results[0]) || { ok: false, blur: false };
    }

    case "record":
      pending.images += msg.imagesHidden || 0;
      scheduleFlush();
      return { ok: true };

    case "setSettings": {
      const patch = msg.patch || {};
      await chrome.storage.local.set(patch);
      return getState();
    }

    default:
      return { ok: false, error: "unknown-message" };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  handle(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["enabled", "blurImages"]);
  const patch = {};
  if (stored.enabled === undefined) patch.enabled = true;
  if (stored.blurImages === undefined) patch.blurImages = true;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

chrome.runtime.onStartup.addListener(async () => {
  const { stats } = await getState();
  await chrome.action.setBadgeText({ text: stats.images ? String(stats.images) : "" });
});
