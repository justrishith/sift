"""Evaluate the pretrained SMOGY detector on our Parveshiiii val split."""
import io
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data", "images")

from huggingface_hub import hf_hub_download
model_path = hf_hub_download(
    repo_id="onnx-community/SMOGY-Ai-images-detector-ONNX",
    filename="onnx/model_quantized.onnx",
)
print("model:", model_path, round(os.path.getsize(model_path) / 1e6, 1), "MB")

# val split identical to train_images.py
import torch
from torchvision import datasets
from torch.utils.data import random_split
torch.manual_seed(7)
base = datasets.ImageFolder(DATA)
synthetic_idx = base.class_to_idx["synthetic"]
base.targets = [1 if t == synthetic_idx else 0 for t in base.targets]
n_val = max(64, int(len(base) * 0.12))
_, val_subset = random_split(base, [len(base) - n_val, n_val], generator=torch.Generator().manual_seed(7))
val_paths = [base.samples[i][0] for i in val_subset.indices]
val_trues = np.array([base.targets[i] for i in val_subset.indices])

# SMOGY preprocessing: resize 224 bicubic, /255, ImageNet normalize
mean = np.array([0.485, 0.456, 0.406], np.float32)
std = np.array([0.229, 0.224, 0.225], np.float32)

def preprocess(p):
    img = Image.open(p).convert("RGB").resize((224, 224), Image.BICUBIC)
    arr = np.asarray(img, np.float32) / 255.0
    arr = (arr - mean) / std
    return arr.transpose(2, 0, 1)[None].astype(np.float32)

import onnxruntime as ort
so = ort.SessionOptions()
so.intra_op_num_threads = 4
sess = ort.InferenceSession(model_path, so, providers=["CPUExecutionProvider"])
input_name = sess.get_inputs()[0].name
print("input:", input_name, sess.get_inputs()[0].shape, "outputs:", [o.name for o in sess.get_outputs()])

scores = []
for p in val_paths:
    logits, = sess.run(None, {input_name: preprocess(p)})
    z = logits[0].astype(np.float64)
    e = np.exp(z - z.max())
    soft = e / e.sum()
    scores.append(float(soft[0]))  # class 0 = artificial
scores = np.array(scores)

# threshold 0.5 (same rule as the extension: aiScore >= 0.5)
preds = (scores >= 0.5).astype(int)
acc = float((preds == val_trues).mean())
tp = int(((preds == 1) & (val_trues == 1)).sum())
fp = int(((preds == 1) & (val_trues == 0)).sum())
tn = int(((preds == 0) & (val_trues == 0)).sum())
fn = int(((preds == 0) & (val_trues == 1)).sum())
prec = tp / max(1, tp + fp)
rec = tp / max(1, tp + fn)
print(f"SMOGY on our val split: acc={acc:.3f}  precision={prec:.3f}  recall={rec:.3f}")
print(f"  TP={tp} FP={fp} TN={tn} FN={fn}  (n={len(val_paths)})")
print(f"  mean score artificial: real={scores[val_trues==0].mean():.3f}, ai={scores[val_trues==1].mean():.3f}")

# latency
import time
lat = []
for p in val_paths[:20]:
    x = preprocess(p)
    start = time.perf_counter()
    sess.run(None, {input_name: x})
    lat.append((time.perf_counter() - start) * 1000)
print(f"  latency median={np.median(lat):.0f}ms p90={np.percentile(lat, 90):.0f}ms (4 threads, CPU)")

import json
with open(os.path.join(ROOT, "data", "smogy_eval.json"), "w") as f:
    json.dump({
        "model": "onnx-community/SMOGY-Ai-images-detector-ONNX (model_quantized/q8)",
        "n": len(val_paths),
        "accuracy": acc, "precision": float(prec), "recall": float(rec),
        "tp": tp, "fp": fp, "tn": tn, "fn": fn,
        "latency_ms_median": float(np.median(lat)),
        "latency_ms_p90": float(np.percentile(lat, 90)),
    }, f, indent=2)
