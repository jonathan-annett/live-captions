// The ASR-backend seam. `Captioner` owns capture/VAD/framing/emit and delegates
// "audio clip in -> caption text out" to an `AsrBackend`. Two implementations
// are planned: `WorkerBackend` (in-browser WebGPU/transformers.js, below) and a
// future `LocalWsBackend` (a localhost Python ASR server over WebSocket — see
// PIVOT-PLAN.md). The contract mirrors the worker RPC shapes in `messages.ts`.
import type { EngineStatus, Word } from "@captions/protocol";
import type { WorkerEvent } from "./messages.js";

export interface DecodeResult {
  text: string;
  words?: Word[];
}

export interface LoadOptions {
  /** verbose [asr] logging (mirrors the page's ?debug) */
  debug?: boolean;
}

/**
 * A pluggable speech-recognition backend. Everything upstream (mic, VAD,
 * utterance framing) and downstream (emit/tee) lives in `Captioner`; a backend
 * only loads a model and decodes utterance clips.
 */
export interface AsrBackend {
  /** Begin loading/warming a model. Resolves once the load request is issued;
   *  readiness + progress arrive asynchronously via `onStatus`/`onProgress`. */
  load(model: string, opts?: LoadOptions): Promise<void>;

  /** Decode one 16 kHz mono clip. `words` requests word-level timing/confidence
   *  (finals only — adds decode cost). Resolves `{ text: "" }` on decode error. */
  transcribe(samples: Float32Array, opts: { words: boolean }): Promise<DecodeResult>;

  /** Engine lifecycle status (loading/listening/error), produced by the backend
   *  so it can name its own backend/device. */
  onStatus(cb: (status: EngineStatus) => void): void;

  /** Model-download progress (aggregate bytes). */
  onProgress(cb: (p: { loaded: number; total: number }) => void): void;

  /** A refined result for an already-emitted utterance `id` (two-tier refine).
   *  The WebGPU worker never fires this; a localhost backend does (P2). */
  onRefine(cb: (id: string, result: DecodeResult) => void): void;

  /** Tear down (terminate worker / close socket). */
  close(): void;
}

/**
 * In-browser ASR via a transformers.js Web Worker (`asr.worker.ts`), running on
 * WebGPU with a WASM fallback. This is the extraction of the worker plumbing
 * that previously lived directly in `Captioner`.
 */
export class WorkerBackend implements AsrBackend {
  private worker: Worker | null = null;
  private pending = new Map<string, (r: DecodeResult) => void>();
  private statusCb?: (status: EngineStatus) => void;
  private progressCb?: (p: { loaded: number; total: number }) => void;
  // Registered for interface parity; the in-browser worker has no refine pass.
  private refineCb?: (id: string, result: DecodeResult) => void;

  onStatus(cb: (status: EngineStatus) => void): void {
    this.statusCb = cb;
  }

  onProgress(cb: (p: { loaded: number; total: number }) => void): void {
    this.progressCb = cb;
  }

  onRefine(cb: (id: string, result: DecodeResult) => void): void {
    this.refineCb = cb;
  }

  async load(model: string, opts?: LoadOptions): Promise<void> {
    if (!this.worker) {
      this.worker = new Worker(new URL("./asr.worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (ev: MessageEvent<WorkerEvent>) =>
        this.onWorkerEvent(ev.data);
    }
    this.worker.postMessage({ type: "load", model, debug: opts?.debug ?? false });
  }

  transcribe(samples: Float32Array, opts: { words: boolean }): Promise<DecodeResult> {
    const reqId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      this.worker?.postMessage(
        { type: "transcribe", reqId, samples, words: opts.words },
        [samples.buffer],
      );
    });
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  private onWorkerEvent(ev: WorkerEvent): void {
    switch (ev.type) {
      case "loading":
        this.statusCb?.({ state: "loading", message: ev.message });
        break;
      case "progress":
        this.progressCb?.({ loaded: ev.loaded, total: ev.total });
        break;
      case "ready":
        this.statusCb?.({
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
          this.statusCb?.({ state: "error", message: ev.message });
        }
        break;
      }
    }
  }
}
