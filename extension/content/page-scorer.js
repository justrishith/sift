/*
 * Sift — page scorer
 * ------------------
 * One Gemini call per article, not one per image.
 *
 * The classifier only runs where there is an actual article: a real <article>
 * element, or a <main> with at least three paragraphs. That keeps YouTube,
 * dashboards and search results out of the cost path.
 *
 * Emits "sift:verdict" on document. The image shield listens and blurs.
 */

(() => {
  "use strict";

  const MIN_TEXT = 350;
  const MAX_TEXT = 4000;
  const MIN_PARAGRAPHS = 3;

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

  /* Only score pages that actually contain an article. */
  function articleNode() {
    const article = document.querySelector("article");
    if (article) return article;

    const main = document.querySelector("main");
    if (!main) return null;
    if (main.querySelectorAll("p").length < MIN_PARAGRAPHS) return null;
    return main;
  }

  function extract(node) {
    return (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  }

  /* #sift-demo forces the blur without a network call. Demo fallback only. */
  function forceDemo() {
    if (!location.hash.includes("sift-demo")) return false;
    document.dispatchEvent(
      new CustomEvent("sift:verdict", {
        detail: {
          ok: true,
          blur: true,
          category: "synthetic",
          confidence: "high",
          reasons: ["demo mode"]
        }
      })
    );
    return true;
  }

  async function run() {
    if (!/^https?:/.test(location.protocol)) return;
    if (forceDemo()) return;

    const node = articleNode();
    if (!node) return;

    const text = extract(node);
    if (text.length < MIN_TEXT) return;

    const verdict = await send({
      type: "scorePage",
      title: document.title,
      text
    });

    if (!verdict || !verdict.ok || !verdict.blur) {
      console.info("[Sift] page clear", verdict && verdict.error ? verdict.error : "");
      return;
    }

    console.info("[Sift] page flagged", verdict.category, verdict.slop);
    document.dispatchEvent(new CustomEvent("sift:verdict", { detail: verdict }));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(run, 100), { once: true });
  } else {
    setTimeout(run, 100);
  }
})();
