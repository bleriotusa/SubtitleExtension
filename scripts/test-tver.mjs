import assert from "node:assert/strict";
import { parseWebVtt } from "../src/tver/vtt.js";
import {
  normalizeSubtitlePunctuation,
  translateTverCues,
} from "../src/tver/translator.js";

const cues = parseWebVtt(`WEBVTT
X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000

00:00:35.066 --> 00:00:37.066 line:83%
<c.fgc-7.bgc-65>(男)これでいい</c>

00:02:14.033 --> 00:02:16.594
<c.fgc-3>あっ どうも</c>
`);

assert.deepEqual(cues, [
  { id: 0, start: 35.066, end: 37.066, text: "(男)これでいい" },
  { id: 1, start: 134.033, end: 136.594, text: "あっ どうも" },
]);

const originalFetch = globalThis.fetch;
let request;
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(init.body);
  return new Response(JSON.stringify({
    status: "completed",
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          translations: [
            { id: 0, text: "This will do." },
            { id: 1, text: "Oh, hello." },
          ],
        }),
      }],
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

try {
  const translated = await translateTverCues({
    textTranslation: {
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-5.6-terra",
      batchSize: 30,
    },
    openaiRealtime: { mode: "openai", apiKey: "" },
  }, cues);

  assert.deepEqual(translated, [
    { id: 0, text: "This will do" },
    { id: 1, text: "Oh, hello" },
  ]);
  assert.equal(request.model, "gpt-5.6-terra");
  assert.deepEqual(request.reasoning, { effort: "none" });
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);

  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer sk-or-test");
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            translations: [
              { id: 0, text: "That should work." },
              { id: 1, text: "Oh, hello." },
            ],
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const openrouterTranslated = await translateTverCues({
    textTranslation: {
      provider: "openrouter",
      openrouterModel: "anthropic/claude-haiku-4.5",
      batchSize: 30,
    },
    openrouter: {
      apiKey: "sk-or-test",
      model: "fallback/model",
      baseUrl: "https://openrouter.ai/api/v1",
    },
  }, cues);

  assert.deepEqual(openrouterTranslated, [
    { id: 0, text: "That should work" },
    { id: 1, text: "Oh, hello" },
  ]);
  assert.equal(request.model, "anthropic/claude-haiku-4.5");
  assert.equal(request.response_format.type, "json_schema");
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.provider.require_parameters, true);

  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              translations: [
                { id: 0, text: "This should be fine." },
                { id: 1, text: "Oh, hi." },
              ],
            }),
          }],
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const geminiTranslated = await translateTverCues({
    textTranslation: {
      provider: "gemini",
      geminiApiKey: "test-google-key",
      geminiModel: "gemini-3.5-flash-lite",
      batchSize: 30,
    },
    geminiLive: { apiKey: "" },
  }, cues);

  assert.deepEqual(geminiTranslated, [
    { id: 0, text: "This should be fine" },
    { id: 1, text: "Oh, hi" },
  ]);
  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.equal(request.generationConfig.responseJsonSchema.type, "object");

  globalThis.fetch = async (url, init) => {
    assert.match(url, /^https:\/\/api-free\.deepl\.com\//);
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({
      translations: [
        { text: "This is fine." },
        { text: "Oh, hello." },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const deeplTranslated = await translateTverCues({
    textTranslation: {
      provider: "deepl",
      deeplApiKey: "test-key:fx",
      batchSize: 30,
    },
  }, cues);

  assert.deepEqual(deeplTranslated, [
    { id: 0, text: "This is fine" },
    { id: 1, text: "Oh, hello" },
  ]);
  assert.equal(request.source_lang, "JA");
  assert.equal(request.target_lang, "EN-US");
  assert.match(request.context, /これでいい/);
  assert.equal(normalizeSubtitlePunctuation("本当？", "Really?"), "Really?");
  assert.equal(normalizeSubtitlePunctuation("「そうだ」", "\"That's right.\""), "\"That's right\"");
  assert.equal(normalizeSubtitlePunctuation("まさか", "No..."), "No...");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("TVer parser and translation request tests passed.");
