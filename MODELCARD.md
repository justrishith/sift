# Model Card — Sift Sprout

**A small, local, on-device classifier that keeps Sift working without the network.**

---

## Model details

| Field | Value |
|---|---|
| Name | **Sift Sprout** (`sift-sprout`) |
| Version | 0.1.0-draft (planned; not yet trained) |
| Developer | Sift (justrishith/sift) |
| Type | Text classifier, DistilBERT/MiniLM-class backbone |
| Format | ONNX, int8 quantized |
| Target size | 20–60 MB |
| Target latency | 10–50 ms per article on a mid-range laptop |
| Runtime | ONNX Runtime Web (WASM), inside the MV3 extension |
| Distribution | Lazy download from sift-steel.vercel.app on first enable; cached in OPFS. Never bundled with the extension — model updates ship independently. |
| Teacher | Gemini (`gemini-3.5-flash-lite`), via the deployed `/api/score-page` prompt |

### Name rationale

Sift's brand is a flower. A sprout is small, planted by the data the product
already collects, and grows into the thing that eventually replaces the paid
teacher. The image counterpart (a distilled vision gate) will be **Sift
Bloom** when the correction data exists to train it.

---

## Intended use

Sprout classifies article text into the same three labels the remote endpoint
uses today:

- `synthetic` — fabricated article or AI-generated content posing as reporting
- `content_farm` — mass-produced, low-quality, machine-written content
- `editorial` — genuine journalism, even if opinionated or low quality

It runs **in the browser, on-device**. No text leaves the user's machine once
Sprout is active. The remote Gemini call becomes the fallback and the
continuous teacher, not the primary path.

**Decision rule (unchanged from PLAN.md §13.2, auditable):**

- `confidence == high && slop > 0.8 && siteTier >= 2` → cover
- otherwise → label only / leave alone

**Out of scope, deliberately:**

- Image/deepfake classification (multimodal models and small CNNs score near
  chance; that is Sift Bloom's job, after the data exists)
- "Did a human *use* AI while writing this" — the product only claims
  mass-produced slop, not AI assistance
- Languages other than English (v1)

---

## Training data

1. **Teacher labels (primary).** Every `/api/score-page` call logs
   `(title, text hash, verdict, model, timestamp)`. The deployed proxy is the
   collector; slop is repetitive, so the cache hit rate concentrates labels on
   the highest-value examples.
2. **Human corrections (highest value).** The one-tap reveal — "this is
   wrong" in both directions (flagged-but-real, missed-but-slop) — is stored
   per install and, with consent, contributed anonymously (PLAN.md L4 loop).
3. **Curated corpora (bootstrap).** Real journalism from major outlets
   (negative class) paired with LLM-generated advertorial/fake-news text
   (positive class), generated fresh against the current generator ecosystem.

The labeled-corrections dataset — not the model — is the moat.

---

## Metrics (launch gates, from PLAN.md §6)

| Metric | Gate |
|---|---|
| Precision, label-only | ≥ 85% on a hand-labeled set of 300 items |
| Precision, auto-hide (calibrated sites only) | ≥ 95% |
| Recall on known-slop test set | ≥ 60% (lists + heuristics do the heavy lifting) |
| Median latency per article | < 50 ms local |
| False hides reported | < 1 per user per week |
| Model size | ≤ 60 MB int8 |

**Kill criteria:** if precision on real news text is below ~90% in the launch
market, Sprout ships label-only and never auto-hides.

---

## Evaluation plan

- Held-out hand-labeled set (300 items) refreshed quarterly
- Adversarial set: current-generation LLM output (updated every quarter —
  decay against new generators is the failure mode)
- Cross-domain check: train on news, test on blogs/product reviews to detect
  distribution overfit
- Every shipped label records which scorer produced it (layer instrumentation),
  so local vs. remote precision can be compared in the wild

---

## Privacy & ethics

- **On-device by design.** With Sprout active, article text never leaves the
  browser. Remote scoring is fallback only, and text is capped at 6,000 chars
  with no identifiers attached.
- **Plain language, always.** Covers say "looks AI-generated", never "is
  fake"; no confidence percentages are shown to users.
- **Reversible by one tap.** Every cover has a reveal path and a correction
  path; corrections feed the next training round.
- **Consent.** Contribution of correction data is opt-in and anonymized;
  elderly users cannot meaningfully consent to fine print, so the carer
  consents during setup (PLAN.md §8).
- **No defamation.** Never name a publication as fake; the cover attaches to
  images, with the page-level verdict stored as a heuristic signal.

---

## Honest limitations

- **v0.1.0-draft does not exist yet.** This card describes the plan, the
  gates, and the data collection already running. Shipping a model before its
  gates are met would be worse than shipping none.
- Text AI-detectors are unreliable in general; they are reliable for
  *mass-produced slop*, which is the only claim Sift makes.
- A local model cannot see what it was not trained on. The remote teacher
  stays live so the corpus keeps growing against new generators.
- Sprout makes Sift better when offline, not infallible. Sift still fails
  open: no verdict means no blur.

---

## Changelog plan

| Version | Contents |
|---|---|
| 0.1.0 | First distilled text student (MiniLM-class), EN, label-only |
| 0.2.0 | Calibrated thresholds from L4 corrections; auto-hide on Tier-2 sites |
| 0.3.0 | Sift Bloom: distilled image gate, correction-data dependent |

---

# Model Card — Sift Bloom

**A small, local, on-device image classifier that runs in the browser and scores images the same way Sift's remote endpoint does.**

---

## Model details

| Field | Value |
|---|---|
| Name | **Sift Bloom** (`sift-bloom`) |
| Version | 0.1.0 |
| Developer | Sift (justrishith/sift) |
| Type | Image classifier, MobileNetV3-Small transfer-learned (ImageNet1K_V1 backbone → binary real/synthetic head) |
| Format | ONNX fp32 (`bloom.onnx`, 6.09 MB) |
| Input | 192 × 192 center-cropped square JPEG, ImageNet normalization |
| Runtime | ONNX Runtime Web (WASM), inside the MV3 extension |
| Distribution | Lazy download from sift-steel.vercel.app on first enable; cached in OPFS. Never bundled with the extension — model updates ship independently. |
| Teacher | Gemini (`gemini-3.5-flash-lite`), via the deployed `/api/score-image` prompt |

### Name rationale

Sift's brand is a flower. **Bloom** is the image counterpart to Sprout (text): it opens on the image the user is about to see and decides, before anything is shown, whether it's worth blurring.

---

## Intended use

Bloom classifies an image as `real` (0) or `synthetic` (1 — AI-generated photograph). It runs **in the browser, on-device**. No image pixels leave the user's machine once Bloom is active; the remote Gemini call stays live as the fallback and continuous teacher.

**Decision rule (mirrors the deployed `/api/score-image` blur rule):**

- `ai >= 0.7 && confidence !== "low"` → blur
- `ai >= 0.85` → blur (even at low confidence)
- otherwise → leave alone

The model outputs logits; the extension converts them to a 0–1 `ai` probability via softmax and applies the rule above.

**Out of scope, deliberately:**

- Text/AI-sloped article classification (that's Sift Sprout)
- Detecting "a human used AI to edit this" — Bloom flags AI-*generated* photographs, not AI-assisted edits
- Non-photorealistic classes (illustrations, memes, screenshots, diagrams) — scored low by design, matching the production prompt

---

## Training data

| Class | Count | Source |
|---|---|---|
| Real | 2,000 | `Parveshiiii/AI-vs-Real` (label `1 = Real`, ~half) + `ethz/food101` natural photos (~half) |
| Synthetic | 2,000 | `Parveshiiii/AI-vs-Real` (label `0 = AI-generated`) |

All images center-cropped to square, saved as 192 × 192 JPEG (quality 85). No resampling between classes. MIT-licensed sources; credit: Parvesh Rawal — AI-vs-Real Dataset (2025).

The labeled dataset — not the model — is the moat; correction data from the one-tap reveal feeds the next round.

---

## Metrics (from `tools/train/artifacts/metrics_bloom.json`)

Val set: 480 images (240 real / 240 synthetic), held-out 12% split.

### Student (on-device model)

| Metric | Value |
|---|---|
| Accuracy (fp32 ONNX) | **98.5%** |
| Precision (fp32 ONNX) | 0.983 |
| Recall (fp32 ONNX) | 0.988 |
| F1 (fp32 ONNX) | 0.985 |
| Median latency (CPU) | 31 ms |
| p90 latency (CPU) | 37 ms |
| Model size (fp32) | 6.09 MB |

### Teacher agreement (quality gate)

Ran the **verbatim production `/api/score-image` prompt** over 120 val images (60/60) through `gemini-3.5-flash-lite` at 14 RPM:

| Class | Teacher agreement | Teacher blur decision |
|---|---|---|
| Real (60) | 96.7% | 58 kept, 2 false positives |
| Synthetic (60) | 76.7% | 46 flagged, 14 kept |
| **Overall** | **86.7%** | — |

The synthetic agreement is below the real side because the production prompt is deliberately conservative ("be conservative... score low for illustrations"), so it under-flags some AI images — the same trade-off the deployed endpoint makes.

### Known issue (deferred)

Dynamic int8 quantization (`quantize_dynamic`) regresses this model to chance (~53% acc, all-positive) — a known failure mode with MobileNetV3's hardswish under the ORT quantizer. v0.1.0 ships **fp32 ONNX**; int8 is a follow-up once a working calibration recipe exists. fp32 at 6.09 MB is still well within the lazy-download budget.

---

## Privacy & ethics

- **On-device by design.** With Bloom active, image pixels never leave the browser. Remote scoring is fallback only.
- **Plain language.** Badges say "looks AI-generated", never "is fake"; no confidence percentages are shown to users.
- **Reversible.** Every cover has a reveal path and a correction path; corrections feed the next training round.
- **Consent.** Correction-data contribution is opt-in and anonymized; the carer consents during setup.

---

## Honest limitations

- A local model cannot see what it was not trained on. Decay against new generators is the failure mode; the remote teacher stays live so the corpus keeps growing.
- Bloom scores photographs. Illustrations, diagrams, memes, and text-heavy images are scored low by design — an AI-generated infographic may pass through.
- Sift still fails open: no verdict means no blur.

---

## Changelog

| Version | Contents |
|---|---|
| 0.1.0 | MobileNetV3-Small transfer-learned on Parveshiiii/AI-vs-Real (2k+2k, 192px), fp32 ONNX, teacher-agreement gate, lazy OPFS download |
| 0.2.0 | Working int8 quantization (if a stable recipe lands); calibrated thresholds from correction data |
| 0.3.0 | Cross-generator adversarial set; out-of-distribution check via Gemini-generated synthetic images |

