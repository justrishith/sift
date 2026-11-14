"""
Sift Bloom — stage 1: build the image dataset.

Sources (all parquet-native on the Hub, verified streaming):
  real      -> Hemg/AI-Generated-vs-Real-Images-Datasets rows labelled RealArt,
               topped up with natural photographs (ethz/food101,
               tanganke/stanford_cars, nelorth/oxford-flowers)
  synthetic -> the same Hemg dataset's rows labelled AiArt

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

# Hemg labels: 0 = AiArt, 1 = RealArt
AI_LABEL = 0
REAL_LABEL = 1
# Fraction of the real class taken from Hemg's RealArt; the rest comes from
# natural-photo datasets so the model sees more than one real domain.
HEMG_REAL_SHARE = 0.5


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


def stream_hemg(n_ai, n_real):
    """Both classes from the labeled real-vs-AI dataset."""
    from datasets import load_dataset

    need_ai = n_ai - count(OUT_SYN)
    need_real = n_real - count(OUT_REAL)
    if need_ai <= 0 and need_real <= 0:
        print(f"Hemg: already have ai={count(OUT_SYN)}, real={count(OUT_REAL)}")
        return
    print(f"Hemg: need ai +{max(0, need_ai)}, real +{max(0, need_real)}")

    got_ai = got_real = 0
    seen = 0
    stream = load_dataset("Hemg/AI-Generated-vs-Real-Images-Datasets", split="train", streaming=True)
    for row in stream:
        seen += 1
        label = row.get("label")
        img = row.get("image")
        if img is None:
            continue
        try:
            if label == AI_LABEL and got_ai < need_ai:
                save(img, OUT_SYN, count(OUT_SYN))
                got_ai += 1
            elif label == REAL_LABEL and got_real < need_real:
                save(img, OUT_REAL, count(OUT_REAL))
                got_real += 1
        except Exception:
            continue
        if (got_ai + got_real) % 100 == 0 and (got_ai + got_real) > 0:
            print(f"  hemg: +ai {got_ai}/{max(0, need_ai)}, +real {got_real}/{max(0, need_real)}")
        if got_ai >= need_ai and got_real >= need_real:
            break
    print(f"  hemg: scanned {seen} rows -> +ai {got_ai}, +real {got_real}")


def stream_natural():
    """Top up the real class from natural-photo datasets."""
    from datasets import load_dataset

    target_total = N
    for name in ["ethz/food101", "tanganke/stanford_cars", "nelorth/oxford-flowers"]:
        start = count(OUT_REAL)
        need = target_total - start
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
    n_hemg_real = int(N * HEMG_REAL_SHARE)
    stream_hemg(N, n_hemg_real)
    stream_natural()
    stream_hemg(N, n_hemg_real)  # top up real if natural sources fell short
    print(f"DONE: real {count(OUT_REAL)} | synthetic {count(OUT_SYN)}")
