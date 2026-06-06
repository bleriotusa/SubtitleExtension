// Streaming backend using OpenAI's gpt-realtime-translate — a model purpose-built
// for continuous live audio translation. We feed it tab audio and read the
// translated TEXT transcript; the model also synthesizes speech, which we simply
// ignore (never play). Audio in -> English text out, ~1s, no chunking.
//
// Works against two endpoints (config.openaiRealtime.mode):
//   "openai" -> wss://api.openai.com/v1/realtime  (browser auth via the
//               "openai-insecure-api-key" subprotocol — key is client-side, fine
//               for personal use, same caveat as the other providers)
//   "azure"  -> your Foundry deployment of gpt-realtime-translate
//
// NOTE: the realtime/translate session schema is still preview and has shifted
// between versions (modalities vs output_modalities, session.audio.* shape). This
// is a working starting point; if Microsoft/OpenAI tweak the schema you may need
// to adjust the session.update payload and the transcript event names below.

import { SubtitleProvider } from "./SubtitleProvider.js";
import { arrayBufferToBase64 } from "../audio/pcm.js";

export class OpenAIRealtimeProvider extends SubtitleProvider {
  // gpt-realtime expects 24 kHz mono PCM16.
  static inputSampleRate = 24000;

  constructor(config) {
    super(config);
    this._ws = null;
    this._ready = false;
    this._settled = false;
    this._pending = [];
    this._partial = "";
    this._tStart = 0;
  }

  async start() {
    const o = this.config.openaiRealtime;
    if (!o.apiKey) throw new Error("OpenAI/Azure API key not set for the realtime backend.");

    // For Azure, probe candidate URLs over plain HTTPS first. A websocket reports
    // every failed upgrade as an opaque code 1006; a fetch returns the real HTTP
    // status (401 auth, 404 wrong path/host), and the extension's host permissions
    // let us read it cross-origin. The reachable candidate is used for the WS.
    const { url, protocols } =
      o.mode === "azure" ? { url: await resolveAzureUrl(o), protocols: undefined } : buildEndpoint(o);

    await new Promise((resolve, reject) => {
      const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
      this._ws = ws;
      ws.binaryType = "arraybuffer";
      let opened = false;

      ws.onopen = () => { opened = true; this._configureSession(); };

      ws.onmessage = (ev) => {
        const msg = parseEvent(ev.data);
        if (!msg) return;
        const t = msg.type || "";

        // Session is live once created/updated — flush any queued audio.
        if (t === "session.created" || t === "session.updated") {
          if (!this._ready) {
            this._ready = true;
            for (const a of this._pending) this._appendAudio(a);
            this._pending = [];
            resolve();
          }
          return;
        }
        if (t === "error") {
          const detail = msg.error?.message || JSON.stringify(msg.error || msg);
          if (!this._ready) reject(new Error(`OpenAI realtime: ${detail}`));
          else console.error("[OpenAIRealtime]", detail);
          return;
        }
        this._handleTranscript(t, msg);
      };

      // The "error" event is intentionally detail-free; the close frame carries
      // the real reason (code/reason). Surface it so failures are diagnosable.
      ws.onerror = () => { /* wait for onclose, which has the code/reason */ };
      ws.onclose = (ev) => {
        this._ready = false;
        if (!this._ready && !this._settled) {
          const where = opened ? "after handshake" : "during handshake";
          const hint = closeHint(ev.code, o.mode);
          reject(new Error(`OpenAI realtime closed ${where} — code ${ev.code}${ev.reason ? ` "${ev.reason}"` : ""}${hint ? ` (${hint})` : ""}`));
        }
      };
    }).then(() => { this._settled = true; }, (e) => { this._settled = true; throw e; });
  }

  _configureSession() {
    const o = this.config.openaiRealtime;
    // Ask for text output in English. We keep the payload minimal and defensive
    // because the schema is in flux; unknown fields are generally ignored.
    this._ws.send(JSON.stringify({
      type: "session.update",
      session: {
        output_modalities: ["text"],
        audio: {
          input: { format: { type: "audio/pcm", rate: OpenAIRealtimeProvider.inputSampleRate } },
          output: { language: o.targetLangCode || "en" },
        },
      },
    }));
  }

  pushAudio(int16) {
    if (!int16.length || !this._ws) return;
    const b64 = arrayBufferToBase64(int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength));
    if (this._ready) this._appendAudio(b64);
    else this._pending.push(b64);
  }

  _appendAudio(b64) {
    this._ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
  }

  // The translated English text arrives as output-transcript deltas. We tolerate
  // both the gpt-realtime-translate names (session.output_transcript.*) and the
  // general realtime names (response.output_audio_transcript.* / *.text.*).
  _handleTranscript(type, msg) {
    const delta = msg.delta ?? msg.text ?? "";
    const isOutput = type.includes("output_transcript") || type.includes("output_audio_transcript") || type.includes("output_text");
    if (!isOutput) return; // ignore input (source-language) transcript

    if (type.endsWith(".delta") && delta) {
      if (!this._partial) this._tStart = performance.now();
      this._partial += delta;
      this._emit({ text: this._partial.trim(), isFinal: false, tStart: this._tStart });
    } else if (type.endsWith(".done") || type.endsWith(".completed")) {
      const finalText = (msg.transcript ?? this._partial).trim();
      if (finalText) this._emit({ text: finalText, isFinal: true, tStart: this._tStart });
      this._partial = "";
    }
  }

  async stop() {
    this._ready = false;
    try { this._ws?.close(); } catch { /* ignore */ }
    this._ws = null;
  }
}

function buildEndpoint(o) {
  // OpenAI direct: browser websockets can't set the Authorization header, so the
  // key rides in the "openai-insecure-api-key" subprotocol (key is client-side).
  const url = `${o.openaiBaseUrl}?model=${encodeURIComponent(o.model)}`;
  return {
    url,
    protocols: ["realtime", `openai-insecure-api-key.${o.apiKey}`, "openai-beta.realtime-v1"],
  };
}

// Azure host/path combos vary (Foundry vs classic OpenAI resource; GA vs preview
// realtime path). Generate the plausible URLs; the query carries the api-key.
function azureCandidates(o) {
  if (!o.azureEndpoint || !o.azureDeployment) {
    throw new Error("Azure realtime needs azureEndpoint and azureDeployment (see Settings).");
  }
  const auth = `api-key=${encodeURIComponent(o.apiKey)}`;
  const dep = encodeURIComponent(o.azureDeployment);
  const raw = o.azureEndpoint.replace(/\/$/, "").replace(/^wss?:/, "https:");
  const httpsBase = raw.startsWith("http") ? raw.replace(/^http:/, "https:") : `https://${raw}`;
  // The Foundry alias and the classic OpenAI alias both point at one resource;
  // try whichever exists.
  const hosts = new Set([
    httpsBase,
    httpsBase.replace(/\.services\.ai\.azure\.com/i, ".openai.azure.com"),
    httpsBase.replace(/\.openai\.azure\.com/i, ".services.ai.azure.com"),
  ]);
  // Preview path with several known realtime api-versions, plus the GA path.
  const apiVersions = ["2024-10-01-preview", "2025-04-01-preview", "2025-08-28"];
  const paths = [
    ...apiVersions.map((v) => `/openai/realtime?api-version=${v}&deployment=${dep}&${auth}`),
    `/openai/v1/realtime?model=${dep}&${auth}`, // GA
  ];
  const out = [];
  for (const h of hosts) for (const p of paths) out.push(`${h}${p}`);
  return out;
}

// Probe each candidate with a real websocket handshake — the only reliable test.
// A plain GET to a WS-only route 404s even when correct, so we can't use fetch.
// If a socket opens, host+path+key are all good; a close code tells us why not.
async function resolveAzureUrl(o) {
  const wssList = azureCandidates(o).map((u) => u.replace(/^https:/, "wss:"));
  const tried = [];
  for (const wss of wssList) {
    const r = await probeWs(wss);
    if (r.ok) return wss;
    if (r.auth) {
      throw new Error(`Azure rejected the API key during the handshake (code ${r.code}). Check the key matches this resource.`);
    }
    tried.push(`${shortHost(wss)}${shortPath(wss)} → ${r.code}`);
  }
  throw new Error(
    "No candidate Azure realtime URL accepted a websocket. Tried: " + tried.join("; ") +
    ". Verify the resource host and deployment name in Foundry."
  );
}

function probeWs(url) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); try { ws && ws.close(); } catch {} resolve(v); } };
    const timer = setTimeout(() => done({ ok: false, code: "timeout" }), 4500);
    try { ws = new WebSocket(url); } catch { return done({ ok: false, code: "bad-url" }); }
    ws.onopen = () => done({ ok: true });
    ws.onclose = (ev) => done({
      ok: false,
      code: ev.code,
      auth: ev.code === 1008 || ev.code === 3000 || ev.code === 4001 || ev.code === 4401,
    });
    ws.onerror = () => { /* close fires next with the code */ };
  });
}

function shortHost(u) { try { return new URL(u).host; } catch { return u; } }
function shortPath(u) { try { return new URL(u).pathname; } catch { return u; } }

// Map common websocket close codes to a likely cause for this API.
function closeHint(code, mode) {
  switch (code) {
    case 1008: // policy violation — almost always auth
    case 3000:
      return "auth rejected — check the API key" + (mode === "azure" ? " and that the key matches the resource" : "");
    case 1006:
      return "connection failed — check the endpoint URL" + (mode === "azure" ? "/region and that the deployment exists" : "");
    case 1011:
      return "server error — model/deployment may be wrong or unavailable";
    case 4004:
    case 1003:
      return "not found — wrong deployment name or api-version";
    default:
      return "";
  }
}

function parseEvent(data) {
  try {
    return JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
  } catch {
    return null;
  }
}
