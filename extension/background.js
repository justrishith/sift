/*
 * Sift — service worker
 * ---------------------
 * Owns exactly one network call: article text -> /api/score-page -> verdict.
 * The Gemini key lives on the server. It never enters this bundle.
 *
 * If the endpoint is down, scorePage returns { ok: false, blur: false } and
 * the page is left alone. Sift fails open on purpose: a broken classifier
 * must never break the reader's page.
 */

const PROXY_URL = "https://sift-steel.vercel.app/api/score-page";
const TIMEOUT_MS = 15000;
const CACHE_LIMIT = 200;

const pageCache = new Map();

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
/* scoring                                                             */
/* ------------------------------------------------------------------ */

async function scorePage(msg) {
  const text = String(msg.text || "").slice(0, 6000);
  const title = String(msg.title || "").slice(0, 300);

  if (text.length < 200) return { ok: false, blur: false, error: "text-too-short" };

  const key = `${title}|${text.length}|${text.slice(0, 120)}`;
  if (pageCache.has(key)) return pageCache.get(key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(PROXY_URL, {
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
