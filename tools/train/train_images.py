"""
Sift Bloom — stage 3: train the local image classifier, export ONNX.

Real photos (label 0) vs diffusion-generated images (label 1). Transfer
learning from MobileNetV3-Small so a CPU can finish today.

Produces:
  artifacts/bloom_int8.onnx    the shipped model (dynamic int8 quantized)
  artifacts/bloom_meta.json    input size, labels, metrics
  artifacts/metrics_bloom.json honest numbers for the model card
"""

import json
import os
import random
import statistics
import time

import numpy as np
import torch
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset, random_split
from torchvision import datasets, models, transforms

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data", "images")
ART = os.path.join(ROOT, "artifacts")
os.makedirs(ART, exist_ok=True)

SIDE = int(os.environ.get("SIDE", "192"))
BATCH = int(os.environ.get("BATCH", "32"))
EPOCHS = int(os.environ.get("EPOCHS", "4"))
VAL_FRACTION = 0.12
SEED = 7

random.seed(SEED)
torch.manual_seed(SEED)
torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))

# ---------------------------------------------------------------- data

train_tf = transforms.Compose([
    transforms.RandomResizedCrop(SIDE, scale=(0.7, 1.0), ratio=(0.85, 1.15)),
    transforms.RandomHorizontalFlip(),
    transforms.ColorJitter(0.25, 0.25, 0.2, 0.05),
    transforms.RandomGrayscale(p=0.05),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])
eval_tf = transforms.Compose([
    transforms.Resize((SIDE, SIDE)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])

# ImageFolder over data/images/{real,synthetic}; map labels so synthetic = 1.
base = datasets.ImageFolder(DATA)
assert set(base.class_to_idx) == {"real", "synthetic"}, base.class_to_idx
synthetic_idx = base.class_to_idx["synthetic"]
base.targets = [1 if t == synthetic_idx else 0 for t in base.targets]

n_val = max(64, int(len(base) * VAL_FRACTION))
n_train = len(base) - n_val
train_subset, val_subset = random_split(
    base, [n_train, n_val], generator=torch.Generator().manual_seed(SEED)
)
val_paths = [base.samples[i][0] for i in val_subset.indices]
val_trues = np.array([base.targets[i] for i in val_subset.indices])


class BloomTrain(Dataset):
    """Training slice with augmentation, applied to raw files."""

    def __init__(self, subset, transform):
        self.subset = subset
        self.transform = transform

    def __len__(self):
        return len(self.subset)

    def __getitem__(self, idx):
        path = self.subset.dataset.samples[self.subset.indices[idx]][0]
        label = self.subset.dataset.targets[self.subset.indices[idx]]
        raw = Image.open(path).convert("RGB")
        return self.transform(raw), label


class BloomVal(Dataset):
    def __init__(self, subset, transform):
        self.subset = subset
        self.transform = transform

    def __len__(self):
        return len(self.subset)

    def __getitem__(self, idx):
        path = self.subset.dataset.samples[self.subset.indices[idx]][0]
        label = self.subset.dataset.targets[self.subset.indices[idx]]
        raw = Image.open(path).convert("RGB")
        return self.transform(raw), label


train_loader = DataLoader(BloomTrain(train_subset, train_tf), batch_size=BATCH, shuffle=True, num_workers=0)
val_loader = DataLoader(BloomVal(val_subset, eval_tf), batch_size=BATCH, shuffle=False, num_workers=0)

print(f"images: {len(base)} | train {len(train_subset)} | val {len(val_subset)}")

# ---------------------------------------------------------------- model

model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
model.classifier[3] = nn.Linear(model.classifier[3].in_features, 2)

optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=0.01)
steps_total = len(train_loader) * EPOCHS
warmup = max(1, int(0.08 * steps_total))
scheduler = torch.optim.lr_scheduler.LambdaLR(
    optimizer,
    lambda s: s / warmup if s < warmup else max(0.05, 1.0 - (s - warmup) / max(1, steps_total - warmup)),
)
criterion = nn.CrossEntropyLoss()


def metrics(y_true, y_pred):
    from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score

    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
    }


def eval_val():
    model.eval()
    preds, trues = [], []
    with torch.no_grad():
        for images, labels in val_loader:
            logits = model(images)
            preds.extend(logits.argmax(dim=-1).tolist())
            trues.extend(labels.tolist())
    return metrics(np.array(trues), np.array(preds))


t0 = time.time()
for epoch in range(EPOCHS):
    model.train()
    running = 0.0
    for images, labels in train_loader:
        optimizer.zero_grad()
        loss = criterion(model(images), labels)
        loss.backward()
        optimizer.step()
        scheduler.step()
        running += float(loss)
    m = eval_val()
    print(f"epoch {epoch + 1}/{EPOCHS} loss {running / max(1, len(train_loader)):.4f} "
          f"acc {m['accuracy']:.3f} f1 {m['f1']:.3f}  ({time.time() - t0:.0f}s)")

print("training done in", round(time.time() - t0), "s")

# ---------------------------------------------------------------- export ONNX

onnx_path = os.path.join(ART, "bloom.onnx")
model.eval()
dummy = torch.randn(1, 3, SIDE, SIDE)
torch.onnx.export(
    model,
    dummy,
    onnx_path,
    input_names=["pixels"],
    output_names=["logits"],
    dynamic_axes={"pixels": {0: "batch"}, "logits": {0: "batch"}},
    opset_version=14,
)
print("exported", onnx_path, round(os.path.getsize(onnx_path) / 1e6, 2), "MB")

# ---------------------------------------------------------------- quantize + verify

from onnxruntime.quantization import QuantType, quantize_dynamic

int8_path = os.path.join(ART, "bloom_int8.onnx")
quantize_dynamic(onnx_path, int8_path, weight_type=QuantType.QInt8)
os.remove(onnx_path)
print("quantized", int8_path, round(os.path.getsize(int8_path) / 1e6, 2), "MB")

import onnxruntime as ort

so = ort.SessionOptions()
so.intra_op_num_threads = 2
session = ort.InferenceSession(int8_path, so, providers=["CPUExecutionProvider"])

mean = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 3, 1, 1)
std = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 3, 1, 1)


def ort_predict_paths(paths):
    preds = []
    for path in paths:
        img = Image.open(path).convert("RGB")
        side = min(img.size)
        left, top = (img.size[0] - side) // 2, (img.size[1] - side) // 2
        img = img.crop((left, top, left + side, top + side)).resize((SIDE, SIDE), Image.LANCZOS)
        arr = (np.asarray(img, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None]
        arr = (arr - mean) / std
        logits, = session.run(None, {"pixels": arr})
        preds.append(int(logits.argmax(axis=-1)[0]))
    return np.array(preds)


ort_metrics = metrics(val_trues, ort_predict_paths(val_paths))
print("int8 onnx val:", json.dumps(ort_metrics))

lat = []
for path in val_paths[:20]:
    start = time.perf_counter()
    ort_predict_paths([path])
    lat.append((time.perf_counter() - start) * 1000)

report = {
    "backbone": "mobilenet_v3_small (ImageNet1K_V1 transfer)",
    "input_side": SIDE,
    "epochs": EPOCHS,
    "train_images": len(train_subset),
    "val_images": len(val_paths),
    "classes": {"real": 0, "synthetic": 1},
    "student_int8": ort_metrics,
    "latency_ms_median": float(statistics.median(lat)),
    "latency_ms_p90": float(np.percentile(lat, 90)),
    "model_size_mb": round(os.path.getsize(int8_path) / 1e6, 2),
}
with open(os.path.join(ART, "metrics_bloom.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, indent=2)
with open(os.path.join(ART, "bloom_meta.json"), "w", encoding="utf-8") as f:
    json.dump({"side": SIDE, "classes": ["real", "synthetic"], "normalization": "imagenet"}, f, indent=2)
print(json.dumps(report, indent=2))
