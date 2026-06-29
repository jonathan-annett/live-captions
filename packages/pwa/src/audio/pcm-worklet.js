// AudioWorkletProcessor that forwards mono PCM blocks to the main thread.
// Plain JS on purpose: worklets load as classic/ESM modules, not via the TS
// pipeline. The AudioContext is created at 16 kHz, so blocks arrive at 16 kHz.
class PCMWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) {
      // Copy: the underlying buffer is reused by the engine after process().
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
