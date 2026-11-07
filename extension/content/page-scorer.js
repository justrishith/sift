/*
 * Sift - page scorer
 * ------------------
 * One Gemini call per article, not one per image. If the article is
 * classified as AI slop, every content image on the page is blurred.
 *
 * Degrades safely: if the proxy is down, nothing is blurred.
 */
(() => {
  "use strict";

  const MIN_TEXT = 350;
  const MAX_TEXT = 4000;

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

  function extract() {
    const node =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body;
    const text = (node.innerText || "").replace(/\s+/g, " ").trim();
    return text.slice(0, MAX_TEXT);
  }

  function forceDemo() {
    if (!location.hash.includes("sift-demo")) return false;
    document.dispatchEvent(
      new CustomEvent("sift:verdict", {
        detail: { ok: true, blur: true, category: "synthetic", confidence: "high", reasons: ["demo mode"] }
      })
    );
    return true;
  }

  async function run() {
    if (!/^https?:/.test(location.protocol)) return;
    if (forceDemo()) return;

    const text = extract();
    if (text.length < MIN_TEXT) return;

    const verdict = await send({
      type: "scorePage",
      title: document.title,
      text,
      url: location.href
    });

    if (!verdict || !verdict.ok || !verdict.blur) {
      console.info("[Sift] page clear", verdict && verdict.error ? verdict.error : "");
      return;
    }

    console.info("[Sift] page flagged", verdict.category, verdict.slop);
    document.dispatchEvent(new CustomEvent("sift:verdict", { detail: verdict }));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(run, 400), { once: true });
  } else {
    setTimeout(run, 400);
  }
})();
