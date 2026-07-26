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

function updateAzureVisibility() {
  $("azure-fields").style.display = $("oa-mode").value === "azure" ? "" : "none";
}
$("oa-mode").addEventListener("change", updateAzureVisibility);

async function load() {
  const c = await getConfig();
  providerSel.value = c.provider;
  $("or-key").value = c.openrouter.apiKey;
  $("or-model").value = c.openrouter.model;
  $("gl-key").value = c.geminiLive.apiKey;
  $("gl-model").value = c.geminiLive.model;
  const o = c.openaiRealtime;
  $("oa-mode").value = o.mode;
  $("oa-key").value = o.apiKey;
  $("oa-model").value = o.model;
  $("oa-az-endpoint").value = o.azureEndpoint;
  $("oa-az-deploy").value = o.azureDeployment;
  $("oa-az-ver").value = o.azureApiVersion;
  $("tt-provider").value = c.textTranslation.provider;
  $("tt-key").value = c.textTranslation.apiKey;
  $("tt-model").value = c.textTranslation.model;
  $("tt-openrouter-model").value = c.textTranslation.openrouterModel;
  $("tt-gemini-key").value = c.textTranslation.geminiApiKey;
  $("tt-gemini-model").value = c.textTranslation.geminiModel;
  $("tt-deepl-key").value = c.textTranslation.deeplApiKey;
  $("tt-batch").value = c.textTranslation.batchSize;
  $("tt-hide-native").checked = c.textTranslation.hideNativeCaptions;
  $("chunk").value = c.chunkMs;
  $("font").value = c.fontSize;
  updateHint();
  updateAzureVisibility();
}

$("save").addEventListener("click", async () => {
  await setConfig({
    provider: providerSel.value,
    openrouter: { apiKey: $("or-key").value.trim(), model: $("or-model").value.trim() },
    geminiLive: { apiKey: $("gl-key").value.trim(), model: $("gl-model").value.trim() },
    openaiRealtime: {
      mode: $("oa-mode").value,
      apiKey: $("oa-key").value.trim(),
      model: $("oa-model").value.trim(),
      azureEndpoint: $("oa-az-endpoint").value.trim(),
      azureDeployment: $("oa-az-deploy").value.trim(),
      azureApiVersion: $("oa-az-ver").value.trim(),
    },
    textTranslation: {
      provider: $("tt-provider").value,
      apiKey: $("tt-key").value.trim(),
      model: $("tt-model").value.trim(),
      openrouterModel: $("tt-openrouter-model").value.trim(),
      geminiApiKey: $("tt-gemini-key").value.trim(),
      geminiModel: $("tt-gemini-model").value.trim(),
      deeplApiKey: $("tt-deepl-key").value.trim(),
      batchSize: Math.max(10, Math.min(60, Number($("tt-batch").value) || 30)),
      hideNativeCaptions: $("tt-hide-native").checked,
    },
    chunkMs: Number($("chunk").value) || 3000,
    fontSize: Number($("font").value) || 28,
  });
  $("saved").textContent = "Saved ✓";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});

load();
