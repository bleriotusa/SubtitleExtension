# QQ Live Subtitles (Chinese → English)

A Microsoft Edge / Chromium extension (Manifest V3) that overlays **live English
subtitles** on Chinese video playing at **v.qq.com**. It captures the tab's audio,
sends it to a pluggable transcription/translation backend, and draws the result
over the player. Built for watching Chinese reality shows on macOS, where there is
no native live transcription.

## How it works

```
tab audio ──tabCapture──▶ offscreen document
                              │  ├─ re-routes audio back to speakers (capture alone mutes the tab)
                              │  └─ AudioWorklet → 16 kHz mono PCM frames
                              ▼
                        SubtitleProvider (swappable)
                              ▼
                     service worker ──▶ content-script overlay (English subtitles)
```

The whole backend sits behind one interface — [`SubtitleProvider`](src/providers/SubtitleProvider.js) —
so you can swap backends from the options page without touching capture or overlay.

### Backends

| Backend | Latency | Key | Notes |
|---|---|---|---|
| **OpenRouter (batch)** — default | ~2–3s | your OpenRouter key | Gemini 3.1 Flash Lite; one call transcribes **and** translates. Also accepts Groq Whisper model ids. |
| **OpenAI Realtime Translate (streaming)** | ~1s | OpenAI **or** Azure key | `gpt-realtime-translate` — purpose-built live translator, audio in → English text out. ~$0.034/min. Most mature streaming option; switchable between OpenAI-direct and your Azure Foundry deployment. |
| **Gemini Live (streaming)** | ~1s | **direct Google key** | Websocket, partial captions that refine in place. OpenRouter has no streaming, so this path bills Google directly. |

> **Why no ~1s on OpenRouter?** OpenRouter's speech endpoints are batch-only. With
> batch you must wait for an audio chunk to accumulate before sending, so end-to-end
> lag floors around 2–3s for good quality. True ~1s needs a streaming websocket API
> (Gemini Live / OpenAI Realtime), which is the streaming backend.

## Quick start

1. **Validate a model first (optional but recommended).** Grab a ~30s WAV from the
   show and run the spike — no extension needed:
   ```bash
   OPENROUTER_API_KEY=sk-or-... node scripts/spike.mjs clip.wav
   ```
   Check the English quality and the round-trip time before investing in setup.

2. **Load the extension in Edge:**
   - Go to `edge://extensions` (or `chrome://extensions`).
   - Enable **Developer mode**.
   - Click **Load unpacked** and select this folder.

3. **Add your key:** click the extension icon → **Settings**, pick a backend, paste
   the API key, Save.

4. **Watch:** open a video on `v.qq.com`, click the extension icon → **Start
   subtitles**, then press play. English subtitles appear over the player.

## Tuning

All defaults live in [`src/config.js`](src/config.js) and are overridable from the
options page: backend, model, `chunkMs` (lag vs accuracy for batch), silence/VAD
thresholds, and subtitle font size.

## Notes & limitations

- **DRM is fine.** `tabCapture` grabs post-decode audio, so QQ's protected video
  still works.
- **API key ships client-side.** Fine for personal use; proxy through a small
  backend if you ever distribute this.
- **Gemini Live is preview.** Its websocket message shapes shift between versions;
  [`GeminiLiveProvider`](src/providers/GeminiLiveProvider.js) is a working starting
  point you may need to tune against current docs.
- **Fullscreen:** the overlay re-attaches into the fullscreen element so it stays
  visible.

## Adding a backend

Implement [`SubtitleProvider`](src/providers/SubtitleProvider.js) and register it in
[`src/providers/index.js`](src/providers/index.js). It becomes selectable in the
options page automatically — capture and overlay need no changes.
