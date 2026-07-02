import type { EngineStatus, ServerMessage, Word } from "@captions/protocol";
import { EnergyVAD } from "../audio/vad.js";
import workletUrl from "../audio/pcm-worklet.js?url";
import { correctText } from "./dictionary.js";
import type { WorkerEvent } from "./messages.js";
import {
  analyzeClip,
  isDegenerate,
  MIN_PEAK_RMS,
  MIN_SPEECH_MS,
} from "./sanitize.js";

const TARGET_RATE = 16000;

interface DecodeResult {
  text: string;
  words?: Word[];
}

// Diagnostics / live tuning via the page URL (so we can debug the deployed site
// without a rebuild): ?debug logs every gate decision + decode to the console;
// ?minrms= and ?minms= override the no-speech gate thresholds.
const PARAMS =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const DEBUG = PARAMS.has("debug");
const MIN_RMS = PARAMS.has("minrms") ? Number(PARAMS.get("minrms")) : MIN_PEAK_RMS;
const MIN_MS = PARAMS.has("minms") ? Number(PARAMS.get("minms")) : MIN_SPEECH_MS;
if (DEBUG) {
  // eslint-disable-next-line no-console
  console.log(`[cap] no-speech gate: peak≥${MIN_RMS} over ≥${MIN_MS}ms`);
}

export interface CaptionerOptions {
  model: string;
  /** BroadcastChannel name the display listens on */
  channel: string;
  /** mic deviceId from enumerateDevices, or undefined for default */
  deviceId?: string;
  /** event-specific names/jargon to bias recognized text toward */
  dictionary?: string[];
  /** called for every emitted message (UI preview) */
  onUpdate: (msg: ServerMessage) => void;
  /** model-download progress (bytes), for a progress UI */
  onProgress?: (p: { loaded: number; total: number }) => void;
  /** input signal level (~20 Hz) for a VU meter; reflects the live mic, so it
   *  confirms a device hot-swap. `rms`/`peak` are linear 0..1. */
  onLevel?: (level: { rms: number; peak: number }) => void;
}

/**
 * Drives live captioning entirely on-device: mic -> VAD-endpointed utterances
 * -> Whisper worker -> partial/final segments, published to the display over a
 * BroadcastChannel and mirrored to the UI via `onUpdate`.
 */
export class Captioner {
  private worker: Worker | null = null;
  private channel: BroadcastChannel | null = null;
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;

  private vad!: EnergyVAD;
  private rate = TARGET_RATE;

  // utterance accumulation
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;
  private utter: Float32Array[] = [];
  private utterSamples = 0;
  private utterStartSample = 0;
  private inUtterance = false;
  private currentId = "";
  private sincePartial = 0;
  private partialBusy = false;

  private sampleCount = 0;
  // input-level metering (VU): accumulate peak + mean-square, emit ~20 Hz
  private lvlPeak = 0;
  private lvlSumSq = 0;
  private lvlN = 0;
  private pending = new Map<string, (r: DecodeResult) => void>();
  private dictionary: string[] = [];

  // derived sample thresholds (set on start once the real rate is known)
  private prerollCap = 0;
  private partialEvery = 0;
  private maxUtter = 0;

  constructor(private readonly opts: CaptionerOptions) {
    this.dictionary = opts.dictionary ?? [];
  }

  setDictionary(terms: string[]): void {
    this.dictionary = terms;
  }

  private correct(text: string): string {
    return this.dictionary.length ? correctText(text, this.dictionary) : text;
  }

  /** Apply the same token-wise dictionary correction to each word so the word
   *  array stays consistent with the corrected display text. */
  private correctWords(words: Word[] | undefined): Word[] | undefined {
    if (!words || !this.dictionary.length) return words;
    return words.map((w) => ({ ...w, text: correctText(w.text, this.dictionary) }));
  }

  async start(): Promise<void> {
    this.channel = new BroadcastChannel(this.opts.channel);
    this.emitStatus({ state: "loading", model: this.opts.model });

    this.worker = new Worker(new URL("./asr.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerEvent>) =>
      this.onWorkerEvent(ev.data);
    this.worker.postMessage({ type: "load", model: this.opts.model, debug: DEBUG });

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.opts.deviceId ? { exact: this.opts.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
    this.rate = this.audioCtx.sampleRate;
    this.vad = new EnergyVAD(this.rate);
    this.prerollCap = Math.round(this.rate * 0.25); // 250 ms onset preroll
    this.partialEvery = Math.round(this.rate * 0.7); // partial decode cadence
    this.maxUtter = Math.round(this.rate * 14); // force-commit cap

    await this.audioCtx.audioWorklet.addModule(workletUrl);
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.audioCtx, "pcm-worklet");
    this.node.port.onmessage = (e) => this.onFrame(e.data as Float32Array);
    this.source.connect(this.node);
    // Connect to destination so the worklet is pulled; it outputs silence.
    this.node.connect(this.audioCtx.destination);
    // A context created outside a user gesture starts suspended; resume so the
    // worklet actually pulls audio. No-op when already running (Start button).
    await this.audioCtx.resume().catch(() => {});
  }

  /** True once the audio graph is actually running (context resumed). */
  isCapturing(): boolean {
    return this.audioCtx?.state === "running";
  }

  /** Resume a suspended AudioContext — used by session recovery, where the
   *  browser blocks autoplay until a user gesture. Must be called from within a
   *  gesture handler. Returns whether the context is now running. */
  async resume(): Promise<boolean> {
    if (!this.audioCtx) return false;
    await this.audioCtx.resume().catch(() => {});
    return this.audioCtx.state === "running";
  }

  /** Switch the mic input live, keeping the model/worker/AudioContext intact —
   *  only the input MediaStream + its source node are swapped. `deviceId` is the
   *  value from enumerateDevices ("" = system default). No-op when not capturing;
   *  the new device is remembered and used on the next start(). */
  async setDevice(deviceId: string): Promise<void> {
    (this.opts as { deviceId?: string }).deviceId = deviceId || undefined;
    if (!this.audioCtx || !this.node) return; // not running → applies on next start
    if (this.inUtterance) this.finishUtterance();
    const next = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = next;
    this.source = this.audioCtx.createMediaStreamSource(next);
    this.source.connect(this.node);
    // Drop now-stale preroll so the next utterance starts clean on the new input.
    this.preroll = [];
    this.prerollSamples = 0;
  }

  stop(): void {
    if (this.inUtterance) this.finishUtterance();
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
    this.worker?.terminate();
    this.channel?.close();
    this.node = null;
    this.source = null;
    this.stream = null;
    this.audioCtx = null;
    this.worker = null;
    this.channel = null;
    this.emitStatus({ state: "idle" });
  }

  // --- audio frame handling -------------------------------------------------

  /** Accumulate a peak + RMS from each frame and emit ~20 Hz to `onLevel`. The
   *  source node is swapped by {@link setDevice} without touching this path, so
   *  the meter always reflects the currently-selected mic. */
  private updateLevel(frame: Float32Array): void {
    if (!this.opts.onLevel) return;
    for (let i = 0; i < frame.length; i++) {
      const a = frame[i] < 0 ? -frame[i] : frame[i];
      if (a > this.lvlPeak) this.lvlPeak = a;
      this.lvlSumSq += frame[i] * frame[i];
    }
    this.lvlN += frame.length;
    if (this.lvlN >= this.rate * 0.05) {
      this.opts.onLevel({ rms: Math.sqrt(this.lvlSumSq / this.lvlN), peak: this.lvlPeak });
      this.lvlPeak = 0;
      this.lvlSumSq = 0;
      this.lvlN = 0;
    }
  }

  private onFrame(frame: Float32Array): void {
    this.sampleCount += frame.length;
    this.updateLevel(frame);
    const ev = this.vad.process(frame);

    if (DEBUG && ev) {
      const heldMs = (this.utterSamples / this.rate) * 1000;
      console.log(`[cap] vad ${ev}${ev === "end" ? ` (held ${heldMs.toFixed(0)}ms)` : ""}`);
    }
    if (ev === "start") this.startUtterance();

    if (this.inUtterance) {
      this.utter.push(frame);
      this.utterSamples += frame.length;
      this.sincePartial += frame.length;
    } else {
      this.pushPreroll(frame);
    }

    if (ev === "end") {
      this.finishUtterance();
      return;
    }

    if (this.inUtterance && this.utterSamples >= this.maxUtter) {
      this.finishUtterance();
      this.startUtterance(); // keep going; speaker is still talking
      return;
    }

    if (
      this.inUtterance &&
      this.sincePartial >= this.partialEvery &&
      !this.partialBusy
    ) {
      this.sincePartial = 0;
      this.requestPartial();
    }
  }

  private pushPreroll(frame: Float32Array): void {
    this.preroll.push(frame);
    this.prerollSamples += frame.length;
    while (this.prerollSamples > this.prerollCap && this.preroll.length > 1) {
      this.prerollSamples -= this.preroll.shift()!.length;
    }
  }

  private startUtterance(): void {
    this.inUtterance = true;
    this.utter = this.preroll.slice();
    this.utterSamples = this.prerollSamples;
    this.utterStartSample = this.sampleCount - this.prerollSamples;
    this.sincePartial = 0;
    this.currentId = crypto.randomUUID();
    this.preroll = [];
    this.prerollSamples = 0;
  }

  private finishUtterance(): void {
    if (!this.inUtterance) return;
    const snap = this.snapshot();
    this.inUtterance = false;
    this.utter = [];
    this.utterSamples = 0;
    if (snap.samples.length === 0) return;
    // Don't decode silence/near-silence — that's what triggers phantom phrases.
    const a = analyzeClip(snap.samples, TARGET_RATE, MIN_RMS, MIN_MS);
    this.log("final", a);
    if (!a.isSpeech) {
      this.logDrop("final", "no-speech gate", a);
      return;
    }
    void this.rpc(snap.samples, true).then(({ text, words }) => {
      const degen = isDegenerate(text);
      if (DEBUG) console.log(`[cap] final decoded ${JSON.stringify(text)} degenerate=${degen}`);
      if (text && !degen) {
        this.emit({
          type: "final",
          segment: {
            ...snap.meta,
            text: this.correct(text),
            ...(words ? { words: this.correctWords(words) } : {}),
          },
        });
      } else {
        this.logDrop("final", !text ? "empty decode" : "degenerate text", a);
      }
    });
  }

  private requestPartial(): void {
    this.partialBusy = true;
    const snap = this.snapshot();
    const a = analyzeClip(snap.samples, TARGET_RATE, MIN_RMS, MIN_MS);
    this.log("partial", a);
    if (!a.isSpeech) {
      this.partialBusy = false;
      this.logDrop("partial", "no-speech gate", a);
      return;
    }
    void this.rpc(snap.samples).then(({ text }) => {
      this.partialBusy = false;
      const degen = isDegenerate(text);
      if (text && !degen && this.currentId === snap.meta.id) {
        this.emit({
          type: "partial",
          segment: { ...snap.meta, text: this.correct(text) },
        });
      } else if (text && degen) {
        this.logDrop("partial", "degenerate text", a);
      }
    });
  }

  // --- diagnostics (enabled with ?debug on the page URL) --------------------

  private log(kind: "final" | "partial", a: import("./sanitize.js").ClipAnalysis): void {
    if (!DEBUG) return;
    console.log(
      `[cap] ${kind} clip dur=${a.ms.toFixed(0)}ms peak=${a.peak.toFixed(4)} ` +
        `long=${a.longEnough} loud=${a.loudEnough} → speech=${a.isSpeech}`,
    );
  }

  private logDrop(
    kind: "final" | "partial",
    reason: string,
    a: import("./sanitize.js").ClipAnalysis,
  ): void {
    if (!DEBUG) return;
    console.log(`[cap] DROP ${kind} (${reason}) peak=${a.peak.toFixed(4)} dur=${a.ms.toFixed(0)}ms`);
  }

  private snapshot(): {
    samples: Float32Array;
    meta: { id: string; start: number; end: number };
  } {
    const samples = concat(this.utter, this.utterSamples);
    return {
      samples: this.rate === TARGET_RATE ? samples : resample(samples, this.rate),
      meta: {
        id: this.currentId,
        start: this.utterStartSample / this.rate,
        end: this.sampleCount / this.rate,
      },
    };
  }

  // --- worker RPC -----------------------------------------------------------

  private rpc(samples: Float32Array, words = false): Promise<DecodeResult> {
    const reqId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      this.worker?.postMessage({ type: "transcribe", reqId, samples, words }, [
        samples.buffer,
      ]);
    });
  }

  private onWorkerEvent(ev: WorkerEvent): void {
    switch (ev.type) {
      case "loading":
        this.emitStatus({ state: "loading", message: ev.message });
        break;
      case "progress":
        this.opts.onProgress?.({ loaded: ev.loaded, total: ev.total });
        break;
      case "ready":
        this.emitStatus({
          state: "listening",
          backend: "transformers.js",
          device: ev.device,
          model: ev.model,
        });
        break;
      case "result": {
        const resolve = this.pending.get(ev.reqId);
        this.pending.delete(ev.reqId);
        resolve?.({ text: ev.text, words: ev.words });
        break;
      }
      case "error": {
        if (ev.reqId) {
          this.pending.get(ev.reqId)?.({ text: "" });
          this.pending.delete(ev.reqId);
        } else {
          this.emitStatus({ state: "error", message: ev.message });
        }
        break;
      }
    }
  }

  // --- emit -----------------------------------------------------------------

  private emit(msg: ServerMessage): void {
    this.opts.onUpdate(msg);
    this.channel?.postMessage(msg);
  }

  private emitStatus(status: EngineStatus): void {
    this.emit({ type: "status", status });
  }
}

function concat(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Defensive linear resample to 16 kHz when the AudioContext ignores our hint. */
function resample(input: Float32Array, fromRate: number): Float32Array {
  const ratio = TARGET_RATE / fromRate;
  const outLen = Math.round(input.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}
