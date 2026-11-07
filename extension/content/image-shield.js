/*
 * Sift — image shield
 * -------------------
 * When the page is flagged, every content image is blurred in place and the
 * reader gets one plain control: "N pictures hidden — Show them".
 *
 * Design rules:
 *   - blur, never remove, so the layout never collapses
 *   - a blurred image cannot navigate anywhere on the first click
 *   - one tap reveals, a second tap behaves normally
 *   - lazy images below the fold are blurred too; they are never skipped
 *     just because they have not decoded yet
 */

(() => {
  "use strict";

  const MIN_EDGE = 120;   // skip icons, avatars, sprites
  const MAX_IMAGES = 120; // hard cap for infinite feeds

  const blurred = new Set();

  let enabled = true;
  let flagged = false;
  let revealedAll = false;
  let hiddenCount = 0;
  let lastVerdict = null;
  let pill = null;

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

    if (blurred.delete(img) && !revealedAll) {
      hiddenCount = Math.max(0, hiddenCount - 1);
      updatePill();
    }
  }

  /* ------------------------------------------------------------------ */
  /* candidate selection                                                 */
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
    // real layout width, so judge it on width alone. Once it loads, the
    // blur class is already applied.
    if (img.naturalWidth === 0) return width >= MIN_EDGE;

    return width >= MIN_EDGE && height >= MIN_EDGE;
  }

  function blurAll(verdict) {
    let count = 0;

    for (const img of document.querySelectorAll("img")) {
      if (count >= MAX_IMAGES) break;
      if (!isContentImage(img)) continue;
      blurImage(img, verdict);
      count += 1;
    }
  }

  /* Images added after the verdict (infinite scroll, lazy sections). */
  function watchDom() {
    const observer = new MutationObserver((mutations) => {
      if (!flagged) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;

          if (node.tagName === "IMG") {
            if (isContentImage(node)) blurImage(node, lastVerdict);
            continue;
          }

          if (!node.querySelectorAll) continue;
          for (const img of node.querySelectorAll("img")) {
            if (isContentImage(img)) blurImage(img, lastVerdict);
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
