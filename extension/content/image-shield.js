/*
 * DeepSafe - image shield
 * -----------------------
 * The visible product: when an image is judged to be AI-generated, it is
 * blurred in place and the user gets ONE plain control to reveal it.
 *
 * Why blur instead of remove:
 *   - the page layout never collapses
 *   - the decision is reversible (one tap)
 *   - it reads as "something is hidden from you", not "the site is broken"
 *
 * Cost control: only images that are (a) large enough to matter and
 * (b) actually near the viewport are ever sent for a verdict.
 */
(() => {
  "use strict";

  const MIN_EDGE = 120;          // ignore icons, sprites, avatars
  const MAX_PER_PAGE = 80;       // hard cap, protects against infinite feeds
  const processed = new WeakSet();
  const blurred = new Set();

  let revealedAll = false;
  let hiddenCount = 0;
  let sentCount = 0;
  let enabled = true;

  /* ---------- messaging ---------- */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /* ---------- the pill ---------- */

  let pill = null;

  function ensurePill() {
    if (pill) return pill;
    pill = document.createElement("div");
    pill.className = "ds-pill";
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-live", "polite");

    const label = document.createElement("span");
    label.className = "ds-pill-label";

    const btn = document.createElement("button");
    btn.className = "ds-pill-btn";
    btn.type = "button";
    btn.textContent = "Show them";
    btn.addEventListener("click", revealAll);

    pill.append(label, btn);
    document.documentElement.appendChild(pill);
    return pill;
  }

  function updatePill() {
    if (!pill) return;
    if (hiddenCount === 0 || revealedAll) {
      pill.classList.remove("ds-pill-visible");
      return;
    }
    pill.querySelector(".ds-pill-label").textContent =
      hiddenCount === 1 ? "1 picture hidden" : `${hiddenCount} pictures hidden`;
    pill.classList.add("ds-pill-visible");
  }

  function revealAll() {
    revealedAll = true;
    for (const img of blurred) unblur(img, true);
    updatePill();
    send({ type: "record", imagesRevealed: blurred.size });
  }

  /* ---------- blur / reveal ---------- */

  function blurImage(img, verdict) {
    if (img.dataset.dsBlurred === "1") return;
    img.dataset.dsBlurred = "1";
    img.classList.add("ds-blurred");
    img.setAttribute(
      "title",
      "DeepSafe: this picture may be AI-generated. Tap to see it."
    );

    // Block click-through so a blurred image can never take them to a
    // scam page by accident. First tap reveals, second tap navigates.
    img.addEventListener("click", onBlurredClick, true);

    blurred.add(img);
    hiddenCount++;
    updatePill();

    send({
      type: "record",
      imagesHidden: 1,
      reason: verdict && verdict.reasons ? verdict.reasons[0] : ""
    });
  }

  function onBlurredClick(e) {
    const img = e.currentTarget;
    if (img.dataset.dsRevealed === "1") return; // second tap: let it through
    e.preventDefault();
    e.stopPropagation();
    unblur(img, false);
  }

  function unblur(img, silent) {
    img.classList.remove("ds-blurred");
    img.dataset.dsRevealed = "1";
    img.removeEventListener("click", onBlurredClick, true);
    img.removeAttribute("title");
    blurred.delete(img);
    if (!silent) {
      hiddenCount = Math.max(0, hiddenCount - 1);
      updatePill();
      send({ type: "correction", kind: "image-revealed" });
    }
  }

  /* ---------- candidate selection ---------- */

  function isCandidate(img) {
    if (!img || processed.has(img)) return false;
    if (img.dataset.dsBlurred === "1") return false;
    if (sentCount >= MAX_PER_PAGE) return false;

    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < MIN_EDGE || h < MIN_EDGE) return false;

    const src = img.currentSrc || img.src || "";
    if (!/^https?:/.test(src)) return false;
    if (/\.(svg|gif)(\?|$)/i.test(src)) return false;

    return true;
  }

  async function consider(img) {
    if (!isCandidate(img)) return;
    processed.add(img);
    sentCount++;

    const verdict = await send({
      type: "scoreImage",
      src: img.currentSrc || img.src,
      pageUrl: location.href,
      alt: img.alt || "",
      width: img.naturalWidth,
      height: img.naturalHeight
    });

    if (verdict && verdict.blur) blurImage(img, verdict);
  }

  /* ---------- observation ---------- */

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        consider(entry.target);
      }
    },
    { rootMargin: "300px" } // start a little before they scroll to it
  );

  function observe(img) {
    if (!isCandidate(img)) return;
    io.observe(img);
  }

  function scan(root) {
    if (!enabled) return;
    const scope = root && root.querySelectorAll ? root : document;
    for (const img of scope.querySelectorAll("img")) observe(img);
  }

  function watchDom() {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "IMG") observe(node);
          else if (node.querySelectorAll) scan(node);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------- page verdict: blur everything ---------- */

  function blurAll(verdict) {
    for (const img of document.querySelectorAll("img")) {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < MIN_EDGE || h < MIN_EDGE) continue;
      if (img.dataset.dsRevealed === "1") continue;
      if (img.dataset.dsBlurred === "1") continue;
      processed.add(img);
      blurImage(img, verdict);
    }
  }

  document.addEventListener("sift:verdict", (e) => {
    if (!enabled) return;
    if (!e.detail || !e.detail.blur) return;
    blurAll(e.detail);
  });

  /* ---------- settings ---------- */

  async function loadSettings() {
    const state = await send({ type: "getState" });
    if (state) enabled = state.enabled && state.blurImages !== false;
    if (enabled) {
      ensurePill();
      scan(document);
      watchDom();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled || changes.blurImages) {
      location.reload(); // simplest correct behaviour; rare event
    }
  });

  /* ---------- boot ---------- */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadSettings, { once: true });
  } else {
    loadSettings();
  }
})();
