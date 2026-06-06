// Background coordinator. The service worker is the only context that can call
// tabCapture.getMediaStreamId and manage the offscreen document, and it relays
// subtitle lines from the offscreen capture engine to the page's overlay.
//
// State that must survive a service-worker restart lives in chrome.storage
// .session; the actual capture keeps running in the offscreen document.

import { getConfig } from "../config.js";

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";
const SESSION_KEY = "qqls.capturingTabId";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case "popup-start":
      startForActiveTab().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    case "popup-stop":
      stop().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    case "popup-status":
      getCapturingTabId().then((id) => sendResponse({ ok: true, capturingTabId: id })).catch(() => sendResponse({ ok: true, capturingTabId: null }));
      return true;
    case "subtitle":
      relaySubtitle(msg.line);
      return false; // fire and forget
    default:
      return false;
  }
});

async function startForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");

  // Release any prior capture first. A previous failed start can leave the tab's
  // audio stream held by the offscreen doc; getMediaStreamId then rejects with
  // "Cannot capture a tab with an active stream." Closing the offscreen document
  // frees the stream so we always begin from a clean slate.
  await stop();

  // tabCapture must be triggered from the active tab (the popup click is the gesture).
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  // Read config here — service workers have guaranteed chrome.storage access.
  // Passing it avoids any storage API availability questions in the offscreen doc.
  const config = await getConfig();

  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "start-capture", streamId, config });
  if (!res?.ok) throw new Error(res?.error || "Offscreen failed to start capture.");

  await chrome.storage.session.set({ [SESSION_KEY]: tab.id });
  notifyOverlay(tab.id, { type: "qqls-status", active: true });
  return { ok: true, tabId: tab.id };
}

async function stop() {
  const tabId = await getCapturingTabId();
  try {
    if (await hasOffscreen()) {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "stop-capture" });
    }
  } finally {
    await closeOffscreen();
    await chrome.storage.session.remove(SESSION_KEY);
    if (tabId) notifyOverlay(tabId, { type: "qqls-status", active: false });
  }
}

async function relaySubtitle(line) {
  const tabId = await getCapturingTabId();
  if (tabId) notifyOverlay(tabId, { type: "qqls-subtitle", line });
}

function notifyOverlay(tabId, payload) {
  chrome.tabs.sendMessage(tabId, payload).catch(() => {
    // Overlay content script may not be present on this frame/page — ignore.
  });
}

async function getCapturingTabId() {
  const v = await chrome.storage.session.get(SESSION_KEY);
  return v?.[SESSION_KEY] ?? null;
}

// --- offscreen document management -----------------------------------------

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio for live transcription/translation.",
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch { /* ignore */ }
  }
}

// If the captured tab closes, tear everything down.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getCapturingTabId()) === tabId) await stop();
});
