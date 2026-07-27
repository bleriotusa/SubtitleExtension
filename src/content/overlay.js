// Subtitle overlay injected on QQ Video pages. Receives lines relayed by the
// service worker and renders them over the player.
//
// Rendering model mirrors the provider contract:
//   - isFinal:false  -> update the single live line in place
//   - isFinal:true   -> commit it as the last stable subtitle
//
// Classic content script (not a module), so config defaults are inlined and any
// overrides are read straight from chrome.storage.local.

(() => {
  // Bail out in sandboxed iframes where extension APIs aren't available.
  if (typeof chrome === "undefined" || !chrome.storage?.local || !chrome.runtime?.onMessage) return;
  const isTver = location.hostname === "tver.jp" || location.hostname.endsWith(".tver.jp");
  if (isTver && window !== window.top) return;

  const STORAGE_KEY = "qqls.config";
  const DEFAULTS = { fontSize: 34, hideNativeTverCaptions: false };

  let root = null;
  let committed = []; // array of strings
  let partial = "";
  let settings = { ...DEFAULTS };
  let tverState = null;

  chrome.storage.local.get(STORAGE_KEY).then((v) => {
    const o = v?.[STORAGE_KEY] ?? {};
    if (o.fontSize) settings.fontSize = o.fontSize;
    settings.hideNativeTverCaptions = Boolean(o.textTranslation?.hideNativeCaptions);
    if (root) applySettings();
    syncNativeCaptionVisibility();
  });

  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue ?? {};
    if (next.fontSize) settings.fontSize = next.fontSize;
    settings.hideNativeTverCaptions = Boolean(
      next.textTranslation?.hideNativeCaptions
    );
    applySettings();
    syncNativeCaptionVisibility();
  });

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.createElement("div");
    root.id = "qqls-overlay";
    root.classList.add("qqls-hidden");
    attach();
    applySettings();
    return root;
  }

  function attach() {
    const host = document.fullscreenElement || document.body;
    if (root.parentElement !== host) host.appendChild(root);
  }

  function applySettings() {
    if (root) root.style.fontSize = `${settings.fontSize}px`;
  }

  function syncNativeCaptionVisibility() {
    if (!isTver) return;
    document.documentElement.classList.toggle(
      "qqls-hide-native-tver-captions",
      Boolean(tverState && settings.hideNativeTverCaptions)
    );
  }

  function render() {
    if (!root) return;
    root.textContent = "";
    // One line only: the live (streaming) text while it refines, otherwise the
    // last committed line. A streaming partial becomes the committed line when it
    // finalizes, so this reads as a single stable subtitle at full size.
    const text = partial || committed[committed.length - 1] || "";
    if (text) {
      const el = document.createElement("div");
      el.className = "qqls-line";
      el.textContent = text;
      root.appendChild(el);
    }
    root.classList.toggle("qqls-hidden", !text);
  }

  function addLine(line) {
    ensureRoot();
    if (line.isFinal) {
      committed.push(line.text);
      if (committed.length > 50) committed = committed.slice(-50);
      partial = "";
    } else {
      partial = line.text;
    }
    render();
  }

  function setActive(active) {
    if (active) {
      ensureRoot();
      committed = [];
      partial = "";
      render();
      if (isTver) startTverCaptions();
    } else if (root) {
      stopTverCaptions();
      partial = "";
      root.classList.add("qqls-hidden");
    }
  }

  function startTverCaptions() {
    stopTverCaptions();
    tverState = {
      observer: null,
      interval: null,
      trackUrl: "",
      cues: [],
      translations: new Map(),
      requested: new Set(),
      batchSize: 30,
      provider: "openai",
      primaryTargetLanguage: "en",
      secondaryTargetLanguage: "",
      inflight: false,
      edgeTranslators: new Map(),
      edgeTranslatorPromises: new Map(),
      retryAfter: 0,
      lastText: "",
    };
    syncNativeCaptionVisibility();

    scanTverResources();
    if (typeof PerformanceObserver !== "undefined") {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) maybeLoadTverTrack(entry.name);
      });
      tverState.observer = observer;
      try {
        observer.observe({ type: "resource", buffered: true });
      } catch {
        observer.observe({ entryTypes: ["resource"] });
      }
    }
    tverState.interval = setInterval(tickTverCaptions, 250);
  }

  function stopTverCaptions() {
    if (!tverState) return;
    const state = tverState;
    try { state.observer?.disconnect(); } catch { /* ignore */ }
    if (state.interval) clearInterval(state.interval);
    for (const translator of state.edgeTranslators.values()) {
      try { translator.destroy(); } catch { /* ignore */ }
    }
    tverState = null;
    syncNativeCaptionVisibility();
  }

  function scanTverResources() {
    for (const entry of performance.getEntriesByType("resource")) {
      maybeLoadTverTrack(entry.name);
    }
  }

  function maybeLoadTverTrack(url) {
    const state = tverState;
    if (!state || !isTverCaptionUrl(url) || state.trackUrl === url) return;
    state.trackUrl = url;
    chrome.runtime.sendMessage({ type: "tver-caption-track", url }).then((res) => {
      if (!tverState || tverState !== state || state.trackUrl !== url) return;
      if (!res?.ok) throw new Error(res?.error || "Could not load TVer caption track.");
      state.cues = Array.isArray(res.cues) ? res.cues : [];
      state.batchSize = Number(res.batchSize) || 30;
      state.provider = res.provider || "openai";
      state.primaryTargetLanguage = res.primaryTargetLanguage || "en";
      state.secondaryTargetLanguage =
        res.secondaryTargetLanguage === state.primaryTargetLanguage
          ? ""
          : res.secondaryTargetLanguage || "";
      state.translations.clear();
      state.requested.clear();
      tickTverCaptions();
    }).catch((e) => {
      if (tverState === state) state.trackUrl = "";
      console.error("[TVer captions]", e);
      setTimeout(() => {
        if (tverState === state) scanTverResources();
      }, 5000);
    });
  }

  function isTverCaptionUrl(value) {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "tracks.streaks.jp" &&
        url.pathname.toLowerCase().endsWith(".vtt") &&
        !url.pathname.toLowerCase().endsWith("/thumbnails.vtt")
      );
    } catch {
      return false;
    }
  }

  function tickTverCaptions() {
    const state = tverState;
    const video = document.querySelector("video");
    if (!state || !video || !state.cues.length) return;

    const time = video.currentTime;
    const firstActive = state.cues.findIndex((cue) => cue.end > time);
    const index = firstActive < 0 ? state.cues.length : firstActive;
    const active = [];
    for (let i = index; i < state.cues.length && state.cues[i].start <= time + 0.05; i++) {
      if (state.cues[i].end > time) active.push(state.cues[i]);
    }

    const text = [...new Set(active.flatMap((cue) => {
      const translation = state.translations.get(cue.id);
      if (!translation) return [];
      return [translation.text, translation.secondaryText]
        .filter((value) => typeof value === "string" && value.trim());
    }))].join("\n");
    setTverText(text);
    requestTverBatch(state, index, time);
  }

  function setTverText(text) {
    if (!tverState || tverState.lastText === text) return;
    tverState.lastText = text;
    ensureRoot();
    partial = text;
    render();
  }

  function requestTverBatch(state, index, time) {
    if (state.inflight || Date.now() < state.retryAfter) return;
    const cues = [];
    const lookaheadEnd = time + 90;
    for (let i = Math.max(0, index - 4); i < state.cues.length; i++) {
      const cue = state.cues[i];
      if (cue.start > lookaheadEnd || cues.length >= state.batchSize) break;
      if (!state.translations.has(cue.id) && !state.requested.has(cue.id)) cues.push(cue);
    }
    if (!cues.length) return;

    state.inflight = true;
    for (const cue of cues) state.requested.add(cue.id);
    const firstIndex = state.cues.findIndex((cue) => cue.id === cues[0].id);
    const context = state.cues.slice(Math.max(0, firstIndex - 8), firstIndex).map((cue) => ({
      text: cue.text,
      primary: state.translations.get(cue.id)?.text || "",
      secondary: state.translations.get(cue.id)?.secondaryText || "",
    }));

    const request = state.provider === "edge"
      ? translateEdgeCues(state, cues).then((translations) => ({ ok: true, translations }))
      : chrome.runtime.sendMessage({
          type: "tver-translate-batch",
          cues: cues.map(({ id, text }) => ({ id, text })),
          context,
        });

    request.then((res) => {
      if (!tverState || tverState !== state) return;
      if (!res?.ok) throw new Error(res?.error || "TVer caption translation failed.");
      for (const item of res.translations || []) {
        if (Number.isInteger(item?.id) && typeof item.text === "string") {
          state.translations.set(item.id, {
            text: item.text.trim(),
            secondaryText:
              typeof item.secondaryText === "string" ? item.secondaryText.trim() : "",
          });
        }
      }
      for (const cue of cues) state.requested.delete(cue.id);
      state.inflight = false;
      tickTverCaptions();
    }).catch((e) => {
      for (const cue of cues) state.requested.delete(cue.id);
      state.inflight = false;
      state.retryAfter = Date.now() + 5000;
      console.error("[TVer translation]", e);
    });
  }

  async function translateEdgeCues(state, cues) {
    const primaryTranslator = await getEdgeTranslator(
      state,
      state.primaryTargetLanguage
    );
    const secondaryTranslator = state.secondaryTargetLanguage
      ? await getEdgeTranslator(state, state.secondaryTargetLanguage)
      : null;
    const translations = [];
    for (const cue of cues) {
      const soundOnly = /^[\s♬♪〜～ー…・]+$/.test(cue.text);
      const [text, secondaryText] = soundOnly
        ? ["", ""]
        : await Promise.all([
            primaryTranslator.translate(cue.text),
            secondaryTranslator ? secondaryTranslator.translate(cue.text) : "",
          ]);
      translations.push({
        id: cue.id,
        text: normalizeSubtitlePunctuation(cue.text, text),
        secondaryText: normalizeSubtitlePunctuation(cue.text, secondaryText),
      });
    }
    return translations;
  }

  function normalizeSubtitlePunctuation(source, translation) {
    const text = translation.trim();
    if (!text || /[。．.!！?？…‥]([」』”’"'）)\]】〉》]*)$/.test(source.trim())) {
      return text;
    }
    return text
      .replace(/(^|[^.])\.([”’"'」』）)\]】〉》]*)$/, "$1$2")
      .replace(/。([”’"'」』）)\]】〉》]*)$/, "$1");
  }

  async function getEdgeTranslator(state, targetLanguage) {
    if (state.edgeTranslators.has(targetLanguage)) {
      return state.edgeTranslators.get(targetLanguage);
    }
    if (state.edgeTranslatorPromises.has(targetLanguage)) {
      return state.edgeTranslatorPromises.get(targetLanguage);
    }
    if (typeof Translator === "undefined") {
      throw new Error("Edge on-device translation requires Microsoft Edge 148 or later.");
    }

    const promise = (async () => {
      const options = { sourceLanguage: "ja", targetLanguage };
      const availability = await Translator.availability(options);
      if (availability === "unavailable") {
        throw new Error(
          `Edge does not have an on-device Japanese → ${targetLanguage} model.`
        );
      }
      if (availability === "downloadable" || availability === "downloading") {
        setTverText(`Downloading Edge's Japanese → ${targetLanguage} model…`);
      }
      const translator = await Translator.create({
        ...options,
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            if (tverState !== state || !event.total) return;
            setTverText(
              `Downloading Edge's Japanese → ${targetLanguage} model… ${Math.round(
                (event.loaded / event.total) * 100
              )}%`
            );
          });
        },
      });
      if (tverState !== state) {
        translator.destroy();
        throw new Error("TVer translation was stopped.");
      }
      state.edgeTranslators.set(targetLanguage, translator);
      return translator;
    })();
    state.edgeTranslatorPromises.set(targetLanguage, promise);
    promise.catch(() => state.edgeTranslatorPromises.delete(targetLanguage));
    return promise;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "qqls-subtitle") addLine(msg.line);
    else if (msg?.type === "qqls-status") setActive(msg.active);
  });

  // Keep the overlay inside the fullscreen element so it stays visible.
  document.addEventListener("fullscreenchange", () => {
    if (root) { attach(); render(); }
  });
})();
