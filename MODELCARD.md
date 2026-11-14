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
