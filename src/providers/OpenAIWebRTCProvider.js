// Streaming backend over WebRTC — the path OpenAI and Azure both recommend for
// browser/client-side realtime (WebSockets are for server-to-server, and browser
// WS handshakes to Azure get rejected, which is the 1006 we kept hitting).
//
// Flow (ephemeral-token variant, done client-side — fine for personal use):
//   1. POST /openai/v1/realtime/client_secrets with the api-key -> ephemeral key.
//   2. RTCPeerConnection: add the captured tab-audio track, open the "oai-events"
//      data channel, create an SDP offer.
//   3. POST the offer to /openai/v1/realtime/calls with the ephemeral key -> SDP
//      answer; apply it.
//   4. Read translated text from data-channel events. The model's synthesized
//      speech (a media track) is ignored — we want subtitles only.
//
// Works for both OpenAI-direct and Azure (config.openaiRealtime.mode).

import { SubtitleProvider } from "./SubtitleProvider.js";

export class OpenAIWebRTCProvider extends SubtitleProvider {
  static wantsMediaStream = true; // start() receives the captured { stream }

  constructor(config) {
    super(config);
    this._pc = null;
    this._dc = null;
    this._partial = "";
    this._tStart = 0;
  }

  async start({ stream } = {}) {
    const o = this.config.openaiRealtime;
    if (!o.apiKey) throw new Error("API key not set for the realtime backend.");
    const track = stream?.getAudioTracks?.()[0];
    if (!track) throw new Error("No audio track in the captured stream.");

    const ep = endpoints(o);
    const ephemeralKey = await mintEphemeralKey(o, ep, o.targetLangCode);

    const pc = new RTCPeerConnection();
    this._pc = pc;
    pc.ontrack = () => {}; // discard the model's translated speech; subtitles only
    pc.addTrack(track, stream);

    const dc = pc.createDataChannel("oai-events");
    this._dc = dc;
    dc.addEventListener("message", (e) => this._onEvent(e.data));

    const ready = new Promise((resolve, reject) => {
      // The translation session is fully configured when the secret is minted
      // (model + target language), so no session.update is needed here.
      dc.addEventListener("open", () => resolve());
      pc.addEventListener("connectionstatechange", () => {
        if (["failed", "closed", "disconnected"].includes(pc.connectionState) && dc.readyState !== "open") {
          reject(new Error(`WebRTC connection ${pc.connectionState}.`));
        }
      });
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch(ep.calls, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
    });
    if (!sdpRes.ok) {
      throw new Error(`SDP exchange failed (HTTP ${sdpRes.status}): ${(await sdpRes.text().catch(() => "")).slice(0, 300)}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });

    await ready;
  }

  pushAudio() { /* unused — audio flows over the peer connection */ }

  // Translated text arrives as output-transcript deltas over the data channel.
  // Tolerate both translate-model and general realtime event names.
  _onEvent(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const t = msg.type || "";
    if (t === "error") { console.error("[OpenAIWebRTC]", msg.error?.message || JSON.stringify(msg.error || msg)); return; }

    const isOutput =
      t.includes("output_transcript") || t.includes("output_audio_transcript") ||
      t.includes("output_text") || t.includes("response.text");
    if (!isOutput) return;

    const delta = msg.delta ?? msg.text ?? "";
    if (t.endsWith(".delta") && delta) {
      if (!this._partial) this._tStart = performance.now();
      this._partial += delta;
      this._emit({ text: this._partial.trim(), isFinal: false, tStart: this._tStart });
    } else if (t.endsWith(".done") || t.endsWith(".completed")) {
      const finalText = (msg.transcript ?? this._partial).trim();
      if (finalText) this._emit({ text: finalText, isFinal: true, tStart: this._tStart });
      this._partial = "";
    }
  }

  async stop() {
    try { this._dc?.close(); } catch { /* ignore */ }
    try { this._pc?.close(); } catch { /* ignore */ }
    this._dc = null;
    this._pc = null;
  }
}

// gpt-realtime-translate uses dedicated "translations" endpoints, not the generic
// realtime ones (the generic /client_secrets rejects the translate model).
function endpoints(o) {
  if (o.mode === "azure") {
    const origin = azureOrigin(o.azureEndpoint);
    return {
      clientSecrets: `${origin}/openai/v1/realtime/translations/client_secrets`,
      calls: `${origin}/openai/v1/realtime/translations/calls`,
      azure: true,
    };
  }
  return {
    clientSecrets: "https://api.openai.com/v1/realtime/translations/client_secrets",
    calls: "https://api.openai.com/v1/realtime/translations/calls",
    azure: false,
  };
}

async function mintEphemeralKey(o, ep, targetLang) {
  const model = ep.azure ? o.azureDeployment : o.model;
  const headers = { "Content-Type": "application/json" };
  // REST POST (not a websocket), so the api-key/Authorization header works here.
  if (ep.azure) headers["api-key"] = o.apiKey;
  else headers["Authorization"] = `Bearer ${o.apiKey}`;

  // Translation session: just bind the model and target output language. We omit
  // input transcription (it would require a separate gpt-realtime-whisper
  // deployment) since we only want the English output.
  const body = {
    session: {
      model,
      audio: { output: { language: targetLang || "en" } },
    },
  };

  const res = await fetch(ep.clientSecrets, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`Could not mint ephemeral key (HTTP ${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const data = await res.json();
  const key = data.value ?? data.client_secret?.value ?? data.client_secret;
  if (!key) throw new Error("Ephemeral key response had no 'value'.");
  return key;
}

function azureOrigin(endpoint) {
  if (!endpoint) throw new Error("Azure endpoint not set (see Settings).");
  const withProto = /^https?:/.test(endpoint) ? endpoint : `https://${endpoint}`;
  let origin;
  try { origin = new URL(withProto).origin; } catch { origin = withProto.replace(/\/+$/, ""); }
  // Realtime/REST lives on the OpenAI alias, not the Foundry services alias.
  return origin.replace(/\.services\.ai\.azure\.com/i, ".openai.azure.com");
}
