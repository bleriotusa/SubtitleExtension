#!/usr/bin/env node
// Phase-1 spike: validate model quality + round-trip BEFORE building any UI.
//
// Grab a short WAV clip from the show (16 kHz mono is ideal) and run it through
// the backend you're considering. Eyeball the English and the timing.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... node scripts/spike.mjs clip.wav
//   OPENROUTER_API_KEY=sk-or-... node scripts/spike.mjs clip.wav --model google/gemini-3.1-flash-lite
//   OPENROUTER_API_KEY=sk-or-... node scripts/spike.mjs clip.wav --whisper openai/gpt-4o-mini-transcribe
//
// --whisper uses OpenRouter's /audio/transcriptions endpoint (transcription only,
// no translation). The default chat path transcribes AND translates in one call.

import fs from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const model = argVal("--model") || "google/gemini-3.1-flash-lite";
const whisperModel = argVal("--whisper");
const apiKey = process.env.OPENROUTER_API_KEY;
const base = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

if (!file || !apiKey) {
  console.error("Usage: OPENROUTER_API_KEY=... node scripts/spike.mjs <clip.wav> [--model id] [--whisper id]");
  process.exit(1);
}

const b64 = fs.readFileSync(file).toString("base64");

async function chatTranslate() {
  const prompt =
    "Transcribe this Mandarin Chinese speech and translate it into natural, concise " +
    "English subtitles. Output ONLY the English subtitle text.";
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      reasoning: { enabled: false },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "input_audio", input_audio: { data: b64, format: "wav" } },
        ],
      }],
    }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = await res.json();
  console.log(`\n[chat translate · ${model}]  ${ms}ms`);
  console.log(json?.choices?.[0]?.message?.content?.trim() || "(empty)");
}

async function whisperTranscribe() {
  const t0 = Date.now();
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: whisperModel, audio: { data: b64, format: "wav" }, language: "zh" }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = await res.json();
  console.log(`\n[transcribe · ${whisperModel}]  ${ms}ms`);
  console.log((json?.text || JSON.stringify(json)).trim());
}

try {
  if (whisperModel) await whisperTranscribe();
  else await chatTranslate();
} catch (e) {
  console.error("Spike failed:", e.message);
  process.exit(1);
}
