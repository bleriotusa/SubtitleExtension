// The one interface the capture/overlay layer talks to. Every backend
// (OpenRouter batch, Gemini Live streaming, future ones) implements this, so
// swapping a backend never touches capture, chunking, or the overlay.
//
// A "subtitle line" emitted to the callback looks like:
//   { text: string, isFinal: boolean, tStart: number }
// - isFinal:false  -> a partial that should REPLACE the current live line
//                     (streaming providers update these in place as they refine)
// - isFinal:true   -> commit this line; the next text starts a new line
// - tStart         -> performance.now() at the start of the audio it covers
//                     (lets the overlay reason about lag if it wants to)

export class SubtitleProvider {
  /** @param {object} config Resolved config from getConfig(). */
  constructor(config) {
    this.config = config;
    this._cb = () => {};
  }

  /** Open the session / warm up. Resolve when ready to accept audio. */
  async start() {}

  /**
   * Feed one frame of 16 kHz mono Int16 PCM. Called continuously (~every
   * 100-250ms). Batch providers buffer and cut internally; streaming providers
   * forward over the wire immediately.
   * @param {Int16Array} _int16
   */
  pushAudio(_int16) {}

  /** Register the sink for emitted subtitle lines. */
  onSubtitle(cb) {
    this._cb = cb;
  }

  /** Tear down the session. */
  async stop() {}

  /** @protected emit a line to the registered callback. */
  _emit(line) {
    try {
      this._cb(line);
    } catch (e) {
      console.error("[SubtitleProvider] subtitle callback threw", e);
    }
  }
}
