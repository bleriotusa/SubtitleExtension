# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 browser extension (Edge/Chromium) that overlays **live English subtitles**
on Chinese video at `v.qq.com`. It captures tab audio, sends it to a pluggable
transcription/translation backend, and renders the result over the player.

There is **no build step, no bundler, no package.json, and no test framework.** The
source is plain ES modules loaded directly by the browser. You ship it by loading the
folder unpacked.

## Commands

- **Load/run:** `edge://extensions` (or `chrome://extensions`) → enable Developer mode →
  **Load unpacked** → select the repo root. After editing source, click the reload icon
  on the extension card; reload the `v.qq.com` tab too if you changed the content script.
- **Validate a backend without the extension** (the only CLI here):
  ```bash
  OPENROUTER_API_KEY=sk-or-... node scripts/spike.mjs clip.wav [--model id] [--whisper id]
  ```
  Runs a WAV clip through the OpenRouter chat path (transcribe+translate) or, with
  `--whisper`, the transcription-only endpoint. Use it to eyeball English quality and
  round-trip latency before touching the extension. `*.wav/*.mp3/*.flac` are gitignored.
- **Debugging:** the offscreen document and service worker each have their own DevTools
  console (via `chrome://extensions` → "service worker" / "Inspect views"). Most runtime
  logging lands there, not in the page console.

## Architecture

Audio flows through four isolated MV3 contexts. The key constraint driving the whole
design: **an MV3 service worker cannot hold a MediaStream or AudioContext**, so capture
lives in an offscreen document.

```
popup ──"popup-start"──▶ service-worker ──getMediaStreamId──▶ offscreen document
                              │                                    │
                              │                          tabCapture stream
                              │                          ├─ reconnect to speakers
                              │                          │   (capture alone mutes tab)
                              │                          └─ AudioWorklet → PCM frames
                              │                                    │
                              │                          SubtitleProvider (swappable)
                              │                                    │
                              ◀────"subtitle" line────────────────┘
                              │
                  chrome.tabs.sendMessage ──▶ content overlay (English text on player)
```

- [src/background/service-worker.js](src/background/service-worker.js) — the only context
  that can call `tabCapture.getMediaStreamId` and manage the offscreen document. Owns
  start/stop, relays subtitle lines to the overlay. Capture-in-progress state lives in
  `chrome.storage.session` (key `qqls.capturingTabId`) so it survives a worker restart.
  **`startForActiveTab` always calls `stop()` first** — a prior half-open capture holds the
  tab and makes `getMediaStreamId` reject with "active stream."
- [src/offscreen/offscreen.js](src/offscreen/offscreen.js) — the capture engine. Turns the
  streamId into a MediaStream, **reconnects it to `audioCtx.destination` so the tab stays
  audible** (capturing silences it), builds the provider, and pumps audio in. On any error
  it tears the stream down fully so the next Start gets a clean tab.
- [src/audio/worklet.js](src/audio/worklet.js) — runs in the AudioWorkletGlobalScope.
  Mixes to mono, downsamples context rate (usually 48 kHz) → the provider's `inputSampleRate`
  via averaging-decimation (carrying the fractional remainder to keep the rate exact),
  emits ~200 ms Int16 frames.
- [src/content/overlay.js](src/content/overlay.js) — **a classic content script, NOT a
  module.** It can't `import`, so config defaults are inlined and overrides are read
  straight from `chrome.storage.local`. Reattaches into `document.fullscreenElement` on
  fullscreen change so subtitles stay visible.

### The provider abstraction

Everything backend-specific sits behind [src/providers/SubtitleProvider.js](src/providers/SubtitleProvider.js).
Swapping backends never touches capture, chunking, or overlay code.

- A provider emits subtitle lines `{ text, isFinal, tStart }`. `isFinal:false` is a partial
  that **replaces** the current live line (streaming providers refine in place); `isFinal:true`
  commits it and starts a new line. The overlay renders to exactly this contract.
- Two static flags on the class change how the offscreen engine drives it:
  - `inputSampleRate` (Hz) — what rate the worklet downsamples to (16 kHz default;
    OpenAI realtime wants 24 kHz).
  - `wantsMediaStream` — if `true`, the provider gets the raw `{ stream }` in `start()` and
    the PCM worklet/`pushAudio` path is **skipped entirely** (used by the WebRTC provider,
    which feeds audio over its own peer connection).
- **To add a backend:** implement `SubtitleProvider`, register it in
  [src/providers/index.js](src/providers/index.js). It becomes selectable in the options
  page automatically.

Current providers (see [src/providers/index.js](src/providers/index.js)):
| Key | Transport | Notes |
|---|---|---|
| `openai-webrtc` (default) | WebRTC | OpenAI **or** Azure; the recommended client-side realtime path. ~1s. |
| `openrouter-batch` | HTTPS batch | Gemini Flash Lite; one call transcribes **and** translates. ~2–3s. |
| `openai-realtime` | WebSocket | Server-to-server realtime; browser WS to Azure gets 1006-rejected. |
| `gemini-live` | WebSocket | Direct Google key; preview, message shapes drift between versions. |

### Config

[src/config.js](src/config.js) holds `DEFAULT_CONFIG` and `getConfig()`/`setConfig()`. The
options page writes overrides to `chrome.storage.local` under `qqls.config`; `getConfig()`
shallow-merges the top level and **deep-merges the per-provider blocks**. The service worker
reads config once at Start and passes the resolved object to the offscreen doc, so providers
never touch storage. The active provider is `config.provider`; only its matching settings
block (`openrouter` / `geminiLive` / `openaiRealtime`) is used.

## Conventions & gotchas

- **No imports in the content script** — it's not a module. Anything it needs is inlined.
- Cross-context messages are plain `{ type, ... }` objects. Offscreen-bound messages also
  carry `target: "offscreen"`; the offscreen listener ignores anything without it.
- The WebRTC provider's Azure path **probes** host aliases (`*.openai.azure.com` vs
  `*.services.ai.azure.com`) and session types because Foundry deployment routing is
  undocumented and varies — see the comments in
  [src/providers/OpenAIWebRTCProvider.js](src/providers/OpenAIWebRTCProvider.js). The recent
  git history is mostly iterating on this routing. Treat those specifics as empirical, not
  spec-backed.
- API keys ship client-side. Fine for personal use, which is the stated scope; proxy through
  a backend before distributing.
- `host_permissions` in [manifest.json](manifest.json) gate which API hosts the extension can
  reach. A new backend on a new host needs a matching entry there.
