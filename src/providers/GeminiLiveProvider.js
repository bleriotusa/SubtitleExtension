// Opt-in streaming backend for ~1s latency.
//
// IMPORTANT: this talks DIRECTLY to Google's Gemini Live API over a websocket.
// OpenRouter has no streaming endpoint, so this path needs its own Google AI
// Studio key (config.geminiLive.apiKey), NOT your OpenRouter key.
//
// It streams PCM frames continuously and reads the model's TEXT turn as English
// translation, emitting partials (isFinal:false) that refine in place and a
// final (isFinal:true) on turnComplete. The Live API surface is still preview
// and message shapes shift between versions — treat this as a working starting
// point you may need to tune against the current docs.

import { SubtitleProvider } from "./SubtitleProvider.js";
import { arrayBufferToBase64 } from "../audio/pcm.js";

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export class GeminiLiveProvider extends SubtitleProvider {
  constructor(config) {
    super(config);
    this._ws = null;
    this._ready = false;
    this._pending = []; // base64 audio queued until setupComplete
    this._partial = "";
    this._tTurnStart = 0;
  }

  async start() {
    const { apiKey, model } = this.config.geminiLive;
    if (!apiKey) throw new Error("Gemini (Google AI) API key not set — the streaming backend needs its own direct key.");

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}?key=${encodeURIComponent(apiKey)}`);
      this._ws = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        ws.send(JSON.stringify({
          setup: {
            model,
            generationConfig: { responseModalities: ["TEXT"] },
            systemInstruction: {
              parts: [{
                text:
                  `You are a live subtitle translator. The user audio is ${this.config.sourceLangHint}. ` +
                  `Continuously translate it into concise, natural ${this.config.targetLang} subtitles. ` +
                  `Output ONLY the ${this.config.targetLang} text, no notes or labels.`,
              }],
            },
            inputAudioTranscription: {},
            realtimeInputConfig: { automaticActivityDetection: {} },
          },
        }));
      };

      ws.onmessage = async (ev) => {
        const msg = await parseWsMessage(ev.data);
        if (!msg) return;
        if (msg.setupComplete) {
          this._ready = true;
          for (const data of this._pending) this._sendAudio(data);
          this._pending = [];
          resolve();
          return;
        }
        this._handleServerContent(msg.serverContent);
      };

      ws.onerror = (e) => {
        if (!this._ready) reject(new Error("Gemini Live websocket error"));
        else console.error("[GeminiLive] ws error", e);
      };
      ws.onclose = () => { this._ready = false; };
    });
  }

  pushAudio(int16) {
    if (!int16.length || !this._ws) return;
    const b64 = arrayBufferToBase64(int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength));
    if (this._ready) this._sendAudio(b64);
    else this._pending.push(b64);
  }

  _sendAudio(b64) {
    this._ws.send(JSON.stringify({
      realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: b64 }] },
    }));
  }

  _handleServerContent(sc) {
    if (!sc) return;
    const parts = sc.modelTurn?.parts ?? [];
    const text = parts.map((p) => p.text || "").join("");
    if (text) {
      if (!this._partial) this._tTurnStart = performance.now();
      this._partial += text;
      this._splitLongLine();
      if (this._partial.trim()) {
        this._emit({ text: this._partial.trim(), isFinal: false, tStart: this._tTurnStart });
      }
    }
    if (sc.turnComplete) {
      if (this._partial.trim()) {
        this._emit({ text: this._partial.trim(), isFinal: true, tStart: this._tTurnStart });
      }
      this._partial = "";
    }
  }

  // Continuous TV audio can keep one Live "turn" open for a long time, so the
  // line would grow into a paragraph. Commit finished sentences once the next
  // one has a few words (so the reader isn't cut off), and hard-wrap run-ons.
  _splitLongLine() {
    const boundary = lastSentenceEnd(this._partial);
    if (boundary > 0 && this._partial.slice(boundary).trim().length >= MIN_NEXT_CHARS) {
      this._commit(boundary);
    } else if (this._partial.trim().length > MAX_LINE_CHARS) {
      const space = this._partial.lastIndexOf(" ", MAX_LINE_CHARS);
      this._commit(space > MAX_LINE_CHARS / 2 ? space : MAX_LINE_CHARS);
    }
  }

  _commit(index) {
    const done = this._partial.slice(0, index).trim();
    if (done) this._emit({ text: done, isFinal: true, tStart: this._tTurnStart });
    this._partial = this._partial.slice(index);
    this._tTurnStart = performance.now();
  }

  async stop() {
    this._ready = false;
    try { this._ws?.close(); } catch { /* ignore */ }
    this._ws = null;
  }
}

const MIN_NEXT_CHARS = 15;
const MAX_LINE_CHARS = 110;

// Index just past the last sentence end (".", "!", "?", "。", ...) that has
// text after it, or -1.
function lastSentenceEnd(text) {
  const re = /[.!?…]+["'”’)\]]*\s+|[。！？]+[」』”’）)]*/g;
  let end = -1;
  for (const m of text.matchAll(re)) {
    if (m.index + m[0].length < text.length) end = m.index + m[0].length;
  }
  return end;
}

// Live API frames arrive as JSON, but may be delivered as a Blob/ArrayBuffer.
async function parseWsMessage(data) {
  try {
    let text;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (data instanceof Blob) text = await data.text();
    else return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
