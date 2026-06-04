import { getConfig, setConfig } from "../config.js";
import { PROVIDERS } from "../providers/index.js";

const $ = (id) => document.getElementById(id);

const providerSel = $("provider");
for (const [key, meta] of Object.entries(PROVIDERS)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = meta.label;
  providerSel.appendChild(opt);
}

function updateHint() {
  const meta = PROVIDERS[providerSel.value];
  $("provider-hint").textContent = meta?.streaming
    ? "Streaming backend — lowest latency (~1s), needs its own direct key below."
    : "Batch backend — runs on your OpenRouter key, ~2-3s latency.";
}
providerSel.addEventListener("change", updateHint);

async function load() {
  const c = await getConfig();
  providerSel.value = c.provider;
  $("or-key").value = c.openrouter.apiKey;
  $("or-model").value = c.openrouter.model;
  $("gl-key").value = c.geminiLive.apiKey;
  $("gl-model").value = c.geminiLive.model;
  $("chunk").value = c.chunkMs;
  $("font").value = c.fontSize;
  updateHint();
}

$("save").addEventListener("click", async () => {
  await setConfig({
    provider: providerSel.value,
    openrouter: { apiKey: $("or-key").value.trim(), model: $("or-model").value.trim() },
    geminiLive: { apiKey: $("gl-key").value.trim(), model: $("gl-model").value.trim() },
    chunkMs: Number($("chunk").value) || 3000,
    fontSize: Number($("font").value) || 28,
  });
  $("saved").textContent = "Saved ✓";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});

load();
