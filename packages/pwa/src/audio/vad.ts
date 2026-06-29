/**
 * Lightweight energy-based voice activity detector with an adaptive noise floor
 * and on/off hangover. Good enough to endpoint utterances for live captioning;
 * a Silero-VAD upgrade can slot in behind the same `process()` interface later.
 */
export interface VadOptions {
  /** ms of sustained speech before declaring speech start */
  startMs: number;
  /** ms of sustained silence before declaring speech end */
  endMs: number;
  /** RMS multiple over the noise floor to count as speech */
  margin: number;
}

const DEFAULTS: VadOptions = { startMs: 120, endMs: 600, margin: 2.5 };

export type VadEvent = "start" | "end" | null;

export class EnergyVAD {
  private noiseFloor = 0.005;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;

  constructor(
    private readonly sampleRate = 16000,
    private readonly opts: VadOptions = DEFAULTS,
  ) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  process(frame: Float32Array): VadEvent {
    const rms = computeRms(frame);
    const durMs = (frame.length / this.sampleRate) * 1000;
    const threshold = Math.max(this.noiseFloor * this.opts.margin, 0.006);
    const isSpeech = rms > threshold;

    // Adapt the noise floor only while quiet, so it tracks the room not the talker.
    if (!isSpeech) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;

    if (this.speaking) {
      if (isSpeech) {
        this.silenceMs = 0;
      } else {
        this.silenceMs += durMs;
        if (this.silenceMs >= this.opts.endMs) {
          this.speaking = false;
          this.speechMs = 0;
          return "end";
        }
      }
    } else if (isSpeech) {
      this.speechMs += durMs;
      if (this.speechMs >= this.opts.startMs) {
        this.speaking = true;
        this.silenceMs = 0;
        return "start";
      }
    } else {
      this.speechMs = 0;
    }
    return null;
  }
}

function computeRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / Math.max(frame.length, 1));
}
