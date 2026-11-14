/*
 * Sift — Bloom scorer (content-script side)
 * -----------------------------------------
 * Talks to bloom-worker.js to score images on-device. The worker handles
 * ORN loading + model download + inference. This module queues score
 * requests and maps results back to callers.
 *
 * scoreImage(img) -> Promise<{ok, ai, confidence, blur, source:"bloom"} | {ok:false}>
 */

let worker = null;
let workerReady = null;
let workerFailed = false;
const pendingCallbacks = [];

function createWorker() {
  const url = chrome.runtime.getURL("content/bloom-worker.js");
  const w = new Worker(url);
  workerReady = new Promise((resolve) => {
    w.onmessage = (e) => {
      const { type } = e.data || {};
      if (type === "ready") {
        resolve(e.data);
      } else if (type === "result") {
        const cb = pendingCallbacks.shift();
        if (cb) cb(e.data);
      }
    };
    w.onerror = () => {
      workerFailed = true;
    };
  });
  w.postMessage({ type: "init" });
  return w;
}

function getWorker() {
  if (workerFailed) return null;
  if (!worker) worker = createWorker();
  return worker;
}

async function scoreImage(img) {
  try {
    const w = getWorker();
    if (!w) return { ok: false, error: "worker-disabled" };

    // Ensure worker is initialized (first call downloads + loads the model).
    await workerReady;

    // Cross-origin images without CORS taint the canvas; ImageBitmap from
    // a tainted canvas throws. Catch that and fall back to the remote API.
    const bitmap = await createImageBitmap(img);
    return new Promise((resolve) => {
      pendingCallbacks.push(resolve);
      w.postMessage({ type: "score", bitmap }, [bitmap]);
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

window.SiftBloom = { scoreImage };
