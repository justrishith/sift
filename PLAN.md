# DeepSafe — AI Slop Blocker
## Product & Technical Plan (v0.3)

---

## 1. What the product actually is

A Chrome extension for elderly users that **looks at each item** (article card, article page,
video card, short, thumbnail) on **news sites and YouTube**, decides whether it looks
AI-generated or mass-produced slop, and then:

- **labels it** in plain language: *"This looks AI-generated. We hid it."*
- **hides it** (collapsed, one tap to reveal)
- **learns** from the user's one-tap correction ("No, this is real")

The core promise to the user is **not** "we block all AI". It is:
> "We stop the fake stuff that is trying to trick you."

That framing matters. It sets a precision-first bar and keeps the product honest.

---

## 0. Decisions locked (v0.4)

| Decision | Choice | Consequence |
|---|---|---|
| Block semantics | **Collapse + label, tap to reveal** | Every flagged item keeps an escape hatch; corrections are always one tap away |
| Launch scope | **All news sites via generic adapters** | Generic adapter is the default; auto-hide is *gated by site calibration* (see §4.2) |
| Detection runtime | **Hybrid**: local L0–L2, remote L3 | Text + lists local; vision behind a candidate gate |
| Model strategy | **Buy/rent now, distill later** (see §13) | No in-house model in v1; training data is the moat, collected via L4 |

### 0.1 Why "build a small LLM" is the wrong first move

Three separate things get conflated here. They have different answers:

1. **Deepfake *image/video* detection** — this is a vision classification problem.
   A small LLM (1–3B params) **cannot do it**: multimodal LLMs score close to chance on
   deepfake detection and are trivially fooled. You need a purpose-built detector
   (Hive, Reality Defender, Sensity, Deepware) or a fine-tuned vision backbone.
2. **Slop *text* detection** — a small classifier works well here. DistilBERT/MiniLM
   quantized to ONNX is 20–60 MB, runs in 10–50 ms, and is free per call. But you need
   labeled training data to fine-tune it.
3. **Explaining *why*** — an LLM API is excellent at turning a score into one plain
   sentence for an elderly user.

**The actual recommendation:**

- **v1: rent.** LLM API for text scoring (~$0.0001/article), detector API for candidate
  images (~$0.002–0.01 each). Ship in weeks, not quarters.
- **v2: distill.** After ~10k human-corrected items from the L4 loop, train a small
  on-device classifier and replace the text API. By then you own the training set —
  which is the real moat. The model is not the moat; the labeled corrections are.
- **Never**: a 1–3B LLM in an extension. 1–2 GB package, 500 ms–3 s latency, weak accuracy,
  battery drain, and Chrome Web Store review hostility.

The code should therefore talk to a **`Scorer` interface** with swappable implementations
(`RemoteScorer` today, `LocalScorer` later) so this decision is reversible.


---

## 2. The detection target must be defined before the model

"Detect AI content" is not one problem. It is three, and only two are worth shipping:

| Class | Example | Flag it? |
|---|---|---|
| **A. Fully synthetic item** | Deepfake video of a celebrity; AI-generated "news" article with no real event | **Yes** |
| **B. Mass-produced slop** | Content-farm article, 40 AI videos/day channel, recycled thumbnails | **Yes** |
| **C. AI-assisted legitimate work** | A real journalist used an AI tool to draft or illustrate | **No — never** |

Every design decision below exists to separate **A/B** from **C** without hurting real journalism.
A false positive on a real news article is the single most damaging outcome for trust with this audience.

---

## 3. Detection architecture: layered triage

Cheap, certain signals run first. Expensive, uncertain ones run only when needed.
This is the only way to keep latency, cost, and privacy sane.

```
            ┌──────────────────────────────────────────┐
   item  →  │ L0  Provenance & metadata      (free)    │
            │     C2PA/Content Credentials, EXIF,      │
            │     YouTube "altered/synthetic" label,   │
            │     schema.org author/date               │
            └───────────────┬──────────────────────────┘
                            │ no verdict
            ┌───────────────▼──────────────────────────┐
            │ L1  Reputation graph           (cheap)   │
            │     known slop domains, channels,        │
            │     dHash of known ad creatives,         │
            │     publisher transparency score         │
            └───────────────┬──────────────────────────┘
                            │ no verdict
            ┌───────────────▼──────────────────────────┐
            │ L2  Text signals              (cheap)    │
            │     headline/body/transcript heuristics  │
            │     + small on-device classifier         │
            └───────────────┬──────────────────────────┘
                            │ candidate
            ┌───────────────▼──────────────────────────┐
            │ L3  Vision check              (costly)   │
            │     thumbnails / article images /        │
            │     sampled video frames → detector API  │
            └───────────────┬──────────────────────────┘
                            │
            ┌───────────────▼──────────────────────────┐
            │ L4  Human signal                          │
            │     user "this is wrong" taps, reports,   │
            │     aggregated into thresholds & lists    │
            └──────────────────────────────────────────┘
```

### 3.1 L0 — Provenance (highest precision, lowest recall)

- **YouTube disclosure label.** YouTube requires creators to disclose realistic synthetic
  content and renders an "Altered or synthetic content" / "How this was made" row in the
  description. When present → high-confidence A. Selector must be found defensively
  (text search, not a hard-coded class), because YouTube changes markup.
- **C2PA / Content Credentials.** Decisive when present, but modern CDNs strip or
  transcode images, so recall is near zero on news sites. Treat as a bonus, not a pillar.
- **Structured data.** `author`, `datePublished`, `publisher` in schema.org JSON-LD.
  Missing author + missing date + no publisher entity = weak signal for B.

**Verdict:** build it, but do not depend on it. Maybe 2–5% of slop carries provenance.

### 3.2 L1 — Reputation graph (best value per engineering hour)

Three sub-lists, all shipped as data, updated centrally:

1. **Slop domains** — content-farm and fake-news networks. Requires curation (researcher
   feeds, user reports, manual review). High precision, low recall.
2. **Slop channels** — YouTube channels that ship AI-generated video at volume. Signals:
   upload cadence, channel age, synthetic-disclosure density, title templates.
3. **Creative hashes** — dHash of known deepfake ad thumbnails. Catches the *same campaign*
   across sites and domains. Already partially built in `background.js`.

Rules for keeping it safe:
- A domain is only added after ≥2 independent reports or a public research source.
- Every entry has an appeal path. Never ship a list you cannot audit.
- This layer is exactly what the existing DNR blocklist does — keep it, extend it.

### 3.3 L2 — Text signals (cheap, surprisingly effective for *slop*)

Distinguish two sub-problems:

**(a) Headline/card level** — runs in the content script, no model:
- templated headlines ("You won't believe", "Scientists discover", "Doctors hate this")
- sensational punctuation, ALL-CAPS fragments
- numeric clickbait ("This one trick", "5 signs")
- publisher in a known-slop set
This is cheap and catches the *presentation* of slop, which is what the user sees first.

**(b) Article body / video transcript level** — needs text, which means a fetch:
- readability extraction of the article body (or the transcript)
- features: lexical diversity, paragraph length uniformity, hedge-word density,
  absence of named sources/quotes, date/place specificity, repetition across articles
- optional: a small distilled classifier (5–20 MB ONNX/WASM) scoring "slop vs. editorial"

**Recommendation for v1:** heuristics + a *server-side* text classifier (send the plain text
only, never the full page). On-device later if privacy becomes the blocker.
Text is 50–200× cheaper to classify than images and catches most content-farm slop.

Caveat to state honestly: text AI-detectors are unreliable in general. They are much more
reliable for **mass-produced slop** than for "did a human use AI at all". Product only
claims the former.

### 3.4 L3 — Vision (only for candidates, never for everything)

This is where deepfakes are actually caught. Three options:

| Option | Pros | Cons |
|---|---|---|
| **Third-party detector API** (Hive, Reality Defender, Sensity, Deepware) | Best accuracy, no ML team, fast to ship | Per-call cost, sends images to a third party, vendor lock-in |
| **Self-hosted open model** | Cost per call drops, control | Needs GPU infra + ML ops; accuracy on new generators decays |
| **On-device WASM model** | Private, no network, free per call | 50–150 MB, 1–3 s per image, weak generalization, battery drain |

**Recommendation:** third-party API behind a queue, **only for items that passed L2 as
candidates**. Expected volume ~5–20 images/user/day, not 500. Revisit self-hosting at scale.

Video is different: sample 3–5 frames (first second, 25%, 50%, 75%) rather than analyzing
the whole file. Full-video temporal detection is a research problem; frame-level catches most
face-swap slop.

### 3.5 L4 — Human-in-the-loop

- Every label has **"This is wrong"** for both directions (AI flagged that isn't; AI missed).
- Corrections are stored locally and, if the user consents, contributed anonymously.
- Per-item thresholds adapt: a user who reveals 10 flagged items and says "real" gets a
  higher bar for auto-hide.
- Reports feed the L1 lists after manual review.

---

## 4. Where it runs: YouTube vs. news sites

The two surfaces have almost nothing in common technically.

### YouTube
| Surface | Signal | Action |
|---|---|---|
| Home / search feed cards | thumbnail, title, channel reputation, disclosure label | collapse card + label |
| Shorts | all of the above, plus "shorts" surface itself | section-hide (already built) |
| Watch page | description disclosure label, transcript text, sampled frames | top banner + "hide video" |
| Comments/related | reputation + text | already section-hide |

Practical note: YouTube is an SPA. The engine already re-applies on `pushState`. Card
selectors: `ytd-rich-item-renderer`, `ytd-video-renderer`, `ytd-compact-video-renderer`,
`ytd-reel-item-renderer`. Label injection must be idempotent (MutationObserver + WeakSet).

### News sites (the hard part)
- There is no single DOM. Two generic patterns:
  - **Card on a listing page** (`article`, `[data-testid*=card]`, `h2 a`) → score, collapse.
  - **Article page** → extract body text, score, show banner.
- Needs a **site adapter layer**: a small registry of per-publisher selectors + a generic
  fallback (readability + schema.org). Budget for selectors rotting; that's the operating cost.
### 4.2 "All news sites" — how to do it without wrecking precision

A generic adapter on every news site is achievable. **Auto-hide on every news site is not.**
So separate the two and let trust be earned per domain.

**Tier 0 — Protected publishers.** A curated allowlist of major outlets (BBC, NYT, Reuters,
AP, etc.). Never auto-hide. Label-only, and only if confidence is very high.

**Tier 1 — Generic (all other sites, day one).** The generic adapter runs everywhere:
card detection via common patterns + `article`/`h2 a`, article-page extraction via
readability + JSON-LD. Action: **label only**. Never auto-hide an item on an uncalibrated site.

**Tier 2 — Calibrated sites.** A domain is promoted to auto-hide after it accumulates
evidence from the L4 loop, e.g. **≥50 labeled items and ≥95% user agreement** on that domain.
Promotion is automatic and revocable; a bad batch demotes the site back to Tier 1.

**Tier 3 — Known slop domains.** Added to L1 only after independent reports or a public
research source. Auto-hide + block, with an appeal path.

This gives you the "all news sites" reach the product needs while capping the blast radius
of a bad model on an unknown publisher. It also means every user correction is a promotion
signal, not just a bug report.

Mechanically: `extension/content/adapters/generic.js` + a per-domain profile stored in
`chrome.storage.local` (`{domain: {tier, labels, agreements, autoHide}}`).


---

## 5. UX specification (this is the product)

Non-negotiables for the elderly audience:

1. **No settings wall.** One switch: "Protect me from AI fakes." Everything else is defaults.
2. **Label, don't lecture.** Collapsed card reads:
   > ⚠️ **Looks AI-generated.** We hid this. [Show it anyway]
3. **Two-tap correction, always available.**
   > [That's wrong — show me these]
4. **Never a full-page block on a news site.** Hide the *article*, keep the site usable.
5. **Explain once, in plain words**, the first time something is hidden:
   > "Some videos and articles are made by a computer to look real. DeepSafe hides the ones
   > it is sure about. You can always tap to see them."
6. **Big type, high contrast, large tap targets** (min 44×44 px, body ≥ 18 px).
7. **No scary language, no legal hedging, no confidence percentages.** "Looks AI-generated",
   not "72% synthetic probability".
8. **Family handoff**: a weekly digest the carer can read ("hid 23 items, you revealed 2").

Trust rule: **when in doubt, label softly, never hide**. Losing a real news story once will
cost you the user permanently.

---

## 6. Metrics and guardrails

| Metric | Target (launch) |
|---|---|
| Precision of *auto-hide* | ≥ 95% |
| Precision of *label only* | ≥ 85% |
| Recall on known slop lists | ≥ 60% (lists do the heavy lifting) |
| Median time to verdict on a card | < 150 ms (L0–L2 only) |
| Items sent to vision API per user/day | < 20 |
| False hides reported per user per week | < 1 |
| Uninstall within 7 days | < 10% |

Instrument every label with the layer that produced it, so you can see which layer earns its
keep and which one is generating complaints.

**Kill criteria:** if vision-API precision on real news thumbnails is below ~90% in the
launch market, do not ship auto-hide for images — ship label-only until it improves.

---

## 7. Cost model (order of magnitude)

- Text classification: ~$0.0002–0.002 per article (self-hosted small model ≈ free).
- Vision API: ~$0.002–0.01 per image.
- At 10 candidate images/user/day and 10k users: **$200–1,000/day** at vendor prices.
- Mitigations: aggressive triage (L2 gate), per-user rate limits, cache by image hash
  (the same slop is seen by thousands of users → cache hit rate will be very high),
  self-host once volume justifies it.

The hash cache is the key economic lever: slop is *repetitive*, so a shared cache of
(image hash → verdict) collapses the cost curve.

---

## 8. Legal, ethical, platform risk

- **Defamation / false labeling.** Never say "this is fake" about a named publication.
  Use "looks AI-generated" + a correction path + a published methodology page.
- **Store policy.** Broad host permissions + content modification = heavy review. Keep
  permissions minimal, document data flows, ship a privacy policy before submission.
- **Privacy.** Sending article text or images off-device is a real disclosure. Default should
  be: text only, no identifiers, opt-in for images. Elderly users cannot meaningfully consent
  to fine print — design for the caregiver to consent on their behalf.
- **Platform ToS.** Hiding YouTube/Instagram elements is a grey area. Keep changes visual
  only, never automate playback or bypass monetization.
- **Accessibility.** WCAG AA contrast, keyboard reachable, screen-reader labels.

---

## 9. Phases

### Phase 0 — Skeleton + labels (1–2 weeks)
- Keep the built section engine and DNR blocklist as L1 delivery.
- Build `content/adapters/generic.js` (news cards + article pages) and
  `content/adapters/youtube.js` (feed cards, Shorts, watch page).
- Add `content/label-ui.js` — collapse + "Looks AI-generated" + show-anyway + "that's wrong".
- Implement L0 (YouTube disclosure text search) + L2 headline heuristics.
- Implement the **site tier store** (Tier 0–3) with label-only default everywhere.
- **Exit:** labels appear on YouTube and any news site, every label is correctable, and
  nothing is auto-hidden on an uncalibrated domain.

### Phase 1 — Text classifier (2–3 weeks)
- Article extraction (readability + JSON-LD fallback) and transcript fetch for YouTube.
- Small server endpoint: `POST /score-text` → `{score, reasons[]}`. Or on-device WASM if
  privacy is non-negotiable.
- Ship label-only (no auto-hide) and collect precision data.
- **Exit:** measured precision ≥ 85% on a hand-labeled set of 300 items.

### Phase 2 — Reputation graph + hash cache (2 weeks)
- Curated slop-domain and slop-channel lists with review workflow.
- Shared creative-hash cache (`hash → verdict`) to cut vision cost.
- **Exit:** L1 alone catches ≥ 40% of the labeled slop set with ≥ 98% precision.

### Phase 3 — Vision (3–4 weeks)
- Integrate one detector API behind the L2 gate.
- Frame sampling for video.
- Enable auto-hide only above a calibrated threshold.
- **Exit:** auto-hide precision ≥ 95%; false hides < 1/user/week.

### Phase 4 — On-device / scale (later)
- Evaluate distilled on-device vision model.
- Per-user adaptive thresholds, caregiver digest, enterprise deployment for care homes.

---

## 10. What already exists in this repo

| Piece | Status |
|---|---|
| `extension/manifest.json` (MV3, DNR, content scripts) | done |
| `extension/shared/sections.js` (YouTube/FB/IG/TikTok/X section rules) | done |
| `extension/content/engine.js` (section gating + sponsored heuristics + hash check) | done |
| `extension/background.js` (rules, sync, stats, dHash, URL scoring) | done |
| `extension/rules/scams.json` (static scam destinations) | placeholder list |
| blocked / popup / options / icons / site | **not built yet** |

What changes for this new direction:
- The engine's "sponsored post" filter becomes one *signal* inside the new classifier, not
  the product.
- Add `content/adapters/` — per-site adapters (YouTube, news) that surface **items** (not just
  selectors) to a shared scorer.
- Add `content/label-ui.js` — the "This looks AI-generated" card treatment.
- Add a `detector/` service stub (text scoring first, vision later).
- Remove nothing from the current build; it is all reusable as L1.

---

## 11. Resolved questions

| Question | Answer |
|---|---|
| Detection runtime | ~~on-device / server / API?~~ → **hybrid**: local L0–L2, remote L3 |
| Block semantics | **collapse + label, tap to reveal** |
| Launch scope | **all news sites via generic adapters**, with per-domain tier gating (§4.2) |
| Model strategy | **rent an API in v1**, distill to an on-device classifier after ~10k corrections (§0.1) |
| Backend | Needed for L3 + optional L2 text. Must be designed so the extension degrades to
  local-only heuristics if the API is unreachable. |
| Installer | Still open — assume the carer installs it; add the weekly digest in Phase 3 |

### Remaining open questions

1. **Launch language/market** — the text heuristics and LLM prompt are language-specific.
2. **Who consents** to sending article text/images to an API: the elderly user or the carer?
3. **Budget ceiling** for L3 vision calls per user per month.


---

## 12. The honest risk statement

Per-item AI detection in a browser is **not a solved problem**. The plan above does not
pretend otherwise; it converts an impossible promise ("detect any deepfake anywhere") into a
shippable one:

> **"We block the slop we are sure about, label the rest, and let you correct us."**

That is defensible, buildable, and genuinely useful for the audience.

---

## 13. Provider decision: Gemini (v0.5)

| Task | Gemini | Notes |
|---|---|---|
| Text slop scoring | YES | structured JSON output; 80% of the signal |
| Thumbnail OCR -> text scoring | YES | overlay text is a strong slop tell |
| "Is this image a deepfake?" | NO | multimodal LLMs are near chance; use a dedicated detector |
| Explaining reasons to the user | YES | one plain sentence, generated from `reasons[]` |

### 13.1 Never ship the key

```
extension --POST /score--> proxy (Worker/Vercel) --> Gemini
                             | key, cache, rate limit, prompt version
```

The proxy is mandatory:
- API key never enters the .crx
- `content_hash -> verdict` cache (slop is repetitive; ~80% hit rate expected)
- per-install rate limits and a monthly vision budget
- versioned prompts so you can roll back a bad rubric
- logs become the distillation dataset for the eventual on-device model

### 13.2 Response contract

```json
{
  "slop": 0.0,
  "category": "synthetic | content_farm | editorial",
  "confidence": "low | medium | high",
  "reasons": ["..."]
}
```

Client decision rule (auditable, no hidden magic):
- `confidence == high && slop > 0.8 && siteTier >= 2` -> auto-hide
- otherwise -> label only

### 13.3 Failure behaviour

- timeout / 429 / 5xx -> local heuristics, label-only, never auto-hide
- API unreachable for > 24h -> status shown in the popup, not a broken page

### 13.4 Cost guardrails

- Cache every verdict by normalized content hash.
- Hard cap of vision calls per install per month.
- Batch card text (up to ~10 headlines) into one call where possible.
- Re-verify pricing and free-tier limits before launch; free tier is not production capacity.

### 13.5 Privacy

Article text and image URLs leave the device. Requirements:
- carer consents during setup; plain-language notice for the user
- no URLs, cookies, or identifiers sent with the payload
- option to run in "local only" mode (heuristics, lower recall)
