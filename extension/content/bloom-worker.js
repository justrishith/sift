/*
 * Sift — Bloom worker
 * -------------------
 * Runs the Sift Bloom ONNX model on-device via ONNX Runtime Web, inside a
 * Web Worker so image scoring never blocks the page's main thread.
 *
 *   - Imports onnxruntime-web from a bundled local copy (no CDN — Chrome's
 *     extension CSP refuses remote scripts in the worker)
 *   - Downloads bloom.onnx from sift-steel.vercel.app on first use
 *   - Caches the model in IndexedDB so subsequent loads are instant
 *   - Falls back to null on any failure (caller falls back to remote API)
 *
 * The content script passes every URL in the "init" message, so the worker
 * itself needs no chrome.* APIs.
 *
 * Input tensor name: "pixels" [1, 3, 192, 192], ImageNet normalization.
 * Output: "logits" [2] -> softmax -> P(synthetic) = class 1 = ai.
 */

const DB_NAME = "sift-bloom";
const DB_STORE = "models";
const MODEL_KEY = "bloom-onnx";
const INPUT_SIDE = 192;
const MEAN = new Float32Array([0.485, 0.456, 0.406]);
const STD = new Float32Array([0.229, 0.224, 0.225]);

let ort = null;
let session = null;
let initPromise = null;
let db = null;
let modelUrl = "";
let ortUrl = "";
let wasmBase = "";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE);
    };
  });
}

async function getModelBuffer() {
  if (!db) db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(MODEL_KEY);
    req.onsuccess = () => resolve(req.result ? req.result.buffer : null);
    req.onerror = () => reject(req.error);
  });
}

async function putModelBuffer(buffer) {
  if (!db) db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.put(new Uint8Array(buffer), MODEL_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function init(ortUrl_, wasmBase_, modelUrl_) {
  if (initPromise) return initPromise;
  ortUrl = ortUrl_;
  wasmBase = wasmBase_;
  modelUrl = modelUrl_;
  initPromise = (async () => {
    await importScripts(ortUrl);
    ort = self.ort;
    // Pages are not crossOriginIsolated, so SharedArrayBuffer threading is
    // off the table. Single-threaded SIMD is fast enough (~30 ms).
    ort.env.wasm.wasmPaths = wasmBase;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;

    let buffer = await getModelBuffer();
    if (!buffer) {
      const res = await fetch(modelUrl);
      if (!res.ok) throw new Error(`model ${res.status}`);
      buffer = await res.arrayBuffer();
      await putModelBuffer(buffer);
    }
    session = await ort.InferenceSession.create(buffer);
  })();
  return initPromise;
}

function preprocessFromBitmap(bitmap) {
  const w = bitmap.width;
  const h = bitmap.height;
  const side = Math.min(w, h);
  const left = (w - side) / 2;
  const top = (h - side) / 2;

  const canvas = new OffscreenCanvas(INPUT_SIDE, INPUT_SIDE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, left, top, side, side, 0, 0, INPUT_SIDE, INPUT_SIDE);
  const data = ctx.getImageData(0, 0, INPUT_SIDE, INPUT_SIDE).data;

  const plane = INPUT_SIDE * INPUT_SIDE;
  const tensor = new Float32Array(1 * 3 * plane);
  let idx = 0;
  for (let y = 0; y < INPUT_SIDE; y += 1) {
    for (let x = 0; x < INPUT_SIDE; x += 1) {
      const offset = (y * INPUT_SIDE + x) * 4;
      tensor[idx] = (data[offset] / 255 - MEAN[0]) / STD[0];
      tensor[idx + plane] = (data[offset + 1] / 255 - MEAN[1]) / STD[1];
      tensor[idx + 2 * plane] = (data[offset + 2] / 255 - MEAN[2]) / STD[2];
      idx += 1;
    }
  }
  return new ort.Tensor("float32", tensor, [1, 3, INPUT_SIDE, INPUT_SIDE]);
}

function confidenceFromAi(ai) {
  const margin = Math.abs(ai - 0.5) * 2;
  if (margin >= 0.7) return "high";
  if (margin >= 0.4) return "medium";
  return "low";
}

function shouldBlur(ai, confidence) {
  return (ai >= 0.7 && confidence !== "low") || ai >= 0.85;
}

self.onmessage = async (e) => {
  const { type, id } = e.data || {};
  if (type === "init") {
    try {
      await init(e.data.ortUrl, e.data.wasmBase, e.data.modelUrl);
      self.postMessage({ type: "ready", ok: true });
    } catch (err) {
      self.postMessage({ type: "ready", ok: false, error: String(err) });
    }
    return;
  }
  if (type === "score") {
    try {
      await init(ortUrl, wasmBase, modelUrl);
      const bitmap = await createImageBitmap(e.data.bitmap);
      const tensor = preprocessFromBitmap(bitmap);
      bitmap.close();
      const results = await session.run({ pixels: tensor });
      const logits = results.logits.data;
      const m = Math.max(logits[0], logits[1]);
      const e0 = Math.exp(logits[0] - m);
      const e1 = Math.exp(logits[1] - m);
      const ai = e1 / (e0 + e1); // P(class 1 = synthetic)
      const confidence = confidenceFromAi(ai);
      self.postMessage({
        type: "result",
        id,
        ok: true,
        ai,
        confidence,
        blur: shouldBlur(ai, confidence)
      });
    } catch (err) {
      self.postMessage({ type: "result", id, ok: false, error: String(err) });
    }
  }
};
