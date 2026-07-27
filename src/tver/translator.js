const LANGUAGE_NAMES = {
  en: "English",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  "pt-BR": "Brazilian Portuguese",
};

const DEEPL_TARGET_CODES = {
  en: "EN-US",
  "zh-Hans": "ZH-HANS",
  "zh-Hant": "ZH-HANT",
  ko: "KO",
  es: "ES",
  fr: "FR",
  de: "DE",
  "pt-BR": "PT-BR",
};

function translationInstructions(primaryTarget, secondaryTarget) {
  const primaryName = languageName(primaryTarget);
  const secondaryName = secondaryTarget ? languageName(secondaryTarget) : "";
  const targetInstruction = secondaryTarget
    ? `Translate every cue twice: put the natural ${primaryName} translation in text and the natural ${secondaryName} translation in secondaryText. `
    : `Put the natural ${primaryName} translation in text and return an empty string in secondaryText. `;
  return (
    "Translate Japanese TV drama captions into natural, concise subtitles. " +
    targetInstruction +
    "Use prior context to resolve omitted subjects, names, sentence fragments, register, " +
    "jokes, and dramatic intent. Preserve plot details and do not censor. Return exactly " +
    "one result for every input cue, with the same integer id and in the same order. Do " +
    "not merge cues. Remove redundant speaker labels, but retain a short label when it is " +
    "needed to distinguish overlapping or off-screen speakers. Match the source cue's " +
    "terminal punctuation; do not add a period when the source has no sentence-ending " +
    "punctuation. Return an empty string for music or sound-only cues; translate actual " +
    "sung lyrics."
  );
}

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
          secondaryText: { type: "string" },
        },
        required: ["id", "text", "secondaryText"],
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
  const { primaryTarget, secondaryTarget } = translationTargets(settings);
  const instructions = translationInstructions(primaryTarget, secondaryTarget);
  const input = {
    prior_context: context.slice(-8).map(({ text, primary, secondary, english }) => ({
      source: text,
      primary: primary || english || "",
      secondary: secondary || "",
    })),
    cues: cues.map(({ id, text }) => ({ id, text })),
  };

  let translations;
  if (settings.provider === "openrouter") {
    translations = await translateWithOpenRouter(config, input, instructions);
  } else if (settings.provider === "gemini") {
    translations = await translateWithGemini(config, input, instructions);
  } else if (settings.provider === "deepl") {
    translations = await translateWithDeepL(
      config,
      input,
      primaryTarget,
      secondaryTarget
    );
  } else if (settings.provider === "edge") {
    throw new Error("Edge on-device translation must run in the TVer page.");
  } else {
    translations = await translateWithOpenAI(config, input, instructions);
  }
  return validateTranslations(translations, cues, settings.provider || "openai");
}

async function translateWithOpenRouter(config, input, instructions) {
  const settings = config.textTranslation;
  const apiKey = config.openrouter?.apiKey;
  const model = settings.openrouterModel || config.openrouter?.model;
  if (!apiKey) {
    throw new Error(
      "OpenRouter API key not set for TVer text translation (open extension Settings)."
    );
  }
  if (!model) throw new Error("OpenRouter text-translation model is not set.");

  const baseUrl = (config.openrouter.baseUrl || "https://openrouter.ai/api/v1")
    .replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Live Subtitle Translator",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "subtitle_translations",
          strict: true,
          schema: TRANSLATION_SCHEMA,
        },
      },
      provider: { require_parameters: true },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `OpenRouter text translation with ${model} failed (${res.status}): ${await res.text()}`
    );
  }

  const json = await res.json();
  const outputText = json.choices?.[0]?.message?.content;
  if (typeof outputText !== "string" || !outputText) {
    throw new Error(`OpenRouter model ${model} returned no translated text.`);
  }
  return JSON.parse(outputText)?.translations;
}

async function translateWithOpenAI(config, input, instructions) {
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
      instructions,
      input: JSON.stringify(input),
      max_output_tokens: Math.max(1600, input.cues.length * 140),
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

async function translateWithGemini(config, input, instructions) {
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
          parts: [{ text: `${instructions}\n\nInput:\n${JSON.stringify(input)}` }],
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

async function translateWithDeepL(config, input, primaryTarget, secondaryTarget) {
  const apiKey = config.textTranslation.deeplApiKey;
  if (!apiKey) {
    throw new Error("DeepL API key not set for TVer text translation (open extension Settings).");
  }

  const translatable = input.cues.filter((cue) => !isSoundOnly(cue.text));
  if (!translatable.length) {
    return input.cues.map((cue) => ({ id: cue.id, text: "", secondaryText: "" }));
  }
  const context = [
    ...input.prior_context.map((item) => item.source),
    ...input.cues.map((item) => item.text),
  ].join("\n");
  const [primary, secondary] = await Promise.all([
    translateDeepLTarget(apiKey, translatable, context, primaryTarget),
    secondaryTarget
      ? translateDeepLTarget(apiKey, translatable, context, secondaryTarget)
      : Promise.resolve(new Map()),
  ]);
  return input.cues.map((cue) => ({
    id: cue.id,
    text: primary.get(cue.id) || "",
    secondaryText: secondary.get(cue.id) || "",
  }));
}

async function translateDeepLTarget(apiKey, translatable, context, targetLanguage) {
  const targetCode = DEEPL_TARGET_CODES[targetLanguage];
  if (!targetCode) {
    throw new Error(`DeepL does not support the selected target: ${targetLanguage}`);
  }
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
      target_lang: targetCode,
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
  return new Map(
    translatable.map((cue, index) => [cue.id, json.translations[index]?.text || ""])
  );
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
      typeof item.text === "string" &&
      typeof item.secondaryText === "string"
  );
  if (result.length !== cues.length || new Set(result.map((item) => item.id)).size !== cues.length) {
    throw new Error(`${provider} returned missing or duplicate caption cue ids.`);
  }
  const sourceById = new Map(cues.map((cue) => [cue.id, cue.text]));
  return result.map((item) => ({
    ...item,
    text: normalizeSubtitlePunctuation(sourceById.get(item.id), item.text),
    secondaryText: normalizeSubtitlePunctuation(
      sourceById.get(item.id),
      item.secondaryText
    ),
  }));
}

function translationTargets(settings) {
  const primaryTarget = settings.primaryTargetLanguage || "en";
  const requestedSecondary = settings.secondaryTargetLanguage || "";
  return {
    primaryTarget,
    secondaryTarget: requestedSecondary === primaryTarget ? "" : requestedSecondary,
  };
}

function languageName(code) {
  return LANGUAGE_NAMES[code] || code;
}

export function normalizeSubtitlePunctuation(source, translation) {
  const text = translation.trim();
  if (!text || hasTerminalPunctuation(source)) return text;
  // Drop one model-added full stop, including before a closing quote/bracket.
  // Do not damage an intentional English ellipsis.
  return text
    .replace(/(^|[^.])\.([”’"'」』）)\]】〉》]*)$/, "$1$2")
    .replace(/。([”’"'」』）)\]】〉》]*)$/, "$1");
}

function hasTerminalPunctuation(source) {
  return /[。．.!！?？…‥]([」』”’"'）)\]】〉》]*)$/.test(source.trim());
}
