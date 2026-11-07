/*
 * Sift — image shield
 * -------------------
 * Two ways an image gets blocked:
 *   1. the page is judged AI slop  -> every content image gets a cover
 *   2. one image is judged AI      -> that image gets a cover
 *
 * Blocked images get a soft lilac cover with a flower, a "blocked by sift"
 * badge, and a "tap to peek" hint. Clicking a cover reveals that one picture.
 * A first click can never follow the link behind the image.
 *
 * Only images that intersect the viewport are scored, so offscreen and
 * lazy-loaded images are never fetched just to be judged. Vision calls are
 * batched six at a time for speed.
 *
 * Sift fails open: no verdict means no blur.
 */

(() => {
  "use strict";

  const BLUR_MIN_EDGE = 120;    // page verdict: skip icons, avatars, sprites
  const SCORE_MIN_WIDTH = 180;  // per-image vision: thumbnails and up
  const SCORE_MIN_HEIGHT = 120;
  const MAX_BLUR_IMAGES = 120;
  const MAX_SCORE_CALLS = 8;    // per page; keeps the free tier sane
  const BATCH_SIZE = 6;
  const BATCH_DELAY_MS = 60;

  const covers = new Map();
  const positionedParents = new Map();
  const scored = new WeakSet();
  const pending = [];

  let batchTimer = null;
  let flushing = false;
  let scoreCalls = 0;
  let enabled = true;
  let flagged = false;
  let articleMode = false;
  let lastVerdict = null;
  let flowerUrl = "";

  try {
    flowerUrl = chrome.runtime.getURL("icons/flower.svg");
  } catch {
    flowerUrl = "";
  }

  function flower() {
    const img = document.createElement("img");
    img.src = flowerUrl;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    return img;
  }

  /* ------------------------------------------------------------------ */
  /* messaging                                                           */
  /* ------------------------------------------------------------------ */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(reply);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* the cover                                                           */
  /* ------------------------------------------------------------------ */

  function positionParent(parent) {
    const entry = positionedParents.get(parent);
    if (entry) {
      entry.count += 1;
      return;
    }

    const prev = parent.style.position;
    const changed = getComputedStyle(parent).position === "static";
    if (changed) parent.style.position = "relative";
    positionedParents.set(parent, { count: 1, prev, changed });
  }

  function unpositionParent(parent) {
    const entry = positionedParents.get(parent);
    if (!entry) return;

    entry.count -= 1;
    if (entry.count > 0) return;

    if (entry.changed) parent.style.position = entry.prev;
    positionedParents.delete(parent);
  }

  function positionCover(img) {
    const entry = covers.get(img);
    if (!entry) return;

    const { cover, parent } = entry;
    const rect = img.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();

    cover.style.left = `${rect.left - parentRect.left + parent.scrollLeft}px`;
    cover.style.top = `${rect.top - parentRect.top + parent.scrollTop}px`;
    cover.style.width = `${rect.width}px`;
    cover.style.height = `${rect.height}px`;

    cover.classList.toggle("sift-cover-small", rect.width < 170 || rect.height < 140);
    cover.classList.toggle("sift-cover-tiny", rect.width < 90 || rect.height < 70);
  }

  function addCover(img) {
    if (covers.has(img)) return;

    const parent = img.parentElement;
    if (!parent) return;

    const cover = document.createElement("div");
    cover.className = "sift-cover";
    cover.setAttribute("role", "button");
    cover.tabIndex = 0;
    cover.setAttribute("aria-label", "Blocked by Sift. Activate to reveal this picture.");

    const badge = document.createElement("span");
    badge.className = "sift-cover-badge";
    const badgeLabel = document.createElement("span");
    badgeLabel.textContent = "blocked by sift";
    badge.append(flower(), badgeLabel);

    const mark = flower();
    mark.className = "sift-cover-mark";

    const hint = document.createElement("span");
    hint.className = "sift-cover-hint";
    hint.textContent = "tap to peek";

    cover.append(badge, mark, hint);

    const reveal = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      unblur(img);
    };

    cover.addEventListener("click", reveal, true);
    cover.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" || event.key === " ") reveal(event);
      },
      true
    );

    positionParent(parent);
    parent.appendChild(cover);

    const observer = new ResizeObserver(() => positionCover(img));
    observer.observe(img);

    covers.set(img, { cover, parent, observer });
    positionCover(img);
  }

  function removeCover(img) {
    const entry = covers.get(img);
    if (!entry) return;

    entry.observer.disconnect();
    entry.cover.classList.add("sift-cover-out");
    entry.cover.disabled = true;
    const cover = entry.cover;
    window.setTimeout(() => cover.remove(), 190);

    unpositionParent(entry.parent);
    covers.delete(img);
  }

  window.addEventListener(
    "resize",
    () => {
      for (const img of covers.keys()) positionCover(img);
    },
    { passive: true }
  );

  /* ------------------------------------------------------------------ */
  /* blur / reveal                                                       */
  /* ------------------------------------------------------------------ */

  function blurImage(img, verdict) {
    if (img.dataset.siftBlurred === "1") return;

    img.dataset.siftBlurred = "1";
    img.classList.add("sift-blurred");
    img.setAttribute("title", "Sift: this picture may be AI-generated. Click to reveal it.");

    // Capture phase + preventDefault means the first click can never
    // follow a link behind the image.
    img.addEventListener("click", onBlurredClick, true);

    // Keyboard users reach the anchor, not the image. Guard that path too.
    const anchor = img.closest("a");
    if (anchor && anchor.dataset.siftGuard !== "1") {
      anchor.dataset.siftGuard = "1";
      anchor.addEventListener("click", onGuardedAnchor, true);
      anchor.addEventListener("keydown", onGuardedAnchorKey, true);
    }

    addCover(img);
    send({ type: "record", imagesHidden: 1, category: verdict && verdict.category });
  }

  function onBlurredClick(event) {
    const img = event.currentTarget;
    if (img.dataset.siftRevealed === "1") return; // second click: normal behaviour

    event.preventDefault();
    event.stopImmediatePropagation();
    unblur(img);
  }

  function onGuardedAnchor(event) {
    const img = event.currentTarget.querySelector("img.sift-blurred");
    if (!img) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    unblur(img);
  }

  function onGuardedAnchorKey(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    onGuardedAnchor(event);
  }

  function unblur(img) {
    img.classList.remove("sift-blurred");
    img.dataset.siftRevealed = "1";
    img.removeEventListener("click", onBlurredClick, true);
    img.removeAttribute("title");
    removeCover(img);
  }

  /* ------------------------------------------------------------------ */
  /* page verdict                                                        */
  /* ------------------------------------------------------------------ */

  function isContentImage(img) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (img.dataset.siftBlurred === "1") return false;
    if (img.dataset.siftRevealed === "1") return false;

    const rect = img.getBoundingClientRect();
    const attrW = Number(img.getAttribute("width")) || 0;
    const attrH = Number(img.getAttribute("height")) || 0;

    const width = Math.max(img.naturalWidth || 0, rect.width || 0, attrW);
    const height = Math.max(img.naturalHeight || 0, rect.height || 0, attrH);

    // An image that has not decoded yet (loading="lazy" below the fold)
    // reports naturalWidth 0 and a height of about 1px. It still has a
    // real layout width, so judge it on width alone.
    if (img.naturalWidth === 0) return width >= BLUR_MIN_EDGE;

    return width >= BLUR_MIN_EDGE && height >= BLUR_MIN_EDGE;
  }

  function blurAll(verdict) {
    let count = 0;

    for (const img of document.querySelectorAll("img")) {
      if (count >= MAX_BLUR_IMAGES) break;
      if (!isContentImage(img)) continue;
      blurImage(img, verdict);
      count += 1;
    }
  }

  /* ------------------------------------------------------------------ */
  /* per-image vision                                                    */
  /* ------------------------------------------------------------------ */

  /*
   * Article pages are judged once, as a whole, by page-scorer.js. Running
   * vision on every image there would double the network work and fight
   * the page verdict, so vision only runs on non-article pages.
   */
  function isArticlePage() {
    const article = document.querySelector("article");
    if (article && (article.innerText || "").trim().length >= 350) return true;

    const main = document.querySelector("main");
    if (!main || main.querySelectorAll("p").length < 3) return false;
    return (main.innerText || "").trim().length >= 350;
  }

  function isScorableImage(img) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (scored.has(img)) return false;
    if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") return false;
    if (img.naturalWidth === 0) return false;

    const rect = img.getBoundingClientRect();
    const width = Math.max(img.naturalWidth, rect.width || 0);
    const height = Math.max(img.naturalHeight, rect.height || 0);
    if (width < SCORE_MIN_WIDTH || height < SCORE_MIN_HEIGHT) return false;

    const src = img.currentSrc || img.src || "";
    if (!/^https?:/.test(src)) return false;
    if (/\.svg(\?|$)/i.test(src)) return false;

    return true;
  }

  function observe(img) {
    if (!enabled || flagged || articleMode) return;
    if (!(img instanceof HTMLImageElement)) return;
    if (scored.has(img)) return;
    if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") return;

    io.observe(img);
  }

  function enqueue(img) {
    if (!enabled || flagged || articleMode) return;
    if (!(img instanceof HTMLImageElement)) return;
    if (scored.has(img)) return;
    if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") return;

    if (img.naturalWidth === 0) {
      img.addEventListener("load", () => enqueue(img), { once: true });
      return;
    }

    if (!isScorableImage(img)) return;
    if (scoreCalls >= MAX_SCORE_CALLS) return;

    scored.add(img);
    scoreCalls += 1;
    pending.push({
      img,
      src: img.currentSrc || img.src || "",
      alt: img.alt || ""
    });

    if (pending.length >= BATCH_SIZE) flushBatch();
    else scheduleBatch();
  }

  function scheduleBatch() {
    if (batchTimer) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flushBatch();
    }, BATCH_DELAY_MS);
  }

  async function flushBatch() {
    if (flushing) return;
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    if (!pending.length || !enabled || flagged) return;

    const chunk = pending.splice(0, BATCH_SIZE);
    flushing = true;

    try {
      const reply = await send({
        type: "scoreImages",
        items: chunk.map(({ src, alt }) => ({ src, alt }))
      });

      const results = reply && Array.isArray(reply.results) ? reply.results : [];
      const bySrc = new Map();
      for (const result of results) {
        if (result && result.src) bySrc.set(result.src, result);
      }

      for (const item of chunk) {
        const verdict = bySrc.get(item.src);
        if (!verdict || !verdict.blur || flagged) continue;
        if (item.img.dataset.siftBlurred === "1" || item.img.dataset.siftRevealed === "1") continue;
        blurImage(item.img, verdict);
      }
    } finally {
      flushing = false;
      if (pending.length && !flagged) scheduleBatch();
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        enqueue(entry.target);
      }
    },
    { rootMargin: "0px", threshold: 0.01 }
  );

  /* ------------------------------------------------------------------ */
  /* observation                                                         */
  /* ------------------------------------------------------------------ */

  function scan(root) {
    if (!enabled || articleMode) return;
    const scope = root && root.querySelectorAll ? root : document;
    for (const img of scope.querySelectorAll("img")) observe(img);
  }

  function watchDom() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;

          if (node.tagName === "IMG") {
            if (flagged) {
              if (isContentImage(node)) blurImage(node, lastVerdict);
            } else {
              observe(node);
            }
            continue;
          }

          if (!node.querySelectorAll) continue;
          for (const img of node.querySelectorAll("img")) {
            if (flagged) {
              if (isContentImage(img)) blurImage(img, lastVerdict);
            } else {
              observe(img);
            }
          }
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ */
  /* verdict                                                             */
  /* ------------------------------------------------------------------ */

  document.addEventListener("sift:verdict", (event) => {
    if (!enabled) return;

    const verdict = event.detail;
    if (!verdict || !verdict.blur) return;

    flagged = true;
    lastVerdict = verdict;
    pending.length = 0;
    blurAll(verdict);
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    // Read settings directly. This avoids waking the service worker just to
    // ask whether Sift is on.
    let stored = {};
    try {
      stored = await chrome.storage.local.get(["enabled", "blurImages"]);
    } catch {
      stored = {};
    }

    enabled = stored.enabled !== false && stored.blurImages !== false;
    if (!enabled) return;

    articleMode = isArticlePage();
    if (!articleMode) scan(document);
    watchDom();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled || changes.blurImages) location.reload();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
