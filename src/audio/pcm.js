// Small PCM helpers shared by the batch providers.
// Audio reaching providers is 16 kHz, mono, Int16 little-endian.

export const SAMPLE_RATE = 16000;

/** RMS energy of an Int16 frame, normalised to 0..1. */
export function rms(int16) {
  if (!int16.length) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / int16.length);
}

/** Concatenate a list of Int16Array frames into one. */
export function concatInt16(frames) {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}

/** Wrap mono Int16 PCM in a WAV container. Returns an ArrayBuffer. */
export function encodeWav(int16, sampleRate = SAMPLE_RATE) {
  const dataBytes = int16.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(int16);
  return buf;
}

/** ArrayBuffer -> base64 (chunked to avoid call-stack limits). */
export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
