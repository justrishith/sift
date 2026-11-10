/*
 * Sift — image shield
 * -------------------
 * Three ways an image gets blocked:
 *   1. the page is judged AI slop  -> every content image gets a cover
 *   2. one image matches a known-generator heuristic -> covered instantly
 *   3. one image is judged AI by vision -> that image gets a cover
 *
 * Blocked images get a soft lilac cover with a flower, a "blocked by sift"
 * badge, and a "tap to peek" hint. Clicking a cover reveals that one picture.
 * A first click can never follow the link behind the image.
 *
 * There is no glimpse: images near the viewport get a neutral "sift is
 * checking" cover before their verdict arrives, and images further out are
 * scored silently one to two viewports ahead. Vision now runs on every page
 * (article pages included); a whole-page verdict still overrides.
 *
 * Sift fails open: no verdict means no blur.
 */

(() => {
  "use strict";

  const BLUR_MIN_EDGE = 120;    // page verdict: skip icons, avatars, sprites
  const SCORE_MIN_WIDTH = 128;  // per-image vision: covers grid thumbnails
  const SCORE_MIN_HEIGHT = 96;
  const MAX_BLUR_IMAGES = 120;
  const MAX_SCORE_CALLS = 36;   // images scored per page; keeps the free tier sane
  const BATCH_SIZE = 6;
  const BATCH_DELAY_MS = 60;
  const PREFETCH_MARGIN = "1000px 0px 1000px 0px"; // score 1-2 viewports early
  const MAX_CHECKING = 24;      // checking covers on screen at once

  /*
   * Instant local pre-blocks. A high-precision hit covers the image with
   * zero network latency; the vision call is skipped entirely.
   */
  const GENERATOR_HOSTS = /(openai|midjourney|dall[-_]?e|stability|ideogram|leonardo|thispersondoesnotexist|thiscatdoesnotexist|thisponydoesnotexist|generated\.photos|deepai|nightcafe|craiyon|flux1|stablediffusion)/i;
  const AI_ALT = /\b(ai[- ]?generated|midjourney|dall[- ]?e|stable diffusion|generated (with|by|using) ai|ai art)\b/i;
  const GENERATOR_DIMS = new Set([
    "1024x1024", "1024x1792", "1792x1024", "768x768", "512x512",
    "896x1152", "1152x896", "1216x832", "832x1216", "1024x576", "576x1024"
  ]);

  function localVerdict(img) {
    const src = img.currentSrc || img.src || "";
    if (GENERATOR_HOSTS.test(src)) return { ai: 1, confidence: "high", local: "host" };

    if (AI_ALT.test(img.alt || "")) return { ai: 1, confidence: "high", local: "alt" };

    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    if (w >= 512 && GENERATOR_DIMS.has(`${w}x${h}`)) {
      return { ai: 0.9, confidence: "medium", local: "dims" };
    }

    return null;
  }

  const covers = new Map();
  const positionedParents = new Map();
  const scored = new WeakSet();
  const pending = [];

  let batchTimer = null;
  let flushing = false;
  let scoreCalls = 0;
  let enabled = true;
  let flagged = false;
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

  function checkingCount() {
    let n = 0;
    for (const entry of covers.values()) {
      if (entry.checking) n += 1;
    }
    return n;
  }

  /*
   * Capture-phase blockers: while an image is covered or blurred, no
   * pointer event may reach it, its anchor, or site tile handlers that
   * navigate on mousedown/mouseup (image grids do this).
   */
  const POINTER_EVENTS = ["mousedown", "mouseup", "pointerdown", "pointerup", "touchend"];

  function blockPointer(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function addCover(img, checking = false) {
    const existing = covers.get(img);
    if (existing) {
      if (existing.checking && !checking) upgradeCover(existing);
      return;
    }

    const parent = img.parentElement;
    if (!parent) return;

    const cover = document.createElement("div");
    cover.className = checking ? "sift-cover sift-cover-checking" : "sift-cover";

    const badge = document.createElement("span");
    badge.className = "sift-cover-badge";
    const badgeLabel = document.createElement("span");
    badgeLabel.textContent = checking ? "sift is checking" : "blocked by sift";
    badge.append(flower(), badgeLabel);

    const mark = flower();
    mark.className = "sift-cover-mark";

    const hint = document.createElement("span");
    hint.className = "sift-cover-hint";
    hint.textContent = checking ? "" : "tap to peek";

    cover.append(badge, mark, hint);

    const entry = { cover, parent, observer: null, checking, blocker: null, img };
    covers.set(img, entry);

    if (checking) {
      // While checking, no pointer event may reach the image or its link.
      entry.blocker = blockPointer;
      for (const type of POINTER_EVENTS) cover.addEventListener(type, blockPointer, true);
    } else {
      armReveal(img, entry);
      for (const type of POINTER_EVENTS) cover.addEventListener(type, blockPointer, true);
    }

    const observer = new ResizeObserver(() => positionCover(img));
    observer.observe(img);
    entry.observer = observer;

    positionParent(parent);
    parent.appendChild(cover);
    positionCover(img);
  }

  function armReveal(img, entry) {
    const { cover } = entry;

    const reveal = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      unblur(img);
    };

    entry.reveal = reveal;
    cover.setAttribute("role", "button");
    cover.tabIndex = 0;
    cover.setAttribute("aria-label", "Blocked by Sift. Activate to reveal this picture.");
    cover.addEventListener("click", reveal, true);
    cover.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" || event.key === " ") reveal(event);
      },
      true
    );
  }

  function upgradeCover(entry) {
    entry.checking = false;
    const { cover } = entry;

    cover.classList.remove("sift-cover-checking");
    for (const type of POINTER_EVENTS) cover.removeEventListener(type, blockPointer, true);

    cover.querySelector(".sift-cover-badge span:last-child").textContent = "blocked by sift";
    cover.querySelector(".sift-cover-hint").textContent = "tap to peek";
    armReveal(entry.img, entry);
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
    for (const type of POINTER_EVENTS) img.addEventListener(type, blockPointer, true);

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
    for (const type of POINTER_EVENTS) img.removeEventListener(type, blockPointer, true);
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
    if (!enabled || flagged) return;
    if (!(img instanceof HTMLImageElement)) return;
    if (scored.has(img)) return;
    if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") return;

    io.observe(img);
  }

  function enqueue(img, inView = true) {
    if (!enabled || flagged) return;
    if (!(img instanceof HTMLImageElement)) return;
    if (scored.has(img)) return;
    if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") return;

    if (img.naturalWidth === 0) {
      img.addEventListener("load", () => enqueue(img, inView), { once: true });
      return;
    }

    // Instant local pre-block: known generators and AI alt text never
    // need the network.
    const local = localVerdict(img);
    if (local) {
      scored.add(img);
      blurImage(img, local);
      return;
    }

    if (!isScorableImage(img)) return;
    if (scoreCalls >= MAX_SCORE_CALLS) return;

    scored.add(img);
    scoreCalls += 1;

    // Cover what the reader can already see, then resolve it from the
    // batched verdict. Images further out are scored silently so the
    // verdict is ready before they scroll in.
    if (inView && checkingCount() < MAX_CHECKING) addCover(img, true);

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
        const entry = covers.get(item.img);

        if (flagged) continue; // blurAll already handled every image

        if (!verdict || verdict.ok === false) {
          // Fail open, and do not leave the reader staring at a spinner.
          if (entry && entry.checking) removeCover(item.img);
          continue;
        }

        if (verdict.blur) {
          blurImage(item.img, verdict);
        } else if (entry && entry.checking) {
          removeCover(item.img);
        }
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

        const img = entry.target;
        if (scored.has(img)) continue;
        if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") continue;

        // The observer fires one to two viewports early (prefetch margin).
        // What the reader can already see gets a checking cover; the rest
        // is scored silently so a verdict is waiting before it scrolls in.
        const rect = img.getBoundingClientRect();
        const inView =
          rect.top < window.innerHeight + 100 &&
          rect.bottom > -100 &&
          rect.left < window.innerWidth + 100 &&
          rect.right > -100;

        enqueue(img, inView);
      }
    },
    { rootMargin: PREFETCH_MARGIN, threshold: 0.01 }
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
    pending.length = 0;
    blurAll(verdict);
  });

  /* ------------------------------------------------------------------ */
  /* the gate                                                            */
  /* ------------------------------------------------------------------ */

  /*
   * Runs at document_start on window capture, before the site's own
   * handlers exist. Some sites (Bing Images) open a detail pane from a
   * document-level capture handler, which no listener on the cover itself
   * can stop. Registered first, this gate intercepts every pointer event
   * aimed at a covered or blurred image before the page can act on it.
   */
  let gateArmed = false;

  function gate(event) {
    if (covers.size === 0) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const coverHit = target.closest(".sift-cover");
    if (coverHit) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "click") {
        for (const [img, entry] of covers) {
          if (entry.cover === coverHit) {
            if (!entry.checking) unblur(img);
            break;
          }
        }
      }
      return;
    }

    if (target instanceof HTMLImageElement && target.dataset.siftBlurred === "1") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "click") unblur(target);
    }
  }

  function armGate() {
    if (gateArmed) return;
    gateArmed = true;
    for (const type of [...POINTER_EVENTS, "click"]) {
      window.addEventListener(type, gate, true);
    }
  }

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

    scan(document);
    watchDom();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled || changes.blurImages) location.reload();
  });

  // The gate must exist before the page's own scripts register theirs.
  armGate();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
