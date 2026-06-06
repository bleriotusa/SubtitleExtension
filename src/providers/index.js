// Provider registry + factory. Add a backend here and it becomes selectable
// from config/options with no changes to capture or overlay code.

import { OpenRouterBatchProvider } from "./OpenRouterBatchProvider.js";
import { GeminiLiveProvider } from "./GeminiLiveProvider.js";
import { OpenAIRealtimeProvider } from "./OpenAIRealtimeProvider.js";
import { OpenAIWebRTCProvider } from "./OpenAIWebRTCProvider.js";

export const PROVIDERS = {
  "openai-webrtc": {
    label: "OpenAI Realtime Translate (WebRTC) — OpenAI or Azure, ~1s [recommended]",
    ctor: OpenAIWebRTCProvider,
    streaming: true,
  },
  "openrouter-batch": {
    label: "OpenRouter (batch) — Gemini 3.1 Flash Lite, ~2-3s",
    ctor: OpenRouterBatchProvider,
    streaming: false,
  },
  "openai-realtime": {
    label: "OpenAI Realtime Translate (WebSocket) — server-side only, ~1s",
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
