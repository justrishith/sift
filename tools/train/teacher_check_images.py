"""
Sift Bloom — stage 2: teacher agreement check on images.

Runs the *production* prompt (verbatim from api/score-image.js, single-image
path) over a sample from both classes and measures teacher agreement with
dataset provenance. Also records the teacher's blur decision, which uses the
same threshold the deployed endpoint applies.

Usage: python teacher_check_images.py [n_per_class]
"""

import base64
import io
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data", "images")

N_PER_CLASS = int(sys.argv[1]) if len(sys.argv) > 1 else 60
RPM = float(os.environ.get("GEMINI_RPM", "14"))


def load_env():
    """Read .env.training; Vercel's env pull writes "[SENSITIVE]" quoted
    placeholders for secrets it cannot read — treat those as absent."""
    env_file = os.path.join(ROOT, ".env.training")
    if os.path.exists(env_file):
        for line in open(env_file, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                value = value.strip().strip('"').strip("'")
                if value and "[SENSITIVE]" not in value:
                    os.environ.setdefault(key.strip(), value)


load_env()
API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "").strip() or "gemini-3.5-flash-lite"
if not API_KEY or "[SENSITIVE]" in API_KEY:
    sys.exit(
        "no usable GEMINI_API_KEY in tools/train/.env.training\n"
        "  vercel env pull cannot read secret values — paste your real key\n"
        "  into that file as:  GEMINI_API_KEY=<key>"
    )
ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"

# ---- production prompt, verbatim from api/score-image.js (single image) ----

PROMPT = """You will receive 1 image, each preceded by a label (Image 1).

For each image, decide whether it is an AI-generated photograph (including photorealistic output from diffusion or GAN models).

Score high only when the pixels show generative artifacts: impossible anatomy, melted or garbled text, inconsistent lighting or shadows, repeating textures, oversmooth skin, warped background geometry, synthetic bokeh, or diffusion noise.

Score low for real photographs, screenshots, charts, infographics, logos, illustrations, memes, and images of text. An image that merely depicts or explains AI is not itself AI-generated.

Be conservative. Return exactly 1 result, one per image, in order. JSON only."""

SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer", "description": "1-based image number"},
                    "ai": {"type": "number", "description": "0 to 1 probability that this is an AI-generated photograph"},
                    "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                },
                "required": ["index", "ai", "confidence"],
            },
        }
    },
    "required": ["results"],
}


def jpeg_b64(path, max_side=512):
    from PIL import Image

    img = Image.open(path).convert("RGB")
    w, h = img.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


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


def teacher_check(b64):
    body = {
        "contents": [
            {"role": "user", "parts": [
                {"text": "Image 1"},
                {"inlineData": {"mimeType": "image/jpeg", "data": b64}},
                {"text": PROMPT},
            ]}
        ],
        "generationConfig": {
            "temperature": 0,
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
            parsed = json.loads(res.json()["candidates"][0]["content"]["parts"][0]["text"])
            result = parsed["results"][0]
            ai = min(1.0, max(0.0, float(result.get("ai") or 0)))
            confidence = result.get("confidence") or "low"
            blur = (ai >= 0.7 and confidence != "low") or ai >= 0.85  # deployed rule
            return {"ai": ai, "confidence": confidence, "blur": blur}
        except (KeyError, IndexError, json.JSONDecodeError, TypeError):
            return None
    return None


def collect(folder, n):
    files = sorted(f for f in os.listdir(folder) if f.endswith(".jpg"))
    step = max(1, len(files) // n)
    return [os.path.join(folder, f) for f in files[::step]][:n]


def run_class(name, label):
    files = collect(os.path.join(DATA, name), N_PER_CLASS)
    print(f"{name}: checking {len(files)} with the teacher ({MODEL})")
    results = [None] * len(files)
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(teacher_check, jpeg_b64(f)) for f in files]
        for i, future in enumerate(futures):
            results[i] = future.result()
            if (i + 1) % 20 == 0:
                print(f"  {i + 1}/{len(files)}")

    agree = flagged = kept = fails = 0
    for result in results:
        if not result:
            fails += 1
            continue
        pred = 1 if result["blur"] else 0
        if pred == label:
            agree += 1
        if pred == 1:
            flagged += 1
        else:
            kept += 1
    scored = len(files) - fails
    return {
        "class": name,
        "scored": scored,
        "fails": fails,
        "agreement": agree / max(1, scored),
        "teacher_flagged": flagged,
        "teacher_kept": kept,
    }


def main():
    out = []
    out.append(run_class("real", 0))
    out.append(run_class("synthetic", 1))
    print("\n--- teacher agreement ---")
    for row in out:
        print(json.dumps(row))
    with open(os.path.join(ROOT, "data", "teacher_check_images.json"), "w", encoding="utf-8") as f:
        json.dump({"model": MODEL, "results": out}, f, indent=2)


if __name__ == "__main__":
    main()
