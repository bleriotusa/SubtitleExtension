// The capture engine. Lives in the offscreen document because MV3 service
// workers can't hold a MediaStream or an AudioContext.
//
// Responsibilities:
//   1. Turn the service worker's streamId into a tab-audio MediaStream.
//   2. Re-route that audio back to the speakers (capturing a tab mutes it).
//   3. Feed PCM frames from the worklet into the active SubtitleProvider.
//   4. Relay emitted subtitle lines to the service worker (-> content overlay).

import { getConfig } from "../config.js";
import { createProvider } from "../providers/index.js";

let audioCtx = null;
let mediaStream = null;
let provider = null;
let workletNode = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "start-capture") {
    startCapture(msg.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // async response
  }
  if (msg.type === "stop-capture") {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});

async function startCapture(streamId) {
  if (mediaStream) await stopCapture();

  const config = await getConfig();

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: false,
  });

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);

  // (2) Keep the tab audible — capturing alone silences playback.
  source.connect(audioCtx.destination);

  // (3) Tap PCM for the provider.
  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("src/audio/worklet.js"));
  workletNode = new AudioWorkletNode(audioCtx, "capture-processor");
  source.connect(workletNode);
  // Worklet output isn't routed to speakers; connecting to destination keeps
  // some browsers from garbage-collecting the node.
  workletNode.connect(audioCtx.destination);

  provider = createProvider(config);
  provider.onSubtitle((line) => {
    chrome.runtime.sendMessage({ type: "subtitle", line }).catch(() => {});
  });
  await provider.start();

  workletNode.port.onmessage = (ev) => {
    // ev.data is an Int16Array frame (16 kHz mono, ~200ms).
    try {
      provider?.pushAudio(ev.data);
    } catch (e) {
      console.error("[offscreen] pushAudio failed", e);
    }
  };

  console.log("[offscreen] capture started:", config.provider);
}

async function stopCapture() {
  try { await provider?.stop(); } catch (e) { console.error(e); }
  provider = null;

  if (workletNode) { try { workletNode.disconnect(); } catch {} workletNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioCtx) { try { await audioCtx.close(); } catch {} audioCtx = null; }

  console.log("[offscreen] capture stopped");
}
