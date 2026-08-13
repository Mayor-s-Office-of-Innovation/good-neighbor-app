/*
  AudioWorklet processor — the fiddly bit the spike exists to de-risk.

  Runs on the audio render thread. Each render quantum hands us Float32 mic samples
  at the AudioContext's real sample rate (often 48000 or 44100). We nearest-neighbour
  decimate to 16 kHz and convert to signed 16-bit little-endian PCM — the exact format
  Amazon Transcribe streaming wants (MediaEncoding: 'pcm', MediaSampleRateHertz: 16000).

  We accumulate ~100 ms of samples before posting a frame to the main thread (transferable
  ArrayBuffer, zero-copy) so we send reasonably-sized chunks rather than one per 128 samples.

  Decimation matches care-connect's downsampleToInt16 (nearest-neighbour). Good enough to
  prove the pipeline; a production version would use a proper resampler with an anti-alias
  filter (flagged in the spike README).
*/
class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.targetRate = options?.processorOptions?.targetRate || 16000
    this.flushSize = Math.round(this.targetRate * 0.1) // 100 ms of 16 kHz samples
    this._acc = new Int16Array(this.flushSize)
    this._n = 0
  }

  process(inputs) {
    const input = inputs[0]
    // input[0] is the first channel (we request mono). Absent between quanta — keep alive.
    if (input && input[0]) {
      const ch = input[0]
      const ratio = sampleRate / this.targetRate // `sampleRate` is a global in the worklet scope
      const outLen = Math.floor(ch.length / ratio)
      for (let i = 0; i < outLen; i++) {
        let s = ch[Math.floor(i * ratio)]
        s = Math.max(-1, Math.min(1, s))
        this._acc[this._n++] = s < 0 ? s * 32768 : s * 32767
        if (this._n >= this.flushSize) {
          const frame = this._acc.slice(0, this._n)
          this.port.postMessage(frame.buffer, [frame.buffer])
          this._acc = new Int16Array(this.flushSize)
          this._n = 0
        }
      }
    }
    return true // keep the processor alive
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler)
