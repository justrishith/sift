/*
 * Sift — Bloom scorer (content-script side)
 * -----------------------------------------
 * Talks to content/bloom-worker.js to score images on-device. This is a
 * plain content script (NOT an ES module — Chrome content scripts cannot
 * statically import) that exposes window.SiftBloom. image-shield.js calls
 * window.SiftBloom.scoreImage(img) for every image, with no cap.
 *
 * Images are read two ways, in order:
 *   1. createImageBitmap(img) directly — free, but cross-origin images
 *      without CORS headers throw SecurityError in the page context.
 *   2. The extension's service worker (host_permissions <all_urls>) fetches
 *      the bytes with extension privileges — this works for every http(s)
 *      image on the page, including CDN thumbnails.
 *
 * scoreImage(img) -> Promise<{ok:true, ai, confidence, blur} | {ok:false, error}>
 *
 * Failures are sticky: once Bloom is known broken (model download failed,
 * ORN died), every later call short-circuits to {ok:false} so the shield
 * falls back to the remote Gemini API without hammering the worker.
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

  function base64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || "image/jpeg" });
  }

  /* Every image on the page must be readable. Direct bitmap first; the
   * service worker's privileged fetch is the fallback for cross-origin. */
  async function bitmapFor(img) {
    try {
      return await createImageBitmap(img);
    } catch {
      /* cross-origin without CORS — the service worker can still read it */
    }

    const src = img.currentSrc || img.src || "";
    if (!/^https?:/.test(src)) return null;

    const reply = await send({ type: "fetchImage", src });
    if (reply && reply.ok && reply.data) {
      try {
        return await createImageBitmap(base64ToBlob(reply.data, reply.mime));
      } catch {
        return null;
      }
    }
    return null;
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
        const bitmap = await bitmapFor(img);
        if (!bitmap) return { ok: false, error: "undecodable" };
        const id = nextId += 1;
        return await new Promise((resolve) => {
          pending.set(id, resolve);
          w.postMessage({ type: "score", id, bitmap }, [bitmap]);
        });
      } finally {
        releaseSlot();
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  window.SiftBloom = { scoreImage };
})();
