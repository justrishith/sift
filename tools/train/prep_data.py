"""
Sift Sprout — stage 2: build the dataset.

Editorial class: real journalism streamed from Hugging Face (XSum first,
CNN/DailyMail as fallback), cleaned to the same 350-4000 char window the
extension actually sends.
Slop class: teacher-generated advertorial / fake-news prose from stage 1.

Writes data/train.jsonl and data/val.jsonl with {"text", "label"}
(1 = slop / synthetic, 0 = editorial).
"""

import json
import os
import random
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")

N_REAL = int(os.environ.get("REAL_TARGET", "1800"))
N_PER_CLASS_VAL = 120   # per class held out for validation
MIN_CHARS = 350
MAX_CHARS = 4000
SEED = 7


def clean(text):
    text = re.sub(r"\s+", " ", str(text)).strip()
    # cnn_dailymail highlight boilerplate
    text = text.split("@ highlight")[0]
    text = re.sub(r"\s+", " ", text).strip()
    return text


def window(text):
    """Same window the extension uses, with head+tail keep so the lede and
    the call-to-action tail both survive."""
    if len(text) > MAX_CHARS:
        text = text[:2600] + " ... " + text[-MAX_CHARS + 2600 + 5:]
    return text


def load_real_pool():
    from datasets import load_dataset

    for name, kwargs, field in [
        ("EdinburghNLP/xsum", {}, "document"),
        ("abisee/cnn_dailymail", {"name": "3.0.0"}, "article"),
    ]:
        try:
            print(f"streaming real news from {name} ...")
            pool = []
            stream = load_dataset(name, split="train", streaming=True, **kwargs)
            for row in stream:
                text = clean(row.get(field) or "")
                if MIN_CHARS <= len(text) <= MAX_CHARS * 1.6:
                    pool.append(window(text))
                if len(pool) >= N_REAL:
                    break
            if len(pool) >= N_REAL * 0.8:
                print(f"  -> {len(pool)} real articles from {name}")
                return pool
            print(f"  -> only {len(pool)}, falling back")
        except Exception as e:
            print(f"  {name} failed: {e}")
    raise SystemExit("no real-news source available")


def load_slop_pool():
    path = os.path.join(DATA, "slop.jsonl")
    if not os.path.exists(path):
        raise SystemExit("data/slop.jsonl missing — run gen_slop.py first")
    pool = []
    seen = set()
    for line in open(path, encoding="utf-8"):
        text = clean(json.loads(line)["text"])
        if not (MIN_CHARS <= len(text) <= MAX_CHARS):
            continue
        key = text[:120]
        if key in seen:
            continue
        seen.add(key)
        pool.append(window(text))
    print(f"-> {len(pool)} slop articles after cleaning/dedup")
    return pool


def main():
    random.seed(SEED)
    real = load_real_pool()
    slop = load_slop_pool()
    random.shuffle(real)
    random.shuffle(slop)

    n_val = min(N_PER_CLASS_VAL, len(real) // 5, len(slop) // 5)
    val = [(t, 0) for t in real[:n_val]] + [(t, 1) for t in slop[:n_val]]
    train = [(t, 0) for t in real[n_val:]] + [(t, 1) for t in slop[n_val:]]
    random.shuffle(val)
    random.shuffle(train)

    for name, rows in [("train.jsonl", train), ("val.jsonl", val)]:
        with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
            for text, label in rows:
                f.write(json.dumps({"text": text, "label": label}) + "\n")
        counts = {}
        for _, label in rows:
            counts[label] = counts.get(label, 0) + 1
        print(f"{name}: {len(rows)} rows {counts}")


if __name__ == "__main__":
    main()
