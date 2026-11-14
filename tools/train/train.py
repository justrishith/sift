"""
Sift Sprout — stage 4: train, evaluate, export ONNX.

Produces:
  artifacts/sprout_int8.onnx   the shipped model (dynamic int8 quantized)
  artifacts/tokenizer/         the tokenizer to ship alongside it
  artifacts/metrics.json       honest numbers for the model card
"""

import json
import os
import statistics
import time

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
ART = os.path.join(ROOT, "artifacts")
os.makedirs(ART, exist_ok=True)
os.makedirs(os.path.join(ART, "tokenizer"), exist_ok=True)

MODEL_ID = os.environ.get("SPROUT_BASE", "google/bert_uncased_L-2_H-128_A-2")
MAX_LEN = 288
EPOCHS = int(os.environ.get("EPOCHS", "3"))
BATCH = 16
LR = 3e-4
SEED = 7

# ---------------------------------------------------------------- data


def head_tail(text, head=2300, tail=700):
    text = text.strip()
    if len(text) <= head + tail + 8:
        return text
    return text[:head] + " ... " + text[-tail:]


def load(split):
    rows = [json.loads(line) for line in open(os.path.join(DATA, split), encoding="utf-8")]
    texts = [head_tail(r["text"]) for r in rows]
    labels = np.array([int(r["label"]) for r in rows])
    return texts, labels


train_texts, train_labels = load("train.jsonl")
val_texts, val_labels = load("val.jsonl")
print(f"train {len(train_texts)} | val {len(val_texts)}")

# ---------------------------------------------------------------- baseline: TF-IDF + logreg

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
from sklearn.pipeline import make_pipeline

def metrics(y_true, y_pred):
    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
    }

baseline = make_pipeline(
    TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=2, max_features=60000),
    LogisticRegression(max_iter=2000, C=4.0),
)
baseline.fit(train_texts, train_labels)
base_metrics = metrics(val_labels, baseline.predict(val_texts))
print("TF-IDF+logreg baseline:", json.dumps(base_metrics))

# ---------------------------------------------------------------- tiny transformer

import torch
from torch.utils.data import DataLoader, TensorDataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer

torch.manual_seed(SEED)
torch.set_num_threads(max(1, os.cpu_count() - 1))

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID, num_labels=2)


def encode(texts):
    enc = tokenizer(texts, truncation=True, max_length=MAX_LEN, padding="max_length", return_tensors="pt")
    return enc["input_ids"], enc["attention_mask"]


def to_loader(texts, labels, shuffle):
    ids, mask = encode(texts)
    ds = TensorDataset(ids, mask, torch.tensor(labels, dtype=torch.long))
    return DataLoader(ds, batch_size=BATCH, shuffle=shuffle)


train_loader = to_loader(train_texts, train_labels, True)
val_loader = to_loader(val_texts, val_labels, False)


def evaluate_torch():
    model.eval()
    correct, total = 0, 0
    preds = []
    with torch.no_grad():
        for ids, mask, labels in val_loader:
            logits = model(input_ids=ids, attention_mask=mask).logits
            batch_preds = logits.argmax(dim=-1)
            preds.extend(batch_preds.tolist())
            correct += int((batch_preds == labels).sum())
            total += labels.size(0)
    return metrics(val_labels, np.array(preds))


optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.01)
total_steps = len(train_loader) * EPOCHS
warmup = max(1, int(0.1 * total_steps))
scheduler = torch.optim.lr_scheduler.LambdaLR(
    optimizer, lambda step: step / warmup if step < warmup else max(0.0, 1.0 - (step - warmup) / max(1, total_steps - warmup))
)

model.train()
step = 0
t0 = time.time()
for epoch in range(EPOCHS):
    running = 0.0
    for ids, mask, labels in train_loader:
        optimizer.zero_grad()
        loss = model(input_ids=ids, attention_mask=mask, labels=labels).loss
        loss.backward()
        optimizer.step()
        scheduler.step()
        running += float(loss)
        step += 1
    m = evaluate_torch()
    print(f"epoch {epoch + 1}/{EPOCHS} loss {running / max(1, len(train_loader)):.4f} "
          f"acc {m['accuracy']:.3f} f1 {m['f1']:.3f}  ({time.time() - t0:.0f}s)")

print("training done in", round(time.time() - t0), "s")

# ---------------------------------------------------------------- export ONNX

ONNX_PATH = os.path.join(ART, "sprout.onnx")
model.eval()
dummy = tokenizer("Sift Sprout export check.", return_tensors="pt", max_length=MAX_LEN, padding="max_length")
torch.onnx.export(
    model,
    (dummy["input_ids"], dummy["attention_mask"]),
    ONNX_PATH,
    input_names=["input_ids", "attention_mask"],
    output_names=["logits"],
    dynamic_axes={
        "input_ids": {0: "batch", 1: "seq"},
        "attention_mask": {0: "batch", 1: "seq"},
        "logits": {0: "batch"},
    },
    opset_version=14,
)
print("exported", ONNX_PATH, round(os.path.getsize(ONNX_PATH) / 1e6, 1), "MB")

tokenizer.save_pretrained(os.path.join(ART, "tokenizer"))

# ---------------------------------------------------------------- quantize + verify

from onnxruntime.quantization import QuantType, quantize_dynamic

INT8_PATH = os.path.join(ART, "sprout_int8.onnx")
quantize_dynamic(ONNX_PATH, INT8_PATH, weight_type=QuantType.QInt8)
os.remove(ONNX_PATH)
print("quantized", INT8_PATH, round(os.path.getsize(INT8_PATH) / 1e6, 1), "MB")

import onnxruntime as ort

so = ort.SessionOptions()
so.intra_op_num_threads = 2
session = ort.InferenceSession(INT8_PATH, so, providers=["CPUExecutionProvider"])


def ort_predict(texts):
    ids, mask = encode(texts)
    logits, = session.run(None, {"input_ids": ids.numpy().astype(np.int64), "attention_mask": mask.numpy().astype(np.int64)})
    return logits.argmax(axis=-1)


ort_metrics = metrics(val_labels, ort_predict(val_texts))
print("int8 onnx val:", json.dumps(ort_metrics))

# latency: batch 1, realistic article length
sample = [head_tail(t) for t in val_texts[:20]]
lat = []
for text in sample:
    ids, mask = encode([text])
    start = time.perf_counter()
    session.run(None, {"input_ids": ids.numpy().astype(np.int64), "attention_mask": mask.numpy().astype(np.int64)})
    lat.append((time.perf_counter() - start) * 1000)

metrics_json = {
    "base_model": MODEL_ID,
    "max_len": MAX_LEN,
    "epochs": EPOCHS,
    "train_rows": len(train_texts),
    "val_rows": len(val_texts),
    "baseline_tfidf": base_metrics,
    "student_int8": ort_metrics,
    "latency_ms_median": float(statistics.median(lat)),
    "latency_ms_p90": float(np.percentile(lat, 90)),
    "model_size_mb": round(os.path.getsize(INT8_PATH) / 1e6, 2),
}
with open(os.path.join(ART, "metrics.json"), "w", encoding="utf-8") as f:
    json.dump(metrics_json, f, indent=2)
print(json.dumps(metrics_json, indent=2))
