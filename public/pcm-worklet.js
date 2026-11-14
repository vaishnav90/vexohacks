// AudioWorklet: microphone samples (Float32, at the AudioContext's rate) -> 16-bit little-endian PCM
// chunks of 20 ms, posted to the page. The page creates the AudioContext at 16000 Hz, so the browser
// resamples the mic for us; `rate` is passed in so the chunk size stays right even if it could not.
class PcmChunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const rate = options?.processorOptions?.rate || sampleRate;
    this.size = Math.round(rate * 0.02); // 20 ms
    this.buf = new Int16Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.size) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]); // little-endian on every browser platform
        this.buf = new Int16Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-chunker", PcmChunker);
