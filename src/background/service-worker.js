// Background coordinator. The service worker is the only context that can call
// tabCapture.getMediaStreamId and manage the offscreen document, and it relays
// subtitle lines from the offscreen capture engine to the page's overlay.
//
// State that must survive a service-worker restart lives in chrome.storage
// .session; the actual capture keeps running in the offscreen document.

import { getConfig } from "../config.js";
import { parseWebVtt } from "../tver/vtt.js";
import { translateTverCues } from "../tver/translator.js";

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
    case "tver-caption-track":
      loadTverTrack(msg.url, sender.tab?.id)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    case "tver-translate-batch":
      translateTverBatch(msg, sender.tab?.id)
        .then((translations) => sendResponse({ ok: true, translations }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
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

  const config = await getConfig();
  if (isTverUrl(tab.url)) {
    const textProvider = config.textTranslation.provider || "openai";
    const textKey = config.textTranslation.apiKey ||
      (config.openaiRealtime.mode === "openai" ? config.openaiRealtime.apiKey : "");
    const geminiKey = config.textTranslation.geminiApiKey || config.geminiLive.apiKey;
    if (textProvider === "openrouter" && !config.openrouter.apiKey) {
      throw new Error(
        "OpenRouter API key not set for TVer text translation (open extension Settings)."
      );
    }
    if (textProvider === "openai" && !textKey) {
      throw new Error(
        "OpenAI API key not set for TVer text translation (open extension Settings)."
      );
    }
    if (textProvider === "gemini" && !geminiKey) {
      throw new Error(
        "Gemini API key not set for TVer text translation (open extension Settings)."
      );
    }
    if (textProvider === "deepl" && !config.textTranslation.deeplApiKey) {
      throw new Error(
        "DeepL API key not set for TVer text translation (open extension Settings)."
      );
    }
    if (!["openai", "openrouter", "gemini", "deepl", "edge"].includes(textProvider)) {
      throw new Error(`Unknown TVer text-translation engine: ${textProvider}`);
    }
    await chrome.storage.session.set({ [SESSION_KEY]: tab.id });
    notifyOverlay(tab.id, { type: "qqls-status", active: true, mode: "text" });
    return { ok: true, tabId: tab.id, mode: "text" };
  }

  // tabCapture must be triggered from the active tab (the popup click is the gesture).
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  // Read config here — service workers have guaranteed chrome.storage access.
  // Passing it avoids any storage API availability questions in the offscreen doc.
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "start-capture", streamId, config });
  if (!res?.ok) throw new Error(res?.error || "Offscreen failed to start capture.");

  await chrome.storage.session.set({ [SESSION_KEY]: tab.id });
  notifyOverlay(tab.id, { type: "qqls-status", active: true });
  return { ok: true, tabId: tab.id };
}

async function loadTverTrack(url, senderTabId) {
  await assertActiveTverSender(senderTabId);
  const parsedUrl = new URL(url);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "tracks.streaks.jp" ||
    !parsedUrl.pathname.toLowerCase().endsWith(".vtt") ||
    parsedUrl.pathname.toLowerCase().endsWith("/thumbnails.vtt")
  ) {
    throw new Error("Rejected an unexpected TVer caption-track URL.");
  }

  const res = await fetch(parsedUrl.href, { credentials: "omit" });
  if (!res.ok) throw new Error(`Could not load TVer captions (HTTP ${res.status}).`);
  const cues = parseWebVtt(await res.text());
  if (!cues.length) throw new Error("TVer caption track contained no readable cues.");
  const config = await getConfig();
  const batchSize = Math.max(10, Math.min(60, config.textTranslation.batchSize || 30));
  return { cues, batchSize, provider: config.textTranslation.provider || "openai" };
}

async function translateTverBatch(msg, senderTabId) {
  await assertActiveTverSender(senderTabId);
  const config = await getConfig();
  const maxBatch = Math.max(10, Math.min(60, config.textTranslation.batchSize || 30));
  const cues = Array.isArray(msg.cues) ? msg.cues.slice(0, maxBatch) : [];
  if (!cues.length) return [];
  return translateTverCues(config, cues, Array.isArray(msg.context) ? msg.context : []);
}

async function assertActiveTverSender(senderTabId) {
  if (!senderTabId || senderTabId !== await getCapturingTabId()) {
    throw new Error("TVer caption request did not come from the active subtitle tab.");
  }
  const tab = await chrome.tabs.get(senderTabId);
  if (!isTverUrl(tab.url)) throw new Error("Active subtitle tab is not a TVer page.");
}

function isTverUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "tver.jp" || host.endsWith(".tver.jp");
  } catch {
    return false;
  }
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
