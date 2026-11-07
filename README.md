# Sift

Sift blurs AI-generated images across the web and lets the reader reveal them one at a time.

Built for older readers who are being targeted by AI slop and deepfake scam ads.

**Live demo:** https://sift-steel.vercel.app/slop.html

---

## How it works

Sift has two detection paths:

```
article page
   └─ content script extracts the article text
        └─ /api/score-page asks Gemini whether the page is slop
             └─ if flagged, every content image gets a Sift cover

any other page (Google Images, YouTube, a news homepage)
   └─ images near the viewport are sent one at a time
        └─ /api/score-image asks Gemini whether the pixels look AI-generated
             └─ that image gets a Sift cover
```

A blocked image is never removed. It gets a frosted purple cover with a pulsing flower orb
and a **Blocked by Sift** badge in the corner. Clicking the cover reveals the picture and
removes the cover. The first click can never follow the link behind the image, and the same
guard covers keyboard activation.

The Gemini key lives in a server-side environment variable on Vercel. It never enters the
extension bundle, so it cannot be extracted from a `.crx`.

---

## Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the `extension` folder
4. Pin Sift to the toolbar

The toolbar popup shows the on/off switch and how many pictures Sift has blocked this week.

---

## Demo script (90 seconds)

1. Open **https://sift-steel.vercel.app/slop.html**
2. All four images get Sift covers and the purple pill says **"4 pictures hidden"**.
3. Click one cover once — it reveals, and the link behind it does **not** open.
4. Click the revealed image again — now it behaves normally.
5. Press **Show them** — every cover disappears.
6. Open **https://sift-steel.vercel.app/article.html**. Real reporting stays sharp. That is the
   false-positive check.
7. Open a **Google Images** search for something AI-generated, or a YouTube home page. Sift
   scores the visible pictures and covers the ones that look synthetic.

If the venue Wi-Fi dies, append `#sift-demo` to either Sift URL to force the blur without a
network call.

---

## Layout

```
extension/
  manifest.json           MV3: two content scripts, no remote code
  background.js           page verdict + per-image vision calls
  content/page-scorer.js  article detection, text extraction, verdict event
  content/image-shield.js covers, reveal, click-through blocking, pill
  content/image-shield.css
  popup/popup.html        on/off + weekly count
  icons/                  purple flower mark
api/
  score-page.js           article-text classifier
  score-image.js          per-image vision classifier
site/
  index.html              landing page
  slop.html               page that should blur
  article.html            control page that should stay sharp
  styles.css
```

---

## Honest limitations

- **The image model judges pixels, and it can be wrong.** It is conservative by design; a
  heavily compressed thumbnail may be missed. A wrong blur is reversible with one click.
- **Only the first 8 visible images per page are scored**, and only images at least
  180×120. That keeps the free tier usable and avoids scoring avatars, icons, and banners.
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
