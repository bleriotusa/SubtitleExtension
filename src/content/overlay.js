// Subtitle overlay injected on QQ Video pages. Receives lines relayed by the
// service worker and renders them over the player.
//
// Rendering model mirrors the provider contract:
//   - isFinal:false  -> update the single live (italic) line in place
//   - isFinal:true   -> commit it; keep the last `maxLines` committed lines
//
// Classic content script (not a module), so config defaults are inlined and any
// overrides are read straight from chrome.storage.local.

(() => {
  // Bail out in sandboxed iframes where extension APIs aren't available.
  if (typeof chrome === "undefined" || !chrome.storage?.local || !chrome.runtime?.onMessage) return;

  const STORAGE_KEY = "qqls.config";
  const DEFAULTS = { fontSize: 28, maxLines: 2 };

  let root = null;
  let committed = []; // array of strings
  let partial = "";
  let settings = { ...DEFAULTS };

  chrome.storage.local.get(STORAGE_KEY).then((v) => {
    const o = v?.[STORAGE_KEY] ?? {};
    if (o.fontSize) settings.fontSize = o.fontSize;
    if (o.maxLines) settings.maxLines = o.maxLines;
    if (root) applySettings();
  });

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.createElement("div");
    root.id = "qqls-overlay";
    root.classList.add("qqls-hidden");
    attach();
    applySettings();
    return root;
  }

  function attach() {
    const host = document.fullscreenElement || document.body;
    if (root.parentElement !== host) host.appendChild(root);
  }

  function applySettings() {
    if (root) root.style.fontSize = `${settings.fontSize}px`;
  }

  function render() {
    if (!root) return;
    root.textContent = "";
    const lines = committed.slice(-settings.maxLines);
    for (const text of lines) {
      const el = document.createElement("div");
      el.className = "qqls-line";
      el.textContent = text;
      root.appendChild(el);
    }
    if (partial) {
      const el = document.createElement("div");
      el.className = "qqls-line qqls-partial";
      el.textContent = partial;
      root.appendChild(el);
    }
    root.classList.toggle("qqls-hidden", lines.length === 0 && !partial);
  }

  function addLine(line) {
    ensureRoot();
    if (line.isFinal) {
      committed.push(line.text);
      if (committed.length > 50) committed = committed.slice(-50);
      partial = "";
    } else {
      partial = line.text;
    }
    render();
  }

  function setActive(active) {
    if (active) {
      ensureRoot();
      committed = [];
      partial = "";
      render();
    } else if (root) {
      partial = "";
      root.classList.add("qqls-hidden");
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "qqls-subtitle") addLine(msg.line);
    else if (msg?.type === "qqls-status") setActive(msg.active);
  });

  // Keep the overlay inside the fullscreen element so it stays visible.
  document.addEventListener("fullscreenchange", () => {
    if (root) { attach(); render(); }
  });
})();
