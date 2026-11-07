/*
 * Sift — service worker
 * ---------------------
 * Two network calls, both server-side:
 *   - scorePage:  article text -> /api/score-page  -> one verdict for the page
 *   - scoreImage: one image    -> /api/score-image -> one verdict for the picture
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
const IMAGE_TIMEOUT_MS = 25000;
const CACHE_LIMIT = 200;
const IMAGE_CACHE_LIMIT = 500;
const MAX_IMAGE_BYTES = 8_000_000;

const pageCache = new Map();
const imageCache = new Map();

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
  const stored = await chrome.storage.local.get(null);
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
      reasons: Array.isArray(data.reasons) ? data.reasons.slice(0, 4) : [],
      blur: Boolean(data.blur)
    };

    if (verdict.blur) {
      pending.pages += 1;
      scheduleFlush();
    }

    if (pageCache.size >= CACHE_LIMIT) pageCache.clear();
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

  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  return {
    mime: "image/jpeg",
    data: toBase64(await out.arrayBuffer())
  };
}

async function scoreImage(msg) {
  const src = String(msg.src || "");
  if (!/^https?:\/\//.test(src)) return { ok: false, blur: false, error: "bad-src" };
  if (imageCache.has(src)) return imageCache.get(src);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const imgRes = await fetch(src, {
      credentials: "omit",
      cache: "force-cache",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });

    if (!imgRes.ok) throw new Error(`image ${imgRes.status}`);

    const blob = await imgRes.blob();
    if (!/^image\//.test(blob.type)) throw new Error("not-an-image");
    if (blob.size > MAX_IMAGE_BYTES) throw new Error("image-too-large");

    let prepared;
    try {
      prepared = await prepareImage(blob);
    } catch {
      prepared = {
        mime: /^image\/(png|jpeg|webp|gif)$/.test(blob.type) ? blob.type : "image/jpeg",
        data: toBase64(await blob.arrayBuffer())
      };
    }

    if (prepared.data.length > 3_000_000) throw new Error("image-too-large");

    const res = await fetch(IMAGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: prepared.data, mime: prepared.mime }),
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`vision ${res.status}`);

    const data = await res.json();
    const verdict = {
      ok: true,
      ai: Number(data.ai) || 0,
      confidence: data.confidence || "low",
      reasons: Array.isArray(data.reasons) ? data.reasons.slice(0, 3) : [],
      blur: Boolean(data.blur)
    };

    if (imageCache.size >= IMAGE_CACHE_LIMIT) imageCache.clear();
    imageCache.set(src, verdict);
    return verdict;
  } catch (e) {
    return { ok: false, blur: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
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

    case "scoreImage":
      return scoreImage(msg);

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
