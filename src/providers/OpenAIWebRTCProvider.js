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

    // Mint the ephemeral key + learn the matching calls URL. Azure routing varies
    // by host/path, so probe; OpenAI-direct is a single fixed endpoint.
    const { ephemeralKey, callsUrl } =
      o.mode === "azure"
        ? await resolveAzureSession(o, o.targetLangCode)
        : await mintOpenAI(o, o.targetLangCode);

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

    const sdpRes = await fetch(callsUrl, {
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

function sessionBody(model, targetLang, type) {
  // Translation session: bind the model and target output language. Input
  // transcription is omitted (it would need a separate gpt-realtime-whisper
  // deployment); we only want the English output. Azure uses the generic
  // realtime endpoint and needs an explicit session.type = "translation";
  // OpenAI-direct uses the /translations/ endpoint where type is implied.
  const session = { model, audio: { output: { language: targetLang || "en" } } };
  if (type) session.type = type;
  return JSON.stringify({ session });
}

function extractKey(data) {
  return data.value ?? data.client_secret?.value ?? data.client_secret ?? null;
}

// OpenAI-direct: a single fixed pair of endpoints.
async function mintOpenAI(o, targetLang) {
  const res = await fetch("https://api.openai.com/v1/realtime/translations/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
    body: sessionBody(o.model, targetLang),
  });
  if (!res.ok) {
    throw new Error(`Could not mint ephemeral key (HTTP ${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const key = extractKey(await res.json());
  if (!key) throw new Error("Ephemeral key response had no 'value'.");
  return { ephemeralKey: key, callsUrl: "https://api.openai.com/v1/realtime/translations/calls" };
}

// Azure: deployment routing varies by host (Foundry services alias vs OpenAI
// alias) and URL style (v1 model-in-body vs deployment-in-path). Probe the mint
// call across the combinations and keep the one that returns a key, along with
// the matching calls URL so the SDP exchange uses the same route.
async function resolveAzureSession(o, targetLang) {
  if (!o.azureEndpoint) throw new Error("Azure endpoint not set (see Settings).");
  if (!o.azureDeployment) throw new Error("Azure deployment name not set (see Settings).");

  const origin = azureOriginRaw(o.azureEndpoint);
  // Try BOTH aliases regardless of which the user entered — a Foundry deployment
  // often resolves only on the services.ai.azure.com host, not the openai one.
  const servicesHost = origin.replace(/\.openai\.azure\.com/i, ".services.ai.azure.com");
  const openaiHost = origin.replace(/\.services\.ai\.azure\.com/i, ".openai.azure.com");
  const hosts = [...new Set([openaiHost, origin, servicesHost])];
  // Azure mints the translate key on the GENERIC realtime endpoint (the deployment
  // resolves there). The session.type for a translate session is undocumented and
  // "translation" is rejected (InvalidSessionType), so try the candidate types.
  const headers = { "api-key": o.apiKey, "Content-Type": "application/json" };
  const sessionTypes = ["transcription", "translation"];

  const tried = [];
  for (const h of hosts) {
    const cs = `${h}/openai/v1/realtime/client_secrets`;
    const calls = `${h}/openai/v1/realtime/calls`;
    for (const type of sessionTypes) {
      let res;
      try {
        res = await fetch(cs, { method: "POST", headers, body: sessionBody(o.azureDeployment, targetLang, type) });
      } catch {
        tried.push(`${shortHost(cs)} [${type}] → unreachable`);
        continue;
      }
      if (res.ok) {
        const key = extractKey(await res.json().catch(() => ({})));
        if (key) return { ephemeralKey: key, callsUrl: calls };
        tried.push(`[${type}] → 200 but no key`);
      } else {
        const snippet = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 90);
        tried.push(`${shortHost(cs)} [${type}] → ${res.status} ${snippet}`);
      }
    }
  }
  throw new Error("Could not create the Azure translation session. Tried: " + tried.join("  |  "));
}

function azureOriginRaw(endpoint) {
  const withProto = /^https?:/.test(endpoint) ? endpoint : `https://${endpoint}`;
  try { return new URL(withProto).origin; } catch { return withProto.replace(/\/+$/, ""); }
}

function shortHost(u) { try { return new URL(u).host; } catch { return u; } }
function shortPath(u) { try { return new URL(u).pathname; } catch { return u; } }
