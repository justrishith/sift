# Sift

Sift blurs AI-generated images across the web and lets the reader reveal them one at a time.

Built for older readers who are being targeted by AI slop and deepfake scam ads.

**Live demo:** https://sift-steel.vercel.app/slop.html#sift-demo
**Download:** https://sift-steel.vercel.app/sift-extension.zip

---

## How it works

Sift has two detection paths:

```
article page
   └─ content script extracts the article text
        └─ /api/score-page asks Gemini whether the page is slop
             └─ if flagged, every content image gets a Sift cover

any other page (Google Images, YouTube, a news homepage)
   └─ only images that intersect the viewport are collected
        └─ six images are sent in one batch to /api/score-image
             └─ Gemini says which pixels look AI-generated
                  └─ those images get a Sift cover
```

A blocked image is never removed. It gets a soft lilac cover with a flower, a
**blocked by sift** badge, and a **tap to peek** hint. Clicking the cover reveals the picture
and removes the cover. The first click can never follow the link behind the image, and the
same guard covers keyboard activation.

The Gemini key lives in a server-side environment variable on Vercel. It never enters the
extension bundle, so it cannot be extracted from a `.crx`.

---

## Install from the download

1. Download **sift-extension.zip** from the
   [landing page](https://sift-steel.vercel.app/#install) or
   [directly](https://sift-steel.vercel.app/sift-extension.zip).
2. Unzip it anywhere you can find again.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped folder.
5. Pin Sift to the toolbar.

### Install from the repo

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the `extension` folder
4. Pin Sift to the toolbar

The toolbar popup shows the on/off switch and how many pictures Sift has blocked this week.

Chrome warns about unpacked extensions. That is normal for a developer build; the demo is not
on the Chrome Web Store.

---

## Demo script (90 seconds)

1. Open **https://sift-steel.vercel.app/slop.html#sift-demo**
2. All four images get Sift covers, each with a **blocked by sift** badge.
3. Click one cover once — it reveals, and the link behind it does **not** open.
4. Click the revealed image again — now it behaves normally.
5. Open **https://sift-steel.vercel.app/article.html**. Real reporting stays sharp. That is the
   false-positive check.
6. Open a **Google Images** search for something AI-generated, or a YouTube home page. Sift
   scores the visible pictures in one batch and covers the ones that look synthetic.

If the venue Wi-Fi dies, append `#sift-demo` to either Sift URL to force the blur without a
network call.

---

## Layout

```
extension/
  manifest.json           MV3: two content scripts, no remote code
  background.js           page verdict + per-image vision calls
  content/page-scorer.js  article detection, text extraction, verdict event
  content/image-shield.js covers, reveal, click-through blocking
  content/image-shield.css
  popup/popup.html        on/off + weekly count
  icons/                  purple flower mark
api/
  score-page.js           article-text classifier
  score-image.js          per-image vision classifier
site/
  index.html              landing page + install steps
  slop.html               full advertorial demo that should blur
  article.html            control page that should stay sharp
  sift-extension.zip      downloadable developer build
  styles.css
```

---

## Honest limitations

- **The image model judges pixels, and it can be wrong.** It is conservative by design; a
  heavily compressed thumbnail may be missed. A wrong blur is reversible with one click.
- **Only images on screen are scored.** An image is queued only when it intersects the
  viewport, so offscreen and lazy-loaded pictures are never fetched just to be judged. Up to
  8 images per page, six per vision request, and only images at least 180×120. That keeps the
  free tier usable and avoids scoring avatars, icons, and banners.
- **Verdicts are cached for a week** in extension storage. Reloading a page reapplies covers
  immediately; repeat pictures skip Gemini entirely.
- **Article pages are judged as a whole.** If the text is flagged, every content image is
  covered, including real ones. That is deliberate: the cover is reversible.
- **Sift fails open.** If an endpoint is down, times out, or hits quota, nothing is covered
  and the page behaves normally.
- **No teaching layer yet.** Reveal is one tap, with no explanation or quiz.

---

## Security notes

- `.env` is gitignored; `.env.example` is the template. Production values live in Vercel.
- The extension never sees the key. It only knows the two `/api/score-*` URLs.
- Article text is capped at 6,000 characters. Images are downscaled to 512px before upload.
- The server never fetches a URL supplied by a page; the extension fetches the image with its
  own host permissions and sends bytes. That avoids server-side request forgery.
- Both endpoints cache verdicts in memory and set CORS to `*` for the extension.
