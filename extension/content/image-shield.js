/*
 * Sift — image shield
 * -------------------
 * Two ways an image gets blocked:
 *   1. the page is judged AI slop  -> every content image blurs at once
 *   2. one image is judged AI      -> that image blurs on its own
 *
 * Blocked images get a Sift cover: a frosted purple layer, a pulsing flower
 * orb, and a "Blocked by Sift" badge in the corner. Clicking the cover
 * reveals the picture and removes the cover. A first click can never follow
 * the link behind the image.
 */

(() => {
  "use strict";

  const BLUR_MIN_EDGE = 120;    // page verdict: skip icons, avatars, sprites
  const SCORE_MIN_WIDTH = 180;  // per-image vision: thumbnails and up
  const SCORE_MIN_HEIGHT = 120;
  const MAX_BLUR_IMAGES = 120;
  const MAX_SCORE_CALLS = 8;    // per page; keeps the free tier sane
  const MAX_CONCURRENT = 2;

  const blurred = new Set();
  const covers = new Map();
  const positionedParents = new Map();
  const scored = new WeakSet();
  const queue = [];

  let active = 0;
  let scoreCalls = 0;
  let enabled = true;
  let flagged = false;
  let revealedAll = false;
  let hiddenCount = 0;
  let lastVerdict = null;
  let pill = null;
  let iconUrl = "";

  try {
    iconUrl = chrome.runtime.getURL("icons/icon128.png");
  } catch {
    iconUrl = "";
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
  /* pill                                                                */
  /* ------------------------------------------------------------------ */

  function ensurePill() {
    if (pill) return pill;

    pill = document.createElement("div");
    pill.className = "sift-pill";
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-live", "polite");

    const label = document.createElement("span");
    label.className = "sift-pill-label";

    const button = document.createElement("button");
    button.className = "sift-pill-btn";
    button.type = "button";
    button.textContent = "Show them";
    button.addEventListener("click", revealAll);

    pill.append(label, button);
    document.documentElement.appendChild(pill);
    return pill;
  }

  function updatePill() {
    if (!pill) return;

    if (hiddenCount === 0 || revealedAll) {
      pill.classList.remove("sift-pill-visible");
      return;
    }

    pill.querySelector(".sift-pill-label").textContent =
      hiddenCount === 1 ? "1 picture hidden" : `${hiddenCount} pictures hidden`;
    pill.classList.add("sift-pill-visible");
  }

  function revealAll() {
    revealedAll = true;
    hiddenCount = 0;

    for (const img of [...blurred]) unblur(img);

    updatePill();
    send({ type: "record", imagesRevealed: 1 });
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
    badge.className = "sift-badge";
    badge.textContent = "Blocked by Sift";

    const orb = document.createElement("span");
    orb.className = "sift-orb";
    orb.setAttribute("aria-hidden", "true");

    if (iconUrl) {
      const icon = document.createElement("img");
      icon.src = iconUrl;
      icon.alt = "";
      orb.appendChild(icon);
    }

    cover.append(badge, orb);

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
    entry.cover.remove();
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

    blurred.add(img);
    hiddenCount += 1;
    revealedAll = false;

    updatePill();
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

    if (blurred.delete(img) && !revealedAll) {
      hiddenCount = Math.max(0, hiddenCount - 1);
      updatePill();
    }
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
    if (!enabled) return;
    if (!(img instanceof HTMLImageElement)) return;
    if (scored.has(img)) return;
    if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") return;

    io.observe(img);
  }

  function enqueue(img) {
    if (!enabled || flagged) return;
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
    queue.push(img);
    pump();
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const img = queue.shift();
      active += 1;
      scoreOne(img).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  async function scoreOne(img) {
    if (!enabled || flagged) return;

    const src = img.currentSrc || img.src || "";
    if (!src) return;

    const verdict = await send({
      type: "scoreImage",
      src,
      alt: img.alt || "",
      pageUrl: location.href
    });

    if (!verdict || !verdict.blur || flagged) return;
    if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") return;

    blurImage(img, verdict);
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        enqueue(entry.target);
      }
    },
    { rootMargin: "300px" }
  );

  /* ------------------------------------------------------------------ */
  /* observation                                                         */
  /* ------------------------------------------------------------------ */

  function scan(root) {
    if (!enabled) return;
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
    queue.length = 0;
    blurAll(verdict);
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    const state = await send({ type: "getState" });
    if (state) enabled = state.enabled !== false && state.blurImages !== false;
    if (!enabled) return;

    ensurePill();
    scan(document);
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
