# Sift

Sift blurs AI-generated images in news articles and lets the reader reveal them one at a time.

Built for older readers who are being targeted by AI slop and deepfake scam ads.

**Live demo:** https://sift-steel.vercel.app/article.html

---

## How it works

```
article opens
   └─ content script extracts the article text
        └─ one request to the local proxy
             └─ Gemini classifies: synthetic / content_farm / editorial
                  └─ if flagged, every content image on the page is blurred
                       └─ "3 pictures hidden  [Show them]"
```

One model call per **article**, not per image. That keeps it fast and cheap, and it means the
blur decision is explainable: the page was judged, not each picture.

The API key lives in `.env` and is used only by the proxy. It never enters the extension
bundle, so it cannot be extracted from a `.crx`.

---

## Run the demo

**1. Add your key**

```powershell
# edit .env
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
PROXY_PORT=8787
```

Get a free key at https://aistudio.google.com/apikey

**2. Start the proxy**

```powershell
powershell -ExecutionPolicy Bypass -File server\proxy.ps1
```

Leave it running. It prints `Sift proxy on http://127.0.0.1:8787`.

**3. Load the extension**

- `chrome://extensions`
- Developer mode → **Load unpacked** → select the `extension` folder

**4. Open the demo article**

Open `site/article.html` in Chrome (double-click it, or drag it into a tab).

The four images blur after the classifier returns, usually 1–3 seconds.

> Tip: open `site/article.html#sift-demo` to force the blur without calling the API.
> Useful if the demo Wi-Fi dies.

---

## Demo script (90 seconds)

1. Open `site/article.html`. Let the page settle.
2. Four images are blurred. Pill: **"4 pictures hidden"**.
3. Tap one image → it reveals. Tap again → it navigates.
4. Tap **"Show them"** → all reveal.
5. Open the DevTools console to show the verdict: category, confidence, reasons.

---

## Layout

```
extension/
  manifest.json           MV3, DNR blocklist, content scripts
  background.js           rules, stats, dHash, page + image scoring
  content/page-scorer.js  extract article text -> proxy -> verdict
  content/image-shield.js blur, reveal, pill
  content/engine.js       social-site section hiding (not used in this demo)
  shared/sections.js      section rule definitions
  rules/scams.json        static scam-domain blocklist (placeholder)
server/
  proxy.ps1               local HTTP proxy holding the Gemini key
site/
  index.html              demo front page
  article.html            demo article
  styles.css
```

---

## Honest limitations

- **Gemini classifies text, not pixels.** It decides whether the *article* looks AI-generated.
  A deepfake planted on a trustworthy publisher is not caught by this alone.
- **One verdict per page.** If the article is flagged, all its images blur, including real ones.
  That is deliberate: the blur is reversible and the user stays in control.
- **The proxy is a demo server.** It is single-threaded PowerShell on localhost. For anything
  real, move it to a Worker/serverless function with auth, rate limits, and caching.
- **No teaching layer yet.** Reveal is one tap, no explanations or quizzes.

---

## Security notes

- `.env` is gitignored. `.env.example` is the template.
- The extension never sees the key. It only knows `http://127.0.0.1:8787/score-page`.
- The proxy sends only the article text and title to Gemini. No URLs, cookies, or identifiers.
- CORS is open on the proxy for local demo use; lock it down before deploying anywhere.
