const TRANSLATION_INSTRUCTIONS =
  "Translate Japanese TV drama captions into natural, concise English subtitles. " +
  "Use prior context to resolve omitted subjects, names, sentence fragments, register, " +
  "jokes, and dramatic intent. Preserve plot details and do not censor. Return exactly " +
  "one result for every input cue, with the same integer id and in the same order. Do " +
  "not merge cues. Remove redundant speaker labels, but retain a short label when it is " +
  "needed to distinguish overlapping or off-screen speakers. Return an empty string for " +
  "music or sound-only cues; translate actual sung lyrics.";

const TRANSLATION_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          text: { type: "string" },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
};

export async function translateTverCues(config, cues, context = []) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const settings = config.textTranslation;
  const input = {
    prior_context: context.slice(-8).map(({ text, english }) => ({ text, english })),
    cues: cues.map(({ id, text }) => ({ id, text })),
  };

  let translations;
  if (settings.provider === "gemini") {
    translations = await translateWithGemini(config, input);
  } else if (settings.provider === "deepl") {
    translations = await translateWithDeepL(config, input);
  } else if (settings.provider === "edge") {
    throw new Error("Edge on-device translation must run in the TVer page.");
  } else {
    translations = await translateWithOpenAI(config, input);
  }
  return validateTranslations(translations, cues, settings.provider || "openai");
}

async function translateWithOpenAI(config, input) {
  const settings = config.textTranslation;
  const apiKey =
    settings.apiKey ||
    (config.openaiRealtime?.mode === "openai" ? config.openaiRealtime.apiKey : "");
  if (!apiKey) {
    throw new Error(
      "OpenAI API key not set for TVer text translation (open extension Settings)."
    );
  }
  if (!settings.model) throw new Error("OpenAI text-translation model is not set.");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      reasoning: { effort: "none" },
      store: false,
      instructions: TRANSLATION_INSTRUCTIONS,
      input: JSON.stringify(input),
      max_output_tokens: Math.max(1200, input.cues.length * 80),
      text: {
        format: {
          type: "json_schema",
          name: "subtitle_translations",
          strict: true,
          schema: TRANSLATION_SCHEMA,
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI text translation ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  const outputText = json.output
    ?.flatMap((item) => item.content || [])
    .find((part) => part.type === "output_text")
    ?.text;
  if (!outputText) {
    throw new Error(`OpenAI returned no translated text (status: ${json.status || "unknown"}).`);
  }
  return JSON.parse(outputText)?.translations;
}

async function translateWithGemini(config, input) {
  const settings = config.textTranslation;
  const apiKey = settings.geminiApiKey || config.geminiLive?.apiKey;
  if (!apiKey) {
    throw new Error(
      "Gemini API key not set for TVer text translation (open extension Settings)."
    );
  }
  if (!settings.geminiModel) throw new Error("Gemini text-translation model is not set.");

  const model = encodeURIComponent(settings.geminiModel);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: `${TRANSLATION_INSTRUCTIONS}\n\nInput:\n${JSON.stringify(input)}` }],
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: TRANSLATION_SCHEMA,
        },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Gemini text translation ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  const outputText = json.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("");
  if (!outputText) throw new Error("Gemini returned no translated text.");
  return JSON.parse(outputText)?.translations;
}

async function translateWithDeepL(config, input) {
  const apiKey = config.textTranslation.deeplApiKey;
  if (!apiKey) {
    throw new Error("DeepL API key not set for TVer text translation (open extension Settings).");
  }

  const translatable = input.cues.filter((cue) => !isSoundOnly(cue.text));
  if (!translatable.length) return input.cues.map((cue) => ({ id: cue.id, text: "" }));
  const context = [
    ...input.prior_context.map((item) => item.text),
    ...input.cues.map((item) => item.text),
  ].join("\n");
  const host = apiKey.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
  const res = await fetch(`https://${host}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: translatable.map((cue) => cue.text),
      source_lang: "JA",
      target_lang: "EN-US",
      context,
      split_sentences: "0",
      model_type: "prefer_quality_optimized",
    }),
  });
  if (!res.ok) {
    throw new Error(`DeepL text translation ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (!Array.isArray(json.translations) || json.translations.length !== translatable.length) {
    throw new Error("DeepL returned an invalid translation batch.");
  }
  const byId = new Map(
    translatable.map((cue, index) => [cue.id, json.translations[index]?.text || ""])
  );
  return input.cues.map((cue) => ({ id: cue.id, text: byId.get(cue.id) || "" }));
}

function isSoundOnly(text) {
  return /^[\s♬♪〜～ー…・]+$/.test(text);
}

function validateTranslations(translations, cues, provider) {
  if (!Array.isArray(translations)) {
    throw new Error(`${provider} returned an invalid translation batch.`);
  }
  const expected = new Set(cues.map((cue) => cue.id));
  const result = translations.filter(
    (item) =>
      Number.isInteger(item?.id) &&
      expected.has(item.id) &&
      typeof item.text === "string"
  );
  if (result.length !== cues.length || new Set(result.map((item) => item.id)).size !== cues.length) {
    throw new Error(`${provider} returned missing or duplicate caption cue ids.`);
  }
  return result;
}
