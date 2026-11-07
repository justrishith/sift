/*
 * DeepSafe - service worker
 * -------------------------
 * The brain. It owns:
 *   - the master switch (also toggles the static DNR ruleset)
 *   - the blocklist sync loop (static rules ship in the package,
 *     dynamic rules come from your API every 6 hours)
 *   - user trusted sites (high-priority `allow` rules)
 *   - local stats
 *   - the perceptual-hash service used by the content engine
 *   - URL risk scoring (works fully offline)
 */
importScripts("shared/sections.js");

const SECTION_DEFS = self.DEEPSAFE_SECTIONS || {};

const ALL_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket",
  "webtransport", "webbundle", "other"
];

/* ------------------------------------------------------------------ */
/* defaults                                                            */
/* ------------------------------------------------------------------ */

function defaultSections() {
  const out = {};
  for (const def of Object.values(SECTION_DEFS)) {
    for (const s of def.sections) out[s.id] = s.default;
  }
  return out;
}

function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function freshStats() {
  return { week: weekKey(), sections: 0, items: 0, pages: 0, images: 0 };
}

async function getState() {
  const stored = await chrome.storage.local.get(null);
  return {
    enabled: stored.enabled ?? true,
    hideSponsored: stored.hideSponsored ?? true,
    matchCreatives: stored.matchCreatives ?? true,
    blurImages: stored.blurImages ?? true,
    visionEndpoint: stored.visionEndpoint ?? "",
    debug: stored.debug ?? false,
    blocklistUrl: stored.blocklistUrl ?? "",
    trustedSites: stored.trustedSites ?? [],
    sections: stored.sections ?? {},
    stats: stored.stats && stored.stats.week === weekKey() ? stored.stats : freshStats(),
    hashes: stored.hashes ?? [],
    lastSync: stored.lastSync ?? 0,
    lastSyncError: stored.lastSyncError ?? "",
    reports: stored.reports ?? [],
    suspicious: stored.suspicious ?? []
  };
}

/* ------------------------------------------------------------------ */
/* dynamic rules                                                       */
/* ------------------------------------------------------------------ */

async function rebuildDynamicRules() {
  const state = await getState();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = [];

  if (!state.enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    return;
  }

  // Trusted sites get priority 100 so they always beat every block rule.
  state.trustedSites.slice(0, 300).forEach((domain, i) => {
    const clean = String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!clean) return;
    addRules.push({
      id: 10 + i,
      priority: 100,
      action: { type: "allow" },
      condition: { requestDomains: [clean], resourceTypes: ALL_TYPES }
    });
  });

  const remote = await chrome.storage.local.get("remoteDomains");
  const domains = (remote.remoteDomains || []).slice(0, 2000);
  if (domains.length) {
    addRules.push(
      {
        id: 1000,
        priority: 20,
        action: {
          type: "redirect",
          redirect: { extensionPath: "/blocked/blocked.html" }
        },
        condition: { requestDomains: domains, resourceTypes: ["main_frame"] }
      },
      {
        id: 1001,
        priority: 20,
        action: { type: "block" },
        condition: {
          requestDomains: domains,
          resourceTypes: ALL_TYPES.filter((t) => t !== "main_frame")
        }
      }
    );
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

async function applyEnabled(enabled) {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      enabled
        ? { enableRulesetIds: ["scam_destinations"] }
        : { disableRulesetIds: ["scam_destinations"] }
    );
  } catch (e) {
    console.warn("[DeepSafe] ruleset toggle failed", e);
  }
  await rebuildDynamicRules();
  await updateBadge(enabled);
}

async function updateBadge(enabled) {
  if (!enabled) {
    await chrome.action.setBadgeText({ text: "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: "#8a8f98" });
    return;
  }
  const state = await getState();
  const n = state.stats.sections + state.stats.items;
  await chrome.action.setBadgeBackgroundColor({ color: "#1e8e6b" });
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
}

/* ------------------------------------------------------------------ */
/* blocklist sync                                                      */
/* ------------------------------------------------------------------ */

async function syncBlocklist() {
  const state = await getState();
  if (!state.blocklistUrl) {
    await chrome.storage.local.set({ lastSync: Date.now(), lastSyncError: "" });
    return { ok: true, reason: "no-endpoint" };
  }

  try {
    const res = await fetch(state.blocklistUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const domains = Array.isArray(data.domains) ? data.domains.filter(isPlainDomain) : [];
    const hashes = Array.isArray(data.hashes) ? data.hashes.filter(isHash) : [];

    await chrome.storage.local.set({
      remoteDomains: domains,
      hashes,
      lastSync: Date.now(),
      lastSyncError: ""
    });
    await rebuildDynamicRules();
    return { ok: true, domains: domains.length, hashes: hashes.length };
  } catch (e) {
    await chrome.storage.local.set({ lastSyncError: String(e && e.message ? e.message : e) });
    return { ok: false, error: String(e) };
  }
}

function isPlainDomain(d) {
  return typeof d === "string" && /^[a-z0-9.-]{3,253}$/i.test(d) && d.includes(".");
}

function isHash(h) {
  return typeof h === "string" && /^[0-9a-f]{16}$/i.test(h);
}

/* ------------------------------------------------------------------ */
/* perceptual hash (dHash)                                            */
/* ------------------------------------------------------------------ */

function bitsToHex(bits) {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
  }
  return hex;
}

async function dhash(url) {
  const res = await fetch(url, { credentials: "omit", cache: "force-cache" });
  if (!res.ok) throw new Error(`img ${res.status}`);
  const blob = await res.blob();
  if (blob.size > 6_000_000) throw new Error("image too large");

  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(9, 8);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, 9, 8);
  const { data } = ctx.getImageData(0, 0, 9, 8);
  bitmap.close?.();

  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = (y * 9 + x) * 4;
      const b = (y * 9 + x + 1) * 4;
      const ga = data[a] + data[a + 1] + data[a + 2];
      const gb = data[b] + data[b + 1] + data[b + 2];
      bits += ga > gb ? "1" : "0";
    }
  }
  return bitsToHex(bits);
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

const hashCache = new Map();

async function checkCreative(src) {
  try {
    if (!src || !/^https?:/.test(src)) return { match: false };
    if (hashCache.has(src)) return hashCache.get(src);

    const h = await dhash(src);
    const { hashes = [] } = await chrome.storage.local.get("hashes");
    const hit = hashes.find((known) => hamming(known, h) <= 8);
    const result = { match: Boolean(hit), hash: h, distance: hit ? hamming(hit, h) : null };

    if (hashCache.size > 3000) hashCache.clear();
    hashCache.set(src, result);
    return result;
  } catch {
    return { match: false, error: "hash-failed" };
  }
}

/* ------------------------------------------------------------------ */
/* URL risk scoring                                                    */
/* ------------------------------------------------------------------ */

const SUSPICIOUS_TLDS = [
  ".top", ".xyz", ".click", ".link", ".zip", ".mov", ".cfd", ".buzz",
  ".rest", ".lol", ".icu", ".cyou", ".sbs", ".monster", ".quest", ".cam"
];
const BRANDS = [
  "paypal", "apple", "google", "microsoft", "amazon", "netflix", "facebook",
  "instagram", "whatsapp", "bank", "chase", "wellsfargo", "irs", "medicare",
  "socialsecurity", "dhl", "fedex", "usps", "coinbase", "binance"
];
const SCAM_WORDS = [
  "giveaway", "claim", "prize", "winner", "investment", "bitcoin", "crypto",
  "double", "refund", "stimulus", "verify", "unlock", "act-now", "free"
];

function analyzeUrl(raw) {
  const signals = [];
  let score = 0;
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { score: 100, verdict: "unknown", signals: ["Not a valid address"], host: "" };
  }

  const host = u.hostname.toLowerCase();
  const path = (u.pathname + u.search).toLowerCase();

  if (host.includes("xn--")) {
    score += 40;
    signals.push("Punycode hostname — can render a lookalike of a real brand");
  }
  if (SUSPICIOUS_TLDS.some((t) => host.endsWith(t))) {
    score += 25;
    signals.push("Low-reputation domain ending");
  }

  const brand = BRANDS.find((b) => host.includes(b));
  if (brand) {
    const legit = new RegExp(`(^|\\.)${brand}\\.(com|org|net|co\\.uk)$`).test(host);
    if (!legit) {
      score += 40;
      signals.push(`Contains "${brand}" but is not the real ${brand} domain`);
    }
  }

  if ((host.match(/-/g) || []).length >= 3) {
    score += 15;
    signals.push("Many hyphens in the hostname");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    score += 30;
    signals.push("Raw IP address instead of a domain name");
  }
  if ((host.match(/\./g) || []).length >= 4) {
    score += 15;
    signals.push("Deeply nested subdomains");
  }

  const words = SCAM_WORDS.filter((w) => path.includes(w) || host.includes(w));
  if (words.length) {
    score += Math.min(words.length * 10, 30);
    signals.push(`Scam wording: ${words.slice(0, 3).join(", ")}`);
  }

  score = Math.min(score, 100);
  const verdict = score >= 60 ? "danger" : score >= 30 ? "caution" : "clear";
  return { score, verdict, signals, host };
}

/* ------------------------------------------------------------------ */
/* messaging                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* image verdicts                                                      */
/* ------------------------------------------------------------------ */

const imageVerdicts = new Map();

function safeHost(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// High-precision, zero-cost markers. If one of these is present we are
// confident enough to blur without calling any API.
const AI_MARKER =
  /(ai[-_ ]?generated|midjourney|dall[-_ ]?e|stable[-_ ]?diffusion|sdxl|sora|imagen|generated[-_ ]by[-_ ]ai)/i;

async function callVision(endpoint, msg) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image: msg.src,
        page: msg.pageUrl,
        alt: msg.alt || "",
        width: msg.width || 0,
        height: msg.height || 0
      }),
      signal: ctl.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // degrade to local signals, never block on failure
  } finally {
    clearTimeout(timer);
  }
}

async function computeImageVerdict(state, msg) {
  // 1. Known creative (perceptual hash). Free and precise.
  if (state.matchCreatives) {
    const r = await checkCreative(msg.src);
    if (r && r.match) {
      return { blur: true, confidence: "high", reasons: ["known AI creative"], layer: "hash" };
    }
  }

  // 2. AI marker in the file name or the caption.
  if (AI_MARKER.test(msg.src) || AI_MARKER.test(msg.alt || "")) {
    return { blur: true, confidence: "high", reasons: ["AI marker in file name or caption"], layer: "marker" };
  }

  // 3. Publisher already known to be a slop domain.
  const { slopDomains = [] } = await chrome.storage.local.get("slopDomains");
  const host = safeHost(msg.pageUrl);
  if (host && slopDomains.includes(host)) {
    return { blur: true, confidence: "high", reasons: ["publisher is on the slop list"], layer: "reputation" };
  }

  // 4. Paid vision check, only for candidates that survived the filters.
  if (state.visionEndpoint) {
    const out = await callVision(state.visionEndpoint, msg);
    if (out && typeof out.ai === "number" && out.ai >= 0.8 && out.confidence === "high") {
      return {
        blur: true,
        confidence: "high",
        reasons: out.reasons || ["vision detector: AI-generated"],
        layer: "vision"
      };
    }
  }

  return { blur: false, confidence: "none", reasons: [], layer: "none" };
}

async function scoreImage(msg) {
  const state = await getState();
  if (!state.enabled || state.blurImages === false) return { blur: false, reason: "disabled" };
  if (!msg.src) return { blur: false };

  if (imageVerdicts.has(msg.src)) return imageVerdicts.get(msg.src);

  const verdict = await computeImageVerdict(state, msg);
  if (imageVerdicts.size > 5000) imageVerdicts.clear();
  imageVerdicts.set(msg.src, verdict);
  return verdict;
}


const pendingStats = { sections: 0, items: 0, pages: 0, images: 0 };
let flushTimer = null;

async function flushStats() {
  if (!pendingStats.sections && !pendingStats.items && !pendingStats.pages && !pendingStats.images) return;
  const state = await getState();
  const stats = state.stats.week === weekKey() ? state.stats : freshStats();
  stats.sections += pendingStats.sections;
  stats.items += pendingStats.items;
  stats.pages += pendingStats.pages;
  stats.images += pendingStats.images;
  pendingStats.sections = 0;
  pendingStats.items = 0;
  pendingStats.pages = 0;
  pendingStats.images = 0;
  await chrome.storage.local.set({ stats });
  await updateBadge(state.enabled);
}

const PROXY_URL = "https://sift-steel.vercel.app/api/score-page";
const pageCache = new Map();

async function scorePage(msg) {
  const text = String(msg.text || "").slice(0, 4000);
  const title = String(msg.title || "").slice(0, 300);
  const key = `${title}|${text.length}|${text.slice(0, 80)}`;
  if (pageCache.has(key)) return pageCache.get(key);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, text, url: msg.url || "" }),
      signal: ctl.signal
    });
    if (!res.ok) throw new Error(`proxy ${res.status}`);
    const data = await res.json();
    const out = {
      ok: true,
      slop: Number(data.slop) || 0,
      category: data.category || "editorial",
      confidence: data.confidence || "low",
      reasons: Array.isArray(data.reasons) ? data.reasons : [],
      blur: Boolean(data.blur)
    };
    if (pageCache.size > 200) pageCache.clear();
    pageCache.set(key, out);
    return out;
  } catch (e) {
    return { ok: false, blur: false, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

async function handle(msg, sender) {
  switch (msg.type) {
    case "getState":
      return getState();

    case "getContentConfig": {
      const state = await getState();
      const sections = {};
      const def = SECTION_DEFS[msg.site];
      if (def) {
        for (const s of def.sections) {
          sections[s.id] = state.sections[s.id] ?? s.default;
        }
      }
      return {
        enabled: state.enabled,
        sections,
        hideSponsored: state.hideSponsored,
        matchCreatives: state.matchCreatives,
        debug: state.debug,
        hashCount: state.hashes.length
      };
    }

    case "record": {
      // Content scripts report constantly. Accumulate in memory and
      // write once every ~1.5s instead of on every single hit.
      pendingStats.sections += msg.sections || 0;
      pendingStats.items += msg.items || 0;
      pendingStats.pages += msg.pages || 0;
      pendingStats.images += msg.imagesHidden || 0;
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushStats, 1500);
      return { ok: true };
    }

    case "suspicious": {
      const state = await getState();
      const list = state.suspicious.slice(-99);
      list.push({ at: Date.now(), site: msg.site, signals: msg.signals, url: msg.url });
      await chrome.storage.local.set({ suspicious: list });
      return { ok: true };
    }

    case "hashCheck":
      return checkCreative(msg.src);

    case "scorePage":
      return scorePage(msg);

    case "scoreImage":
      return scoreImage(msg);

    case "checkUrl":
      return analyzeUrl(msg.url);

    case "setSettings": {
      const patch = msg.patch || {};
      await chrome.storage.local.set(patch);
      if ("enabled" in patch) await applyEnabled(patch.enabled);
      if ("trustedSites" in patch) await rebuildDynamicRules();
      return getState();
    }

    case "toggleSection": {
      const state = await getState();
      const sections = { ...state.sections, [msg.id]: Boolean(msg.on) };
      await chrome.storage.local.set({ sections });
      return { ok: true, sections };
    }

    case "resetSections": {
      await chrome.storage.local.set({ sections: {} });
      return { ok: true };
    }

    case "syncNow":
      return syncBlocklist();

    case "report": {
      const state = await getState();
      const reports = state.reports.slice(-49);
      reports.push({ at: Date.now(), ...msg.payload });
      await chrome.storage.local.set({ reports });
      return { ok: true, queued: reports.length };
    }

    case "trustSite": {
      const state = await getState();
      const domain = String(msg.domain || "").trim().toLowerCase()
        .replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!isPlainDomain(domain)) return { ok: false, error: "bad-domain" };
      if (!state.trustedSites.includes(domain)) {
        await chrome.storage.local.set({ trustedSites: [...state.trustedSites, domain] });
        await rebuildDynamicRules();
      }
      return getState();
    }

    case "untrustSite": {
      const state = await getState();
      await chrome.storage.local.set({
        trustedSites: state.trustedSites.filter((d) => d !== msg.domain)
      });
      await rebuildDynamicRules();
      return getState();
    }

    default:
      return { ok: false, error: "unknown-message" };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

async function init() {
  const state = await getState();
  await chrome.storage.local.set({
    enabled: state.enabled,
    hideSponsored: state.hideSponsored,
    matchCreatives: state.matchCreatives,
    trustedSites: state.trustedSites,
    sections: state.sections,
    stats: state.stats
  });
  await applyEnabled(state.enabled);
  await syncBlocklist();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await init();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "check-link",
      title: "Check this link with DeepSafe",
      contexts: ["link"]
    });
    chrome.contextMenus.create({
      id: "check-page",
      title: "Check this page with DeepSafe",
      contexts: ["page"]
    });
  });
  chrome.alarms.create("deep-safe-sync", { periodInMinutes: 360 });
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html?welcome=1") });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  await applyEnabled(state.enabled);
  await syncBlocklist();
  chrome.alarms.create("deep-safe-sync", { periodInMinutes: 360 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "deep-safe-sync") syncBlocklist();
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId === "check-link" ? info.linkUrl : info.pageUrl;
  if (!url) return;
  chrome.tabs.create({
    url: chrome.runtime.getURL("popup/popup.html?url=" + encodeURIComponent(url))
  });
});
