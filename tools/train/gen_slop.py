"""
Sift Sprout — stage 1: generate the slop class with the teacher (Gemini).

Writes data/slop.jsonl, one {"text": ...} per line. Resumable: restart and
it continues from where it stopped.
"""

import json
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "data", "slop.jsonl")
TARGET = int(os.environ.get("SLOP_TARGET", "1350"))          # articles to generate
PER_CALL = 3
RPM = float(os.environ.get("GEMINI_RPM", "14"))              # stay under the free tier
WORKERS = 3


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
if not API_KEY or API_KEY.startswith("[SENSITIVE]"):
    sys.exit("no usable GEMINI_API_KEY in tools/train/.env.training")

ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"

# ---------------------------------------------------------------- rate limiter

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

# ---------------------------------------------------------------- prompts

# Each entry: (persona/venue, angle). The generator writes advertorial and
# fabricated-news prose for that angle.
ANGLES = [
    ("a retirement-finance advertorial", "a retired couple earning thousands a month from a secret home method"),
    ("a health-blog advertorial", "a miracle supplement doctors supposedly refuse to endorse"),
    ("a crypto-advice advertorial", "a small deposit that turns into life-changing wealth in weeks"),
    ("a consumer-gadget advertorial", "a pocket device that slashes the electricity bill"),
    ("a local-interest news piece", "a small-town grandmother whose photo went viral for an unlikely reason"),
    ("a celebrity-adjacent news piece", "an A-list star's dramatic breakdown behind the scenes"),
    ("a wellness-trend piece", "the one diet trick celebrities are hiding from fans"),
    ("an investment-advice piece", "the under-the-radar stock every retiree is buying"),
    ("an energy-freedom piece", "off-grid power that embarrasses the utility companies"),
    ("a home-remedy piece", "a kitchen ingredient that erases joint pain in days"),
    ("a finance-scam advertorial", "trading software that guarantees profits while you sleep"),
    ("a relationship-advice piece", "the text message that makes anyone chase you"),
    ("a weight-loss advertorial", "a tropical loophole that melts fat without exercise"),
    ("an anti-aging piece", "the skincare ritual that erased twenty years in a month"),
    ("a conspiracy-adjacent news piece", "what the government does not want you to know about your water"),
    ("a get-rich-in-real-estate piece", "buying property with no money down and no credit"),
    ("a tech-scare news piece", "why your phone camera is quietly recording more than you think"),
    ("a pet-care advertorial", "the vet-approved trick that stops bad behaviour overnight"),
    ("a resume/income piece", "the AI side hustle that replaced a full salary in ninety days"),
    ("a survival-prep news piece", "the one item every household needs before the next blackout"),
    ("a 'miracle discovery' news piece", "researchers stunned by a simple compound found in every supermarket"),
    ("a 'doctors hate this' advertorial", "a retired physician exposing the industry's best-kept secret"),
    ("a savings-app advertorial", "one app that wipes thousands off annual bills automatically"),
    ("a travel-hack piece", "the booking mistake that triples flight prices"),
    ("a luxury-lifestyle piece", "how ordinary people afford yachts through one overlooked loophole"),
    ("a fear-appeal news piece", "bank officials rush to warn customers about this quiet account drain"),
]

TEMPLATE = (
    "You are generating a dataset of typical low-quality AI-generated web content for a "
    "research project that teaches a classifier to recognise it. Write {per_call} distinct "
    "articles in the style of: {persona}. Angle: {angle}.\n\n"
    "Requirements for each article:\n"
    "- 180 to 450 words, plain HTML-free prose paragraphs\n"
    "- typical slop register: hype, vague experts, second-hand anecdotes, urgency, a call to action\n"
    "- each article a different wording and angle; do not reuse phrases across articles\n"
    "- no headings, no markdown, no bullet lists, no links\n\n"
    "Return JSON only: {{\"articles\": [\"...\", \"...\", \"...\"]}}"
)

SCHEMA = {
    "type": "object",
    "properties": {
        "articles": {
            "type": "array",
            "items": {"type": "string"},
        }
    },
    "required": ["articles"],
}


def generate(call_index):
    persona, angle = random.choice(ANGLES)
    body = {
        "contents": [{"role": "user", "parts": [{"text": TEMPLATE.format(per_call=PER_CALL, persona=persona, angle=angle)}]}],
        "generationConfig": {
            "temperature": 1.0,
            "responseMimeType": "application/json",
            "responseSchema": SCHEMA,
        },
    }

    for attempt in range(6):
        LIMITER.wait()
        try:
            res = requests.post(ENDPOINT, json=body, timeout=90)
        except requests.RequestException:
            time.sleep(2 ** attempt)
            continue

        if res.status_code == 429 or res.status_code >= 500:
            time.sleep(min(2 ** attempt * 4, 60))
            continue
        if not res.ok:
            return None, f"HTTP {res.status_code}: {res.text[:120]}"

        try:
            raw = res.json()["candidates"][0]["content"]["parts"][0]["text"]
            articles = json.loads(raw)["articles"]
        except (KeyError, IndexError, json.JSONDecodeError):
            time.sleep(2)
            continue

        texts = [str(a).strip() for a in articles if isinstance(a, str) and len(str(a).strip()) >= 350]
        return texts, None

    return None, "retries exhausted"


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    done = 0
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            done = sum(1 for _ in f)
    remaining_target = TARGET - done
    if remaining_target <= 0:
        print(f"already have {done} articles; nothing to do")
        return

    calls_needed = (remaining_target + PER_CALL - 1) // PER_CALL
    print(f"have {done}, generating {remaining_target} more across {calls_needed} calls ({MODEL})")

    out_lock = threading.Lock()
    errors = []

    with open(OUT, "a", encoding="utf-8") as sink, ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(generate, i) for i in range(calls_needed)]
        for i, future in enumerate(futures):
            texts, err = future.result()
            if err:
                errors.append(err)
                print(f"call {i + 1}/{calls_needed}: FAILED ({err})")
                continue
            with out_lock:
                for text in texts:
                    sink.write(json.dumps({"text": text}) + "\n")
                sink.flush()
            total = done + (i + 1) * PER_CALL
            print(f"call {i + 1}/{calls_needed}: +{len(texts)} articles (approx total {min(total, TARGET)})")

    with open(OUT, encoding="utf-8") as f:
        n = sum(1 for _ in f)
    print(f"DONE: {n} articles in data/slop.jsonl; {len(errors)} failed calls")
    if n < TARGET:
        print("run this script again to top up")


if __name__ == "__main__":
    main()
