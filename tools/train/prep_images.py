"""
Sift Bloom — stage 1: build the image dataset.

Primary source (both classes, labeled, balanced, MIT):
  Parveshiiii/AI-vs-Real  — binary_label 0 = AI-generated, 1 = real

Top-up for the real class (natural photographs, parquet-native):
  ethz/food101, tanganke/stanford_cars, nelorth/oxford-flowers

Images are center-cropped to a square and saved as JPEG under
data/images/real and data/images/synthetic, resized to 192px. Nothing is
resampled from one class into the other.

Usage: python prep_images.py [n_per_class]
"""

import io
import os
import sys

N = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
SIDE = 192

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_REAL = os.path.join(ROOT, "data", "images", "real")
OUT_SYN = os.path.join(ROOT, "data", "images", "synthetic")
os.makedirs(OUT_REAL, exist_ok=True)
os.makedirs(OUT_SYN, exist_ok=True)

# Parveshiiii/AI-vs-Real labels: 0 = AI-generated, 1 = real
AI_LABEL = 0
REAL_LABEL = 1


def count(folder):
    return len([f for f in os.listdir(folder) if f.endswith(".jpg")])


def save(pil_image, folder, index):
    from PIL import Image

    img = pil_image.convert("RGB")
    w, h = img.size
    side = min(w, h)
    left, top = (w - side) // 2, (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    img = img.resize((SIDE, SIDE), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    with open(os.path.join(folder, f"{index:05d}.jpg"), "wb") as f:
        f.write(buf.getvalue())


def stream_ai_vs_real(n_ai, n_real):
    """Primary source: Parveshiiii/AI-vs-Real, both classes."""
    from datasets import load_dataset

    need_ai = n_ai - count(OUT_SYN)
    need_real = n_real - count(OUT_REAL)
    if need_ai <= 0 and need_real <= 0:
        print(f"AI-vs-Real: already have ai={count(OUT_SYN)}, real={count(OUT_REAL)}")
        return
    print(f"AI-vs-Real: need ai +{max(0, need_ai)}, real +{max(0, need_real)}")

    got_ai = got_real = 0
    seen = 0
    ai_done = need_ai <= 0
    real_done = need_real <= 0
    stream = load_dataset("Parveshiiii/AI-vs-Real", split="train", streaming=True)
    for row in stream:
        seen += 1
        if ai_done and real_done:
            break
        label = row.get("binary_label")
        img = row.get("image")
        if img is None:
            continue
        try:
            if label == AI_LABEL and not ai_done:
                save(img, OUT_SYN, count(OUT_SYN))
                got_ai += 1
                if got_ai >= need_ai:
                    ai_done = True
            elif label == REAL_LABEL and not real_done:
                save(img, OUT_REAL, count(OUT_REAL))
                got_real += 1
                if got_real >= need_real:
                    real_done = True
        except Exception:
            continue
        total = got_ai + got_real
        if total % 100 == 0 and total > 0:
            print(f"  ai-vs-real: +ai {got_ai}/{max(0, need_ai)}, +real {got_real}/{max(0, need_real)} (scanned {seen})")
    print(f"  ai-vs-real: scanned {seen} rows -> +ai {got_ai}, +real {got_real}")


def stream_natural():
    """Top up the real class from natural-photo datasets."""
    from datasets import load_dataset

    for name in ["ethz/food101", "tanganke/stanford_cars", "nelorth/oxford-flowers"]:
        start = count(OUT_REAL)
        need = N - start
        if need <= 0:
            return
        try:
            print(f"streaming natural photos from {name} (+{need}) ...")
            stream = load_dataset(name, split="train", streaming=True)
            got = 0
            for row in stream:
                img = row.get("image")
                if img is None:
                    continue
                try:
                    save(img, OUT_REAL, count(OUT_REAL))
                except Exception:
                    continue
                got += 1
                if count(OUT_REAL) % 100 == 0:
                    print(f"  real: {count(OUT_REAL)}")
                if got >= need:
                    break
        except Exception as e:
            print(f"  {name} failed: {e}")
    print(f"  -> {count(OUT_REAL)} real photos")


if __name__ == "__main__":
    print(f"target {N} per class at {SIDE}px")
    stream_ai_vs_real(N, N)
    stream_natural()
    stream_ai_vs_real(N, N)  # top up if any class fell short
    print(f"DONE: real {count(OUT_REAL)} | synthetic {count(OUT_SYN)}")
