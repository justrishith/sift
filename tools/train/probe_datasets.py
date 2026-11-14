"""Probe v2, with Pillow installed. Prints features + first row's fields."""
from datasets import load_dataset

CANDIDATES = [
    ("ethz/food101", None, "image"),
    ("tanganke/stanford_cars", None, "image"),
    ("nelorth/oxford-flowers", None, "image"),
    ("Hemg/AI-Generated-vs-Real-Images-Datasets", None, None),
    ("Shanmuk4622/ai-image-detection-dataset", None, None),
    ("Tigger-jpeg/ai-generated-images-classifier", None, None),
    ("Hemg/cifake-real-and-ai-generated-synthetic-images", None, None),
]

def probe(name, config, field):
    try:
        if config:
            ds = load_dataset(name, config, split="train", streaming=True)
        else:
            ds = load_dataset(name, split="train", streaming=True)
        it = iter(ds)
        row = next(it)
        print(f"OK   {name}/{config or '-'}")
        print(f"     features: {list(row.keys())}")
        for k, v in row.items():
            desc = f"size={v.size}" if hasattr(v, "size") else repr(v)[:60]
            print(f"     {k}: {type(v).__name__} {desc}")
    except Exception as e:
        print(f"FAIL {name}/{config or '-'}  {type(e).__name__}: {str(e)[:120]}")

for c in CANDIDATES:
    probe(*c)
    print()
