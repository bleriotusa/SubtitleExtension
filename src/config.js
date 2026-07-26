// Central defaults + persisted-settings access.
//
// Everything the user can tune lives here. The options page writes overrides
// into chrome.storage.local under STORAGE_KEY; getConfig() merges them over the
// defaults so the rest of the code only ever reads one resolved object.

export const STORAGE_KEY = "qqls.config";

export const DEFAULT_CONFIG = {
  // Which SubtitleProvider to use. See src/providers/index.js for the registry.
  //   "openrouter-batch" -> works today on an OpenRouter key, ~2-3s lag.
  //   "gemini-live"      -> direct Google key, websocket streaming, ~1s lag.
  provider: "openai-webrtc",

  // Per-provider settings. Only the block for the active provider is used.
  openrouter: {
    apiKey: "",
    // One call transcribes Mandarin AND translates to English.
    model: "google/gemini-3.1-flash-lite",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  geminiLive: {
    apiKey: "",
    model: "models/gemini-2.5-flash-live-preview",
  },
  openaiRealtime: {
    mode: "openai", // "openai" (direct) | "azure" (your Foundry deployment)
    apiKey: "",
    model: "gpt-realtime-translate",
    targetLangCode: "en",
    // OpenAI direct endpoint:
    openaiBaseUrl: "wss://api.openai.com/v1/realtime",
    // Azure: wss://<resource>.openai.azure.com  +  your deployment name.
    azureEndpoint: "",
    azureDeployment: "",
    // Azure GA "v1" API. Use the literal keyword "preview" to reach preview
    // models like gpt-realtime-translate (NOT a dated version, NOT the model date).
    azureApiVersion: "preview",
  },
  // TVer exposes timed Japanese WebVTT captions. Translate those directly
  // instead of transcribing audio.
  textTranslation: {
    provider: "openai", // "openai" | "openrouter" | "gemini" | "deepl" | "edge"
    apiKey: "",
    model: "gpt-5.6-terra",
    // Uses the key and endpoint from the top-level openrouter block.
    openrouterModel: "google/gemini-3.1-flash-lite",
    geminiApiKey: "",
    geminiModel: "gemini-3.5-flash-lite",
    deeplApiKey: "",
    batchSize: 30,
    hideNativeCaptions: false,
  },

  // Audio chunking (batch providers only). Smaller = lower lag, worse accuracy.
  // Batch realistically floors at ~2000ms for good quality.
  chunkMs: 3000,
  // Hard cap so a long monologue still flushes even without a silence gap.
  maxChunkMs: 6000,
  // RMS below this (0..1) counts as silence for VAD-based cutting.
  silenceThreshold: 0.012,
  // Trailing silence needed to end a chunk early.
  silenceHangoverMs: 350,

  targetLang: "English",
  sourceLangHint: "Mandarin Chinese",

  // Overlay appearance.
  fontSize: 28,
};

export async function getConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const override = stored?.[STORAGE_KEY] ?? {};
  // Shallow-merge top level, deep-merge the per-provider blocks.
  return {
    ...DEFAULT_CONFIG,
    ...override,
    openrouter: { ...DEFAULT_CONFIG.openrouter, ...(override.openrouter ?? {}) },
    geminiLive: { ...DEFAULT_CONFIG.geminiLive, ...(override.geminiLive ?? {}) },
    openaiRealtime: { ...DEFAULT_CONFIG.openaiRealtime, ...(override.openaiRealtime ?? {}) },
    textTranslation: { ...DEFAULT_CONFIG.textTranslation, ...(override.textTranslation ?? {}) },
  };
}

export async function setConfig(patch) {
  const current = (await chrome.storage.local.get(STORAGE_KEY))?.[STORAGE_KEY] ?? {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
