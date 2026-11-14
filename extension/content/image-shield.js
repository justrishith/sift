/*
 * Sift — image shield
 * -------------------
 * Every image on the page is covered the moment Sift sees it, with a
 * "sift is checking" cover, then Bloom (on-device, no cap, no budget)
 * resolves it one of two ways:
 *   - real  -> the cover lifts and a green "sift · real" chip stays in
 *              the corner so you know it was checked
 *   - fake  -> the cover stays, blurred, with a "sift · fake" chip
 *
 * Images Bloom cannot read (cross-origin without CORS) fall back to the
 * remote Gemini API batch; the checking cover stays on until the verdict
 * lands. Generator hosts are covered instantly, no scan needed.
 *
 * Sift fails open: no verdict means no blur.
 */

"use strict";

const BLUR_MIN_EDGE = 120;    // page verdict: skip icons, avatars, sprites
const SCAN_MIN_EDGE = 16;     // per-image: only skip invisible tracking pixels
const MAX_BLUR_IMAGES = 120;
const BATCH_SIZE = 6;
const BATCH_DELAY_MS = 120;
const PREFETCH_MARGIN = "1000px 0px 1000px 0px"; // score 1-2 viewports early
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 4000;

// Remote-API budget only (Gemini costs money). Bloom is local and free, so
// it scores every image with no cap.
const PREFETCH_BUDGET = 36;   // remote-API look-ahead per page
const INVIEW_BUDGET = 300;    // remote-API in-view per page

/*
 * Instant local pre-block, narrowed to the one high-precision signal:
 * an image served from a known generator's host. Dimensions and alt
 * text matched too many real photographs, so they are gone.
 */
const GENERATOR_HOSTS = /(openai|midjourney|dall[-_]?e|stability|ideogram|leonardo|thispersondoesnotexist|thiscatdoesnotexist|thisponydoesnotexist|generated\.photos|deepai|nightcafe|craiyon|flux1|stablediffusion)/i;

function localVerdict(img) {
  const src = img.currentSrc || img.src || "";
  if (GENERATOR_HOSTS.test(src)) return { ai: 1, confidence: "high", local: "host" };
  return null;
}

const covers = new Map();          // blurred fake images
const checkingCovers = new Map();  // images Bloom is scoring right now
const verdictBadges = new Map();   // corner labels: "sift · real" / "sift · fake"
const checking = new WeakSet();    // already enqueued, awaiting verdict
const positionedParents = new Map();
const scored = new WeakSet();    // reached a final verdict (or gave up)
const inFlight = new WeakSet();  // waiting on a remote-API batch verdict
const attempts = new WeakMap();  // failed remote-API tries per image
const pending = [];
const retryQueue = [];

let batchTimer = null;
let retryTimer = null;
let flushing = false;
let prefetchBudget = PREFETCH_BUDGET;
let inviewBudget = INVIEW_BUDGET;
let running = false;
let flagged = false;
let lastVerdict = null;
let flowerUrl = "";
let domObserver = null;

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

function addCover(img) {
  const existing = covers.get(img);
  if (existing) return;

  const parent = img.parentElement;
  if (!parent) return;

  const cover = document.createElement("div");
  cover.className = "sift-cover";

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

  const entry = { cover, parent, observer: null, img };
  covers.set(img, entry);

  for (const type of POINTER_EVENTS) cover.addEventListener(type, blockPointer, true);
  armReveal(img, entry);

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

function positionChecking(img) {
  const entry = checkingCovers.get(img);
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

function addCheckingCover(img) {
  if (checkingCovers.has(img)) return;
  const parent = img.parentElement;
  if (!parent) return;

  const cover = document.createElement("div");
  cover.className = "sift-cover sift-cover-checking";
  // Transient and purely visual: the page stays fully usable while Bloom works.
  cover.style.pointerEvents = "none";

  const badge = document.createElement("span");
  badge.className = "sift-cover-badge";
  const badgeLabel = document.createElement("span");
  badgeLabel.textContent = "sift is checking";
  badge.append(flower(), badgeLabel);

  const mark = flower();
  mark.className = "sift-cover-mark";

  cover.append(badge, mark);

  const entry = { cover, parent, observer: null };
  checkingCovers.set(img, entry);

  positionParent(parent);
  parent.appendChild(cover);
  positionChecking(img);

  entry.observer = new ResizeObserver(() => positionChecking(img));
  entry.observer.observe(img);
}

function removeCheckingCover(img) {
  const entry = checkingCovers.get(img);
  if (!entry) return;

  entry.observer.disconnect();
  entry.cover.classList.add("sift-cover-out");
  const cover = entry.cover;
  window.setTimeout(() => cover.remove(), 190);

  unpositionParent(entry.parent);
  checkingCovers.delete(img);
}

function positionVerdict(img) {
  const entry = verdictBadges.get(img);
  if (!entry) return;

  const { el, parent } = entry;
  const rect = img.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();

  el.style.left = `${rect.right - parentRect.left + parent.scrollLeft - 8}px`;
  el.style.top = `${rect.bottom - parentRect.top + parent.scrollTop - 8}px`;
}

function addVerdictBadge(img, kind) {
  removeVerdictBadge(img);
  const parent = img.parentElement;
  if (!parent) return;

  const badge = document.createElement("span");
  badge.className = `sift-verdict sift-verdict-${kind}`;

  // Scale the chip to the picture it sits on — a full-size pill would
  // swallow a 40px avatar.
  const rect = img.getBoundingClientRect();
  if (rect.width < 90 || rect.height < 70) badge.classList.add("sift-verdict-tiny");
  else if (rect.width < 170 || rect.height < 140) badge.classList.add("sift-verdict-small");

  const mark = flower();
  const label = document.createElement("span");
  label.textContent = kind === "real" ? "sift · real" : "sift · fake";
  badge.append(mark, label);

  const entry = { el: badge, parent, observer: null };
  verdictBadges.set(img, entry);

  positionParent(parent);
  parent.appendChild(badge);
  positionVerdict(img);

  entry.observer = new ResizeObserver(() => positionVerdict(img));
  entry.observer.observe(img);
}

function removeVerdictBadge(img) {
  const entry = verdictBadges.get(img);
  if (!entry) return;

  entry.observer.disconnect();
  entry.el.remove();

  unpositionParent(entry.parent);
  verdictBadges.delete(img);
}

function revealReal(img) {
  removeCheckingCover(img);
  img.classList.remove("sift-checking");
  checking.delete(img);
  img.dataset.siftRevealed = "1";
  addVerdictBadge(img, "real");
}

window.addEventListener(
  "resize",
  () => {
    for (const img of covers.keys()) positionCover(img);
    for (const img of checkingCovers.keys()) positionChecking(img);
    for (const img of verdictBadges.keys()) positionVerdict(img);
  },
  { passive: true }
);

/* ------------------------------------------------------------------ */
/* blur / reveal                                                       */
/* ------------------------------------------------------------------ */

function unguardAnchor(img) {
  const anchor = img.closest("a");
  if (anchor && anchor.dataset.siftGuard === "1") {
    anchor.removeEventListener("click", onGuardedAnchor, true);
    anchor.removeEventListener("keydown", onGuardedAnchorKey, true);
    delete anchor.dataset.siftGuard;
  }
}

function blurImage(img, verdict) {
  if (img.dataset.siftBlurred === "1") return;

  removeCheckingCover(img);
  checking.delete(img);
  img.dataset.siftBlurred = "1";
  img.classList.add("sift-blurred");
  img.classList.remove("sift-checking");
  // Per-image AI verdicts get the corner chip. A page-level slop verdict
  // covers every image but isn't per-image proof, so no chip there.
  if (verdict && verdict.ai !== undefined) addVerdictBadge(img, "fake");
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
  img.classList.remove("sift-checking");
  img.dataset.siftRevealed = "1";
  img.removeEventListener("click", onBlurredClick, true);
  for (const type of POINTER_EVENTS) img.removeEventListener(type, blockPointer, true);
  img.removeAttribute("title");
  unguardAnchor(img);
  removeCover(img);
}

/* Full teardown: used when Sift is switched off (or paused for this
 * site) while the page is open. Everything goes back to how it was. */
function teardownImage(img) {
  img.classList.remove("sift-blurred");
  img.classList.remove("sift-checking");
  img.removeEventListener("click", onBlurredClick, true);
  for (const type of POINTER_EVENTS) img.removeEventListener(type, blockPointer, true);
  unguardAnchor(img);
  if (img.dataset.siftBlurred) delete img.dataset.siftBlurred;
  if (img.dataset.siftRevealed) delete img.dataset.siftRevealed;
  img.removeAttribute("title");
  removeCover(img);
  removeCheckingCover(img);
  removeVerdictBadge(img);
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
  // Only skip invisible tracking pixels. Everything else gets covered + checked.
  if (width < SCAN_MIN_EDGE || height < SCAN_MIN_EDGE) return false;

  const src = img.currentSrc || img.src || "";
  // Bloom is local, so any decodable URL works — http(s), blob, data.
  // SVG stays out: Bloom judges photos, not vector art.
  if (!/^(https?|blob|data):/.test(src)) return false;
  if (/\.svg(\?|$)/i.test(src)) return false;

  return true;
}

function observe(img) {
  if (!running || flagged) return;
  if (!(img instanceof HTMLImageElement)) return;
  if (scored.has(img) || inFlight.has(img)) return;
  if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") return;

  io.observe(img);
}

async function enqueue(img, inView = true) {
  if (!running || flagged) return;
  if (!(img instanceof HTMLImageElement)) return;
  if (scored.has(img) || inFlight.has(img) || checking.has(img)) return;
  if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") return;

  if (img.naturalWidth === 0) {
    img.addEventListener("load", () => enqueue(img, inView), { once: true });
    return;
  }

  // Instant local pre-block: a known generator host never needs the
  // network.
  const local = localVerdict(img);
  if (local) {
    scored.add(img);
    blurImage(img, local);
    return;
  }

  if (!isScorableImage(img)) return;

  // Cover the image IMMEDIATELY and run the checking UI. Bloom (local,
  // free, no cap) scores it; the cover resolves when the verdict lands.
  checking.add(img);
  img.classList.add("sift-checking");
  addCheckingCover(img);

  const bloom = window.SiftBloom
    ? await window.SiftBloom.scoreImage(img)
    : { ok: false, error: "bloom-missing" };

  if (bloom.ok) {
    scored.add(img);
    checking.delete(img);
    img.classList.remove("sift-checking");
    removeCheckingCover(img);
    if (bloom.blur) blurImage(img, bloom);
    else revealReal(img);
    return;
  }

  // Bloom unavailable (local model missing / image undecodable) → remote
  // Gemini API fallback. The checking cover stays until the verdict lands.
  // Remote needs an http(s) URL the server can fetch; anything else fails open.
  const remoteSrc = img.currentSrc || img.src || "";
  const remoteable = /^https?:/.test(remoteSrc);
  const budgetGone = !remoteable
    || (inView ? inviewBudget <= 0 : prefetchBudget <= 0);
  if (budgetGone) {
    // Fail open: lift the cover, no badge, image goes back to normal.
    scored.add(img);
    checking.delete(img);
    img.classList.remove("sift-checking");
    removeCheckingCover(img);
    return;
  }
  if (inView) inviewBudget -= 1;
  else prefetchBudget -= 1;

  inFlight.add(img);
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
  if (!pending.length || !running || flagged) return;

  const chunk = pending.splice(0, BATCH_SIZE);
  flushing = true;
  const retries = [];

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
      inFlight.delete(item.img);

      if (flagged) {
        checking.delete(item.img);
        continue; // blurAll already handled every image
      }

      const verdict = bySrc.get(item.src);

      if (!verdict || verdict.ok === false) {
        // Transient failure (service-worker cold start, timeout, 5xx):
        // retry a couple of times with the cover still on, then give up
        // and lift it (fail open).
        const tries = (attempts.get(item.img) || 0) + 1;
        attempts.set(item.img, tries);
        if (tries < MAX_RETRIES) {
          retries.push(item);
          continue;
        }
        scored.add(item.img);
        checking.delete(item.img);
        item.img.classList.remove("sift-checking");
        removeCheckingCover(item.img);
        continue;
      }

      scored.add(item.img);
      checking.delete(item.img);
      if (verdict.blur) blurImage(item.img, verdict);
      else revealReal(item.img);
    }
  } finally {
    flushing = false;

    if (retries.length && running && !flagged) {
      retryQueue.push(...retries);
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!running || flagged || !retryQueue.length) return;
          pending.push(...retryQueue.splice(0));
          if (pending.length >= BATCH_SIZE) flushBatch();
          else scheduleBatch();
        }, RETRY_DELAY_MS);
      }
    }

    if (pending.length && running && !flagged) scheduleBatch();
  }
}

const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.unobserve(entry.target);

      const img = entry.target;
      if (scored.has(img) || inFlight.has(img)) continue;
      if (img.dataset.siftBlurred === "1" || img.dataset.siftRevealed === "1") continue;

      // The observer fires one to two viewports early (prefetch margin).
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
  if (!running) return;
  const scope = root && root.querySelectorAll ? root : document;
  for (const img of scope.querySelectorAll("img")) observe(img);
}

function watchDom() {
  domObserver = new MutationObserver((mutations) => {
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

  domObserver.observe(document.documentElement, { childList: true, subtree: true });
}

/* ------------------------------------------------------------------ */
/* verdict                                                             */
/* ------------------------------------------------------------------ */

document.addEventListener("sift:verdict", (event) => {
  const verdict = event.detail;
  if (!verdict || !verdict.blur) return;
  // A forced demo verdict may start the shield even when it is off.
  if (!running && !verdict.demo) return;

  flagged = true;
  lastVerdict = verdict;
  pending.length = 0;
  retryQueue.length = 0;
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
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
 * It is a no-op while no covers exist, so disabled sites pay nothing.
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
          unblur(img);
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
/* settings: start / stop without reloading the page                   */
/* ------------------------------------------------------------------ */

function siteDisabled(stored) {
  return Array.isArray(stored.disabledSites) && stored.disabledSites.includes(location.origin);
}

function shouldRun(stored) {
  // On by default — the reader turns it off in the popup if they want.
  // A failed storage read must not brick the shield, so the default is
  // "run unless explicitly disabled" rather than "run only if stored true".
  return stored.enabled !== false && stored.blurImages !== false && !siteDisabled(stored);
}

async function applySettings() {
  let stored = {};
  try {
    stored = await chrome.storage.local.get(["enabled", "blurImages", "disabledSites"]);
  } catch {
    stored = {};
  }

  const want = shouldRun(stored);
  if (want && !running) startShield();
  else if (!want && running) stopShield();
}

function startShield() {
  if (running) return;
  running = true;
  scan(document);
  watchDom();
}

function stopShield() {
  if (!running) return;
  running = false;
  flagged = false;
  lastVerdict = null;
  pending.length = 0;
  retryQueue.length = 0;
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
  io.disconnect();
  for (const img of [...covers.keys()]) removeCover(img);
  for (const img of [...checkingCovers.keys()]) removeCheckingCover(img);
  for (const img of [...verdictBadges.keys()]) removeVerdictBadge(img);
  for (const img of document.querySelectorAll("img.sift-blurred")) teardownImage(img);
  for (const img of document.querySelectorAll("img.sift-checking"))
    img.classList.remove("sift-checking");
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled || changes.blurImages || changes.disabledSites) applySettings();
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

// The gate must exist before the page's own scripts register theirs.
armGate();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applySettings, { once: true });
} else {
  applySettings();
}
