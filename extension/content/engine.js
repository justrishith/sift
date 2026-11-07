/*
 * DeepSafe - content engine
 * -------------------------
 * Runs on the supported sites. Three jobs, in priority order:
 *
 *   1. SECTION GATING  (deterministic, CSS)
 *      Hide whole surfaces the user opted into hiding (Reels, Shorts,
 *      Explore, promoted rails...). Applied via an injected <style> so
 *      it happens before paint and costs nothing at runtime.
 *
 *   2. PER-ITEM FILTER  (heuristics, DOM)
 *      For posts that survive gating, identify paid/sponsored units and
 *      score them for deepfake-scam signals (impersonated celebrity +
 *      money language, urgency, mismatched destination).
 *
 *   3. CREATIVE MATCH  (perceptual hash)
 *      Hash the thumbnail of a suspicious post and compare it against
 *      a local list of known deepfake ad creatives. Catches the same
 *      campaign across sites without any ML.
 *
 * Everything is local. Nothing is uploaded unless the user files a report.
 */
(() => {
  "use strict";

  const RULES = globalThis.DEEPSAFE_SECTIONS || {};
  const site = detectSite(location.hostname);
  if (!site) return;

  let cfg = null;
  let styleEl = null;
  let lastHref = location.href;
  let running = true;

  const seenArticles = new WeakSet();
  const seenImages = new WeakSet();

  /* ---------- site detection ---------- */

  function detectSite(host) {
    for (const [key, def] of Object.entries(RULES)) {
      if (def.hostnames.some((h) => host === h || host.endsWith("." + h))) {
        return key;
      }
    }
    return null;
  }

  /* ---------- messaging ---------- */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(reply);
        });
      } catch {
        resolve(null); // extension was reloaded; fail quiet
      }
    });
  }

  function report(delta) {
    send({ type: "record", site, ...delta });
  }

  /* ---------- 1. section gating ---------- */

  const VALID = new Map();

  function isValidSelector(sel) {
    if (VALID.has(sel)) return VALID.get(sel);
    let ok = true;
    try {
      document.querySelector(sel);
    } catch {
      ok = false;
    }
    VALID.set(sel, ok);
    return ok;
  }

  function activeSections() {
    const out = [];
    if (!cfg || !cfg.enabled) return out;
    const defs = RULES[site].sections;
    for (const s of defs) {
      const on = cfg.sections ? cfg.sections[s.id] : s.default;
      if (!on) continue;
      if (s.urlPattern && !new RegExp(s.urlPattern).test(location.href)) continue;
      out.push(s);
    }
    return out;
  }

  function applySections() {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "deepsafe-style";
      (document.head || document.documentElement).appendChild(styleEl);
    }

    const selectors = [];
    for (const s of activeSections()) {
      for (const sel of s.selectors) {
        if (isValidSelector(sel)) selectors.push(sel);
      }
    }

    // One invalid selector would invalidate the whole rule, so each
    // selector is pre-validated above and emitted individually.
    styleEl.textContent = selectors.map((s) => `${s}{display:none!important}`).join("\n");

    if (cfg && cfg.debug) {
      const n = selectors.length;
      console.info(`[DeepSafe] ${site}: ${n} section selector(s) active`);
    }
  }

  /* ---------- 2. per-item filter ---------- */

  const SPONSOR_LABELS = new Set([
    "sponsored", "gesponsert", "publicidad", "sponsorisé", "sponsorizzato",
    "gesponsord", "patrocinado", "anúncio", "реклама", "赞助", "广告", "広告",
    "스폰서", "promoted", "paid partnership", "suggested for you"
  ]);

  // Words that show up in practically every deepfake investment scam ad.
  const MONEY_WORDS = [
    "invest", "bitcoin", "crypto", "ethereum", "giveaway", "double your",
    "guaranteed return", "trading platform", "ai bot", "passive income",
    "stimulus", "refund", "rebate", "medicare", "social security",
    "limited time", "claim now", "act now", "risk-free", "free money"
  ];

  // Names most often impersonated in deepfake ad campaigns.
  const IMPERSONATED = [
    "elon musk", "jeff bezos", "bill gates", "mark zuckerberg", "warren buffett",
    "tim cook", "sundar pichai", "donald trump", "joe biden", "kamala harris",
    "keanu reeves", "tom hanks", "oprah", "taylor swift", "mrbeast", "rihanna",
    "cristiano ronaldo", "lionel messi", "dwayne johnson", "the rock"
  ];

  const URGENCY = [
    "before it's too late", "only today", "last chance", "expires",
    "you have been selected", "congratulations", "winner", "exclusive"
  ];

  function labelText(el) {
    const t = (el.textContent || "").trim().toLowerCase();
    return t.length <= 28 ? t : "";
  }

  function findContainer(el) {
    let node = el;
    for (let i = 0; i < 14 && node; i++) {
      if (
        node.matches?.(
          "article, div[role='article'], div[data-pagelet^='FeedUnit'], div[data-e2e*='item'], div[data-testid='cellInnerDiv']"
        )
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function scoreText(text) {
    const t = text.toLowerCase();
    let score = 0;
    const signals = [];

    const person = IMPERSONATED.find((p) => t.includes(p));
    if (person) {
      score += 2;
      signals.push(`impersonates ${person}`);
    }

    const money = MONEY_WORDS.filter((w) => t.includes(w));
    if (money.length) {
      score += Math.min(money.length, 2);
      signals.push(`money language: ${money.slice(0, 3).join(", ")}`);
    }

    if (URGENCY.some((w) => t.includes(w))) {
      score += 1;
      signals.push("urgency language");
    }

    // A "news" article that is actually an ad is a classic deepfake wrapper.
    if (/(breaking|exclusive interview|leaked|banned from tv)/.test(t) && money.length) {
      score += 1;
      signals.push("fake-news framing");
    }

    return { score, signals };
  }

  function hide(el, kind) {
    if (!el || el.classList.contains("ds-hidden")) return false;
    el.classList.add("ds-hidden");
    report(kind === "section" ? { sections: 1 } : { items: 1 });
    return true;
  }

  function inspectArticle(article) {
    if (seenArticles.has(article)) return;
    seenArticles.add(article);

    let sponsored = false;

    // Look for a short "Sponsored"-style label inside the post.
    const candidates = article.querySelectorAll("span, a, div[dir='auto']");
    const limit = Math.min(candidates.length, 80);
    for (let i = 0; i < limit; i++) {
      const t = labelText(candidates[i]);
      if (t && SPONSOR_LABELS.has(t)) {
        sponsored = true;
        break;
      }
    }

    if (!sponsored) return;

    const text = article.innerText || "";
    const { score, signals } = scoreText(text);

    // Policy: every sponsored unit is hidden if the user asked for it.
    // Anything scoring >= 2 is hidden regardless, and flagged as a
    // likely deepfake scam.
    if (cfg.hideSponsored) hide(article, "item");
    if (score >= 2) {
      hide(article, "item");
      send({ type: "suspicious", site, signals, url: location.href });
    }

    if (cfg.matchCreatives) {
      const img = article.querySelector("img[src^='http']");
      if (img && !seenImages.has(img)) {
        seenImages.add(img);
        send({ type: "hashCheck", src: img.currentSrc || img.src }).then((res) => {
          if (res && res.match) {
            hide(article, "item");
            send({
              type: "suspicious",
              site,
              signals: ["known deepfake creative"],
              url: location.href
            });
          }
        });
      }
    }
  }

  function scanItems() {
    if (!cfg || !cfg.enabled) return;
    if (!cfg.hideSponsored && !cfg.matchCreatives) return;

    const articles = document.querySelectorAll(
      "article, div[role='article'], div[data-pagelet^='FeedUnit'], div[data-testid='cellInnerDiv']"
    );

    let budget = 40; // bounded work per pass
    for (const a of articles) {
      if (budget-- <= 0) break;
      if (seenArticles.has(a)) continue;
      if (!a.innerText || a.innerText.length < 4) continue;
      inspectArticle(a);
    }
  }

  /* ---------- observers & lifecycle ---------- */

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    const run = () => {
      scanQueued = false;
      if (!running) return;
      scanItems();
    };
    if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 1200 });
    else setTimeout(run, 600);
  }

  function watchDom() {
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          queueScan();
          return;
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  function watchUrl() {
    const check = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      // SPA navigation: URL-pattern sections may now apply (or stop applying).
      applySections();
    };
    for (const fn of ["pushState", "replaceState"]) {
      const orig = history[fn];
      history[fn] = function (...args) {
        const r = orig.apply(this, args);
        setTimeout(check, 0);
        return r;
      };
    }
    window.addEventListener("popstate", check);
    setInterval(check, 1500);
  }

  function watchSettings() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.enabled || changes.sections || changes.hideSponsored || changes.debug || changes.matchCreatives) {
        refresh();
      }
    });
  }

  /* ---------- boot ---------- */

  async function refresh() {
    cfg = await send({ type: "getContentConfig", site });
    if (!cfg) return;
    applySections();
    queueScan();
  }

  async function boot() {
    cfg = await send({ type: "getContentConfig", site });
    if (cfg) {
      applySections();
      watchDom();
      watchUrl();
      watchSettings();
      queueScan();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
