// Runs in the AudioWorkletGlobalScope. Taps the captured tab audio, mixes to
// mono, downsamples from the context rate (usually 48 kHz) to 16 kHz, converts
// to Int16, and posts ~200ms frames to the offscreen document.
//
// Downsampling is averaging-decimation: each output sample is the mean of the
// input samples that fall in its window. Cheap, and the gentle low-pass it
// gives is fine for speech.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetRate = options?.processorOptions?.targetRate || 16000;
    this._ratio = sampleRate / targetRate; // global `sampleRate` = context rate
    this._frameLen = Math.round(targetRate * 0.2); // ~200ms per posted frame
    this._acc = 0;
    this._accCount = 0;
    this._needed = this._ratio;
    this._out = new Int16Array(this._frameLen);
    this._outLen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const chCount = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      // Mix channels to mono.
      let s = 0;
      for (let c = 0; c < chCount; c++) s += input[c][i];
      s /= chCount;

      this._acc += s;
      this._accCount++;
      if (this._accCount >= this._needed) {
        const avg = this._acc / this._accCount;
        this._out[this._outLen++] = Math.max(-32768, Math.min(32767, Math.round(avg * 32768)));
        // Carry the fractional remainder so the rate stays exact over time.
        this._needed += this._ratio - this._accCount;
        this._acc = 0;
        this._accCount = 0;

        if (this._outLen >= this._frameLen) {
          const frame = this._out.slice(0, this._outLen);
          this.port.postMessage(frame, [frame.buffer]);
          this._outLen = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
