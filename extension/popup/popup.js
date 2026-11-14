/* Sift — popup */

const $ = (id) => document.getElementById(id);

const toggle = $("toggle");
const siteRow = $("site-row");
const siteName = $("site-name");
const siteSub = $("site-sub");
const siteToggle = $("site-toggle");
const stateText = $("state-text");
const status = $("status");
const turnOn = $("turn-on");

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(reply);
      });
    } catch {
      resolve(null);
    }
  });
}

async function getState() {
  const reply = await send({ type: "getState" });
  return reply && typeof reply === "object" ? reply : null;
}

async function getDisabledSites() {
  try {
    const stored = await chrome.storage.local.get("disabledSites");
    return Array.isArray(stored.disabledSites) ? stored.disabledSites : [];
  } catch {
    return [];
  }
}

/* activeTab grants the popup the current tab's URL when the popup opens */
async function activeOrigin() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/.test(tab.url)) {
      return new URL(tab.url).origin;
    }
  } catch {
    /* no tab access; hide the site row */
  }
  return null;
}

function prettyHost(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch {
    return origin;
  }
}

async function render() {
  const state = await getState();
  // Match the background default: on unless the reader turned it off.
  const enabled = state ? Boolean(state.enabled ?? true) && state.blurImages !== false : true;

  document.body.classList.toggle("on", enabled);
  document.body.classList.toggle("off", !enabled);
  stateText.textContent = enabled ? "On — checking every image" : "Off";
  toggle.checked = enabled;

  const n = state && state.stats ? state.stats.images : 0;
  const p = state && state.stats ? state.stats.pages : 0;
  status.textContent = n
    ? `${n} ${n === 1 ? "picture" : "pictures"} blurred this week · ${p} ${p === 1 ? "page" : "pages"} checked`
    : p
      ? `${p} ${p === 1 ? "page" : "pages"} checked this week — no pictures blurred yet`
      : "No pictures blurred yet this week";

  const origin = await activeOrigin();
  if (!origin) {
    siteRow.hidden = true;
    return;
  }

  const paused = (await getDisabledSites()).includes(origin);

  siteRow.hidden = false;
  siteName.textContent = prettyHost(origin);
  siteToggle.disabled = !enabled;
  siteToggle.checked = enabled && !paused;
  siteSub.textContent = !enabled
    ? "Turn Sift on first"
    : paused
      ? "Paused here — nothing is checked on this site"
      : "Sift checks every image here";
}

toggle.addEventListener("change", async () => {
  const on = toggle.checked;
  await send({ type: "setSettings", patch: { enabled: on, blurImages: on } });
  render();
});

siteToggle.addEventListener("change", async () => {
  const origin = siteRow.dataset.origin;
  if (!origin) return;

  const list = await getDisabledSites();
  const next = siteToggle.checked
    ? list.filter((o) => o !== origin)
    : [...new Set([...list, origin])];

  await send({ type: "setSettings", patch: { disabledSites: next } });
  render();
});

turnOn.addEventListener("click", async () => {
  await send({ type: "setSettings", patch: { enabled: true, blurImages: true } });
  render();
});

async function boot() {
  const origin = await activeOrigin();
  if (origin) siteRow.dataset.origin = origin;
  render();
}

boot();
