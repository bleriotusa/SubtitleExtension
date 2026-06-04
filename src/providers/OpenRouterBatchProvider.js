// Default backend. Works today on a plain OpenRouter key.
//
// Strategy: buffer incoming PCM, cut a chunk on a trailing-silence gap (VAD) or
// when the chunk hits maxChunkMs, then POST that chunk to an audio-capable chat
// model. One call both transcribes the Mandarin and translates it to English,
// so reality-show slang/names get context-aware handling.
//
// Latency floor is ~chunkMs + round-trip (~2-3s for good quality). This backend
// cannot reach ~1s — that's what GeminiLiveProvider is for.

import { SubtitleProvider } from "./SubtitleProvider.js";
import { SAMPLE_RATE, rms, concatInt16, encodeWav, arrayBufferToBase64 } from "../audio/pcm.js";

export class OpenRouterBatchProvider extends SubtitleProvider {
  constructor(config) {
    super(config);
    this._buf = [];           // Int16Array frames awaiting a flush
    this._bufSamples = 0;
    this._silenceSamples = 0; // trailing-silence run length
    this._tChunkStart = 0;
    this._inflight = 0;
    this._seq = 0;            // ordering guard for out-of-order responses
    this._lastEmitted = -1;
  }

  async start() {
    const { apiKey } = this.config.openrouter;
    if (!apiKey) throw new Error("OpenRouter API key not set (open the extension options).");
    this._tChunkStart = performance.now();
  }

  pushAudio(int16) {
    if (!int16.length) return;
    if (this._buf.length === 0) this._tChunkStart = performance.now();
    this._buf.push(int16);
    this._bufSamples += int16.length;

    const c = this.config;
    const frameSilent = rms(int16) < c.silenceThreshold;
    this._silenceSamples = frameSilent ? this._silenceSamples + int16.length : 0;

    const ms = (this._bufSamples / SAMPLE_RATE) * 1000;
    const silenceMs = (this._silenceSamples / SAMPLE_RATE) * 1000;
    const hitMax = ms >= c.maxChunkMs;
    const naturalCut = ms >= c.chunkMs && silenceMs >= c.silenceHangoverMs;

    if (hitMax || naturalCut) this._flush();
  }

  async stop() {
    if (this._bufSamples > 0) this._flush();
    // Let any in-flight requests settle briefly so trailing captions land.
    const deadline = Date.now() + 4000;
    while (this._inflight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  _flush() {
    if (this._bufSamples === 0) return;
    const pcm = concatInt16(this._buf);
    const tStart = this._tChunkStart;
    this._buf = [];
    this._bufSamples = 0;
    this._silenceSamples = 0;

    // Skip near-silent chunks entirely — no point paying for "..."
    if (rms(pcm) < this.config.silenceThreshold) return;

    this._transcribe(pcm, tStart, this._seq++);
  }

  async _transcribe(pcm, tStart, seq) {
    this._inflight++;
    try {
      const text = await this._callModel(pcm);
      const clean = (text || "").trim();
      // Drop empties and stale responses that arrived after a later chunk.
      if (clean && seq > this._lastEmitted) {
        this._lastEmitted = seq;
        this._emit({ text: clean, isFinal: true, tStart });
      }
    } catch (e) {
      console.error("[OpenRouterBatch] transcribe failed", e);
    } finally {
      this._inflight--;
    }
  }

  async _callModel(pcm) {
    const { apiKey, model, baseUrl } = this.config.openrouter;
    const wav = encodeWav(pcm, SAMPLE_RATE);
    const b64 = arrayBufferToBase64(wav);

    const prompt =
      `Transcribe this ${this.config.sourceLangHint} speech and translate it into ` +
      `natural, concise ${this.config.targetLang} subtitles. Output ONLY the ` +
      `${this.config.targetLang} subtitle text — no quotes, no notes, no speaker ` +
      `labels. If there is no intelligible speech, output nothing.`;

    const body = {
      model,
      // Disable reasoning so TTFT stays low.
      reasoning: { enabled: false },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "input_audio", input_audio: { data: b64, format: "wav" } },
          ],
        },
      ],
    };

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "QQ Live Subtitles",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();
    return json?.choices?.[0]?.message?.content ?? "";
  }
}
