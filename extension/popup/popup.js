/* Sift — popup */

const toggle = document.getElementById("toggle");
const status = document.getElementById("status");

async function render() {
  try {
    const state = await chrome.runtime.sendMessage({ type: "getState" });
    toggle.checked = Boolean(state.enabled && state.blurImages);
    const n = state.stats ? state.stats.images : 0;
    status.textContent = n
      ? `${n} ${n === 1 ? "picture" : "pictures"} blurred this week`
      : "No pictures blurred yet this week";
  } catch {
    status.textContent = "Sift is waking up. Try again.";
  }
}

toggle.addEventListener("change", async () => {
  const on = toggle.checked;
  await chrome.runtime.sendMessage({
    type: "setSettings",
    patch: { enabled: on, blurImages: on }
  });
  render();
});

render();
