const toggle = document.getElementById("toggle");
const statusEl = document.getElementById("status");
let active = false;

function setUi(isActive, note) {
  active = isActive;
  toggle.textContent = isActive ? "Stop subtitles" : "Start subtitles";
  toggle.classList.toggle("active", isActive);
  if (note !== undefined) statusEl.textContent = note;
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "popup-status" }).catch(() => null);
  setUi(Boolean(res?.capturingTabId), "");
}

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  statusEl.textContent = active ? "Stopping…" : "Starting…";
  const type = active ? "popup-stop" : "popup-start";
  const res = await chrome.runtime.sendMessage({ type }).catch((e) => ({ ok: false, error: String(e) }));
  toggle.disabled = false;
  if (res?.ok) {
    const note = active ? "" : res.mode === "text"
      ? "Watching TVer's Japanese captions."
      : "Listening — play the video.";
    setUi(!active, note);
  }
  else setUi(active, res?.error || "Failed.");
});

document.getElementById("opts").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
