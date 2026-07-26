// Small WebVTT parser for TVer's caption files. It intentionally keeps timing
// and text only; TVer's position/color classes belong to the Japanese renderer,
// not to the translated overlay.

export function parseWebVtt(source) {
  const blocks = String(source || "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues = [];
  let id = 0;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trimEnd());
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;

    const timingIndex = lines.findIndex((line) => line.includes(" --> "));
    if (timingIndex < 0) continue;

    const timing = lines[timingIndex].match(
      /^((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})/
    );
    if (!timing) continue;

    const text = cleanVttText(lines.slice(timingIndex + 1).join("\n"));
    if (!text) continue;

    cues.push({
      id: id++,
      start: parseTimestamp(timing[1]),
      end: parseTimestamp(timing[2]),
      text,
    });
  }

  return cues;
}

export function cleanVttText(text) {
  return decodeEntities(
    String(text || "")
      .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\u200b/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function parseTimestamp(value) {
  const parts = value.split(":");
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = Number(parts.pop() || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;|&#39;/gi, "'");
}
