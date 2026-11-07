# Sift

Sift blurs AI-generated images in news articles and lets the reader reveal them one at a time.

Built for older readers who are being targeted by AI slop and deepfake scam ads.

**Live demo:** https://sift-steel.vercel.app/slop.html

---

## How it works

```
article opens
   └─ content script finds the article and extracts its text
        └─ one request to the scoring endpoint
             └─ Gemini classifies: synthetic / content_farm / editorial
                  └─ if flagged, every content image is blurred in place
                       └─ "4 pictures hidden  [Show them]"
```

One model call per **article**, not per image. That keeps it fast and cheap, and it means the
blur decision is explainable: the page was judged, not each picture.

The Gemini key lives in a server-side environment variable on Vercel. It never enters the
extension bundle, so it cannot be extracted from a `.crx`.

---

## Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the `extension` folder
4. Pin Sift to the toolbar

The toolbar popup shows the on/off switch and how many pictures Sift has blurred this week.

---

## Demo script (90 seconds)

1. Open **https://sift-steel.vercel.app/slop.html**
2. After 1–3 seconds all four images blur and the purple pill says **"4 pictures hidden"**.
3. Click one blurred image once — it reveals, and the link behind it does **not** open.
4. Click the revealed image again — now it behaves normally.
5. Press **Show them** — every image on the page reveals.
6. Open **https://sift-steel.vercel.app/article.html**. Real reporting stays sharp. That is the
   false-positive check.
7. Open DevTools console to show the verdict: category, confidence, reasons.

If the venue Wi-Fi dies, append `#sift-demo` to either URL to force the blur without a network
call. The real classifier path is the one to demo when the network is up.

---

## Layout

```
extension/
  manifest.json           MV3: two content scripts, no remote code
  background.js           the only network call: article text -> verdict
  content/page-scorer.js  article detection, text extraction, verdict event
  content/image-shield.js blur, reveal, click-through blocking, pill
  content/image-shield.css
  popup/popup.html        on/off + weekly count
  icons/                  purple flower mark
api/
  score-page.js           Vercel serverless function holding the Gemini key
site/
  index.html              landing page
  slop.html               page that should blur
  article.html            control page that should stay sharp
  styles.css
```

---

## Honest limitations

- **Gemini classifies text, not pixels.** It decides whether the *article* looks AI-generated.
  A deepfake planted on a trustworthy publisher is not caught by this alone.
- **One verdict per page.** If the article is flagged, all its content images blur, including
  real ones. That is deliberate: the blur is reversible and the reader stays in control.
- **Article pages only.** Sift scores pages that contain an `<article>`, or a `<main>` with at
  least three paragraphs. YouTube and dashboards are not scored by this build.
- **No teaching layer yet.** Reveal is one tap, with no explanation or quiz.
- **Fails open.** If the endpoint is down or the key is missing, nothing is blurred and the page
  behaves normally.

---

## Security notes

- `.env` is gitignored; `.env.example` is the template.
- The extension never sees the key. It only knows the `/api/score-page` URL.
- Only the article title and text are sent to the endpoint. No URLs, cookies, or identifiers.
- The endpoint caps input at 6,000 characters and caches verdicts in memory.
