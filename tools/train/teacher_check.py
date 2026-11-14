"""
Sift Sprout — stage 3: teacher agreement check.

Runs the *production* prompt (verbatim from api/score-page.js) over a
stratified sample of the validation set and measures how well the teacher
(Gemini) agrees with the constructed labels. This is the quality gate: if
the teacher disagrees with the data, the data — not the eventual student —
is wrong.

Usage: python teacher_check.py [n_per_class]
"""

import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")

N_PER_CLASS = int(sys.argv[1]) if len(sys.argv) > 1 else 100
RPM = float(os.environ.get("GEMINI_RPM", "14"))


def load_env():
    env_file = os.path.join(ROOT, ".env.training")
    if os.path.exists(env_file):
        for line in open(env_file, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())


load_env()
API_KEY = os.environ.get("GEMINI_API_KEY")
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash-lite"
ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"

# ---- production prompt, verbatim from api/score-page.js -------------------

PROMPT = """You classify news article text for a tool that protects older readers from AI-generated slop.

Decide whether this reads like:
- "synthetic": fabricated article or AI-generated content posing as reporting
- "content_farm": mass-produced, low-quality, machine-written content
- "editorial": genuine journalism, even if opinionated or low quality

Be conservative. Only use "synthetic" or "content_farm" with strong evidence.
Never label a real news article as synthetic without clear signs.

Return JSON only."""

SCHEMA = {
    "type": "object",
    "properties": {
        "slop": {"type": "number", "description": "0 to 1"},
        "category": {"type": "string", "enum": ["synthetic", "content_farm", "editorial"]},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["slop", "category", "confidence"],
}

TITLE = "News article"


class Limiter:
    def __init__(self, rpm):
        self.min_interval = 60.0 / rpm
        self.lock = threading.Lock()
        self.next_ok = 0.0

    def wait(self):
        while True:
            with self.lock:
                now = time.time()
                if now >= self.next_ok:
                    self.next_ok = now + self.min_interval
                    return
                delay = self.next_ok - now
            time.sleep(min(delay, 2.0))


LIMITER = Limiter(RPM)


def teacher_label(text):
    body = {
        "contents": [{"role": "user", "parts": [{"text": f"{PROMPT}\n\nTITLE: {TITLE}\n\nARTICLE:\n{text[:4000]}"}]}],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
            "responseSchema": SCHEMA,
        },
    }
    for attempt in range(5):
        LIMITER.wait()
        try:
            res = requests.post(ENDPOINT, json=body, timeout=90)
        except requests.RequestException:
            time.sleep(2 ** attempt)
            continue
        if res.status_code == 429 or res.status_code >= 500:
            time.sleep(min(2 ** attempt * 4, 45))
            continue
        if not res.ok:
            return None
        try:
            return json.loads(res.json()["candidates"][0]["content"]["parts"][0]["text"])
        except (KeyError, IndexError, json.JSONDecodeError):
            return None
    return None


def main():
    rows = [json.loads(line) for line in open(os.path.join(DATA, "val.jsonl"), encoding="utf-8")]
    by_label = {0: [], 1: []}
    for row in rows:
        by_label[row["label"]].append(row["text"])

    sample = by_label[0][:N_PER_CLASS] + by_label[1][:N_PER_CLASS]
    truth = [0] * min(N_PER_CLASS, len(by_label[0])) + [1] * min(N_PER_CLASS, len(by_label[1]))
    print(f"teacher check on {len(sample)} val samples ({MODEL})")

    results = [None] * len(sample)
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(teacher_label, text) for text in sample]
        for i, future in enumerate(futures):
            results[i] = future.result()
            if (i + 1) % 25 == 0:
                print(f"  {i + 1}/{len(sample)} labelled")

    # category -> binary: synthetic/content_farm = 1, editorial = 0
    confusion = {(0, 0): 0, (0, 1): 0, (1, 0): 0, (1, 1): 0}
    fails = 0
    for truth_label, result in zip(truth, results):
        if not result:
            fails += 1
            continue
        pred = 0 if result.get("category") == "editorial" else 1
        confusion[(truth_label, pred)] += 1

    total = sum(confusion.values())
    agree = confusion[(0, 0)] + confusion[(1, 1)]
    print("\n--- teacher agreement ---")
    print(f"scored: {total}, failed calls: {fails}")
    print(f"agreement: {agree / max(total, 1):.1%}")
    print(f"real (label 0): kept editorial {confusion[(0, 0)]}, flagged slop {confusion[(0, 1)]}")
    print(f"slop (label 1): flagged {confusion[(1, 1)]}, kept editorial {confusion[(1, 0)]}")

    with open(os.path.join(DATA, "teacher_check.json"), "w", encoding="utf-8") as f:
        json.dump({"model": MODEL, "n": total, "fails": fails, "agreement": agree / max(total, 1), "confusion": {f"{t}->{p}": c for (t, p), c in confusion.items()}}, f, indent=2)


if __name__ == "__main__":
    main()
