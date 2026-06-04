// Provider registry + factory. Add a backend here and it becomes selectable
// from config/options with no changes to capture or overlay code.

import { OpenRouterBatchProvider } from "./OpenRouterBatchProvider.js";
import { GeminiLiveProvider } from "./GeminiLiveProvider.js";
import { OpenAIRealtimeProvider } from "./OpenAIRealtimeProvider.js";

export const PROVIDERS = {
  "openrouter-batch": {
    label: "OpenRouter (batch) — Gemini 3.1 Flash Lite, ~2-3s",
    ctor: OpenRouterBatchProvider,
    streaming: false,
  },
  "openai-realtime": {
    label: "OpenAI Realtime Translate (streaming) — OpenAI or Azure, ~1s",
    ctor: OpenAIRealtimeProvider,
    streaming: true,
  },
  "gemini-live": {
    label: "Gemini Live (streaming) — direct Google key, ~1s",
    ctor: GeminiLiveProvider,
    streaming: true,
  },
};

export function createProvider(config) {
  const entry = PROVIDERS[config.provider];
  if (!entry) throw new Error(`Unknown provider: ${config.provider}`);
  return new entry.ctor(config);
}
