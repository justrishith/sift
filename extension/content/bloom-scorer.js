/*
 * Sift — Bloom scorer (content-script side)
 * -----------------------------------------
 * Talks to content/bloom-worker.js to score images on-device. This is a
 * plain content script (NOT an ES module — Chrome content scripts cannot
 * statically import) that exposes window.SiftBloom. image-shield.js calls
 * window.SiftBloom.scoreImage(img) for every image, with no cap.
 *
 * scoreImage(img) -> Promise<{ok:true, ai, confidence, blur} | {ok:false, error}>
 *
 * Failures are sticky: once Bloom is known broken (CSP, cross-origin image,
 * model fetch failed), every later call short-circuits to {ok:false} so the
 * shield falls back to the remote Gemini API without hammering the worker.
 */

(() => {
  "use strict";

  const MAX_CONCURRENT = 4; // one worker, a few parallel session.run calls max

  let worker = null;
  let workerReadyPromise = null;
  let workerFailed = false;
  let nextId = 1;
  let running = 0;
  const waitQueue = [];
  const pending = new Map(); // id -> resolve

  function createWorker() {
    const url = chrome.runtime.getURL("content/bloom-worker.js");
    const w = new Worker(url);

    workerReadyPromise = new Promise((resolve) => {
      w.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === "ready") {
          resolve(msg);
          return;
        }
        if (msg.type === "result") {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          if (cb) cb(msg);
        }
      };
      w.onerror = () => {
        workerFailed = true;
        for (const cb of pending.values()) cb({ ok: false, error: "worker-error" });
        pending.clear();
      };
    });

    w.postMessage({
      type: "init",
      ortUrl: chrome.runtime.getURL("vendor/onnx/ort.min.js"),
      wasmBase: chrome.runtime.getURL("vendor/onnx/"),
      modelUrl: "https://sift-steel.vercel.app/bloom.onnx"
    });
    return w;
  }

  function getWorker() {
    if (workerFailed) return null;
    if (!worker) worker = createWorker();
    return worker;
  }

  function acquireSlot() {
    if (running < MAX_CONCURRENT) return Promise.resolve();
    return new Promise((resolve) => waitQueue.push(resolve));
  }

  function releaseSlot() {
    running -= 1;
    const next = waitQueue.shift();
    if (next) next();
  }

  async function scoreImage(img) {
    if (workerFailed) return { ok: false, error: "worker-disabled" };

    try {
      if (!img || img.naturalWidth === 0) return { ok: false, error: "not-decoded" };

      const w = getWorker();
      if (!w) return { ok: false, error: "worker-disabled" };

      const ready = await workerReadyPromise;
      if (!ready || ready.ok === false) {
        workerFailed = true;
        return { ok: false, error: (ready && ready.error) || "worker-failed" };
      }

      await acquireSlot();
      try {
        const bitmap = await createImageBitmap(img);
        const id = nextId += 1;
        return await new Promise((resolve) => {
          pending.set(id, resolve);
          w.postMessage({ type: "score", id, bitmap }, [bitmap]);
        });
      } finally {
        releaseSlot();
      }
    } catch (err) {
      // Cross-origin images without CORS taint createImageBitmap; that is
      // a normal case, not a broken Bloom — let the caller fall back.
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  window.SiftBloom = { scoreImage };
})();
