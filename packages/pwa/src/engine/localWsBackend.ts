// `LocalWsBackend` — the localhost-Python ASR backend (clip-based transport, per
// PIVOT-PLAN.md). The browser owns capture/VAD/framing (in `Captioner`) exactly
// as in WebGPU mode; this backend just ships each finished utterance clip to a
// local Python server over a WebSocket and resolves with the decoded text.
//
// P1 (this file) is the CLIENT skeleton: the frame codec, the request/response
// correlation, reconnect, and an "unavailable" status when no server answers.
// The Python server that consumes these frames is P2 — until it exists, the
// backend simply reports unavailable and `transcribe` resolves empty (never
// hangs, never silently falls back to WebGPU).
import type { EngineStatus, Word } from "@captions/protocol";
import type { AsrBackend, DecodeResult, LoadOptions } from "./backend.js";

/** Default localhost ASR server (the desktop Python `serve` WS endpoint). */
export const DEFAULT_LOCAL_WS_URL = "ws://127.0.0.1:8765/ws";

// --- binary clip frame (browser -> server) --------------------------------
//
// Layout (little-endian): a fixed 8-byte header then the mono 16 kHz PCM.
//   u32 reqId       correlation token (echoed back in `asrResult`)
//   u8  flags       bit0 = final (1) vs partial (0)
//   u8  format      0 = Float32LE, 1 = Int16LE
//   u16 reserved    0
//   ... PCM samples
// This is a binary side-channel — deliberately NOT part of the JSON/Zod
// protocol (which stays text). P2 formalizes the reply messages below.

export const CLIP_HEADER_BYTES = 8;
export const FLAG_FINAL = 0x01;
export const FMT_F32LE = 0;
export const FMT_I16LE = 1;

export interface ClipFrameOpts {
  /** true for a final utterance decode, false for an interim partial */
  final: boolean;
  /** payload encoding; defaults to Float32LE (Int16LE is an optional halving) */
  format?: number;
}

/** Encode one clip into a wire frame (header + PCM). */
export function encodeClipFrame(
  reqId: number,
  opts: ClipFrameOpts,
  samples: Float32Array,
): ArrayBuffer {
  const format = opts.format ?? FMT_F32LE;
  const bytesPerSample = format === FMT_I16LE ? 2 : 4;
  const buf = new ArrayBuffer(CLIP_HEADER_BYTES + samples.length * bytesPerSample);
  const view = new DataView(buf);
  view.setUint32(0, reqId >>> 0, true);
  view.setUint8(4, opts.final ? FLAG_FINAL : 0);
  view.setUint8(5, format);
  view.setUint16(6, 0, true);
  if (format === FMT_I16LE) {
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]!));
      view.setInt16(CLIP_HEADER_BYTES + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    }
  } else {
    // Float32Array view is host-endian (LE on every platform we target).
    new Float32Array(buf, CLIP_HEADER_BYTES).set(samples);
  }
  return buf;
}

export interface ClipHeader {
  reqId: number;
  final: boolean;
  format: number;
  sampleCount: number;
}

/** Parse just the header (used by the server + tests). */
export function decodeClipHeader(buf: ArrayBuffer): ClipHeader {
  const view = new DataView(buf);
  const format = view.getUint8(5);
  const bytesPerSample = format === FMT_I16LE ? 2 : 4;
  return {
    reqId: view.getUint32(0, true),
    final: (view.getUint8(4) & FLAG_FINAL) !== 0,
    format,
    sampleCount: (buf.byteLength - CLIP_HEADER_BYTES) / bytesPerSample,
  };
}

/** Decode the PCM payload back to Float32 (used by tests; the server does the
 *  equivalent in Python). Int16 is dequantized to [-1, 1). */
export function decodeClipPcm(buf: ArrayBuffer): Float32Array {
  const { format, sampleCount } = decodeClipHeader(buf);
  if (format === FMT_I16LE) {
    const view = new DataView(buf);
    const out = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      out[i] = view.getInt16(CLIP_HEADER_BYTES + i * 2, true) / 0x8000;
    }
    return out;
  }
  return new Float32Array(buf.slice(CLIP_HEADER_BYTES));
}

// --- reply messages (server -> browser, JSON text) -------------------------
// P2 formalizes these in @captions/protocol (+ the Python pydantic mirror);
// kept local for the P1 skeleton so we don't churn the shared protocol yet.
interface AsrResultMsg {
  type: "asrResult";
  reqId: number;
  text: string;
  words?: Word[];
}
interface AsrRefinedMsg {
  type: "asrRefined";
  // Correlates to the original decode by its `reqId` — the server never sees the
  // segment UUID. `LocalWsBackend` maps `reqId → id` locally and fires
  // `onRefine` with the real UUID (see PIVOT-PLAN "Refinement correlation").
  reqId: number;
  text: string;
  words?: Word[];
}
interface AsrStatusMsg {
  type: "asrStatus";
  status: EngineStatus;
}
interface AsrProgressMsg {
  type: "asrProgress";
  loaded: number;
  total: number;
}
type LocalAsrMsg = AsrResultMsg | AsrRefinedMsg | AsrStatusMsg | AsrProgressMsg;

/**
 * Speech recognition via a localhost Python server over WebSocket. Reconnects
 * with a capped backoff (mirrors `@captions/display`'s `WebSocketSource`); while
 * disconnected it reports an "unavailable" status and resolves decodes empty.
 */
export class LocalWsBackend implements AsrBackend {
  private ws: WebSocket | null = null;
  private opened = false;
  private closed = false;
  private retryMs = 500;
  private readonly maxRetryMs = 5000;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // u32 correlation counter (wraps); keys the pending-decode resolvers.
  private reqSeq = 1;
  private pending = new Map<number, (r: DecodeResult) => void>();
  // `reqId → segment UUID` for finals only, so a later `asrRefined{reqId}` can
  // fire `onRefine` with the real segment id. Outlives the immediate resolve;
  // bounded (drop-oldest) so a refine that never arrives can't leak memory.
  private reqToId = new Map<number, string>();
  private static readonly MAX_REFINE_TRACKED = 256;
  private lastModel: { model: string; opts?: LoadOptions } | null = null;

  private statusCb?: (status: EngineStatus) => void;
  private progressCb?: (p: { loaded: number; total: number }) => void;
  private refineCb?: (id: string, result: DecodeResult) => void;

  constructor(private readonly url: string = DEFAULT_LOCAL_WS_URL) {}

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
    this.lastModel = { model, opts };
    this.statusCb?.({ state: "loading", backend: "local-server", model });
    if (this.opened) this.sendLoad();
    else this.open();
  }

  transcribe(
    samples: Float32Array,
    opts: { words: boolean; id: string },
  ): Promise<DecodeResult> {
    // Not connected → resolve empty so the Captioner never stalls waiting on a
    // server that isn't there. (The selector is already showing "unavailable".)
    if (!this.opened || !this.ws) return Promise.resolve({ text: "" });
    const reqId = this.nextReqId();
    // `words` requested ⇔ this is a final decode (partials skip word timing).
    // Only finals get refined, so only finals need the reqId → segment-id map.
    if (opts.words) this.trackRefine(reqId, opts.id);
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      this.ws!.send(encodeClipFrame(reqId, { final: opts.words }, samples));
    });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.opened = false;
    this.failPending();
    this.reqToId.clear();
  }

  private nextReqId(): number {
    const id = this.reqSeq;
    this.reqSeq = this.reqSeq >= 0xffffffff ? 1 : this.reqSeq + 1;
    return id;
  }

  /** Remember `reqId → segment id` for a final decode, evicting the oldest entry
   *  once the cap is hit (a refine that never arrives must not leak). */
  private trackRefine(reqId: number, id: string): void {
    if (this.reqToId.size >= LocalWsBackend.MAX_REFINE_TRACKED) {
      const oldest = this.reqToId.keys().next().value;
      if (oldest !== undefined) this.reqToId.delete(oldest);
    }
    this.reqToId.set(reqId, id);
  }

  private open(): void {
    if (this.closed || this.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.reportUnavailable();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.opened = true;
      this.retryMs = 500;
      if (this.lastModel) this.sendLoad();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => {
      this.opened = false;
      this.ws = null;
      this.failPending();
      this.reportUnavailable();
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
  }

  private sendLoad(): void {
    if (!this.lastModel) return;
    this.ws?.send(
      JSON.stringify({
        type: "asrLoad",
        model: this.lastModel.model,
        debug: this.lastModel.opts?.debug ?? false,
      }),
    );
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return; // server → client is JSON text
    let msg: LocalAsrMsg;
    try {
      msg = JSON.parse(data) as LocalAsrMsg;
    } catch {
      return;
    }
    switch (msg.type) {
      case "asrResult": {
        const resolve = this.pending.get(msg.reqId);
        this.pending.delete(msg.reqId);
        resolve?.({ text: msg.text ?? "", words: msg.words });
        break;
      }
      case "asrRefined": {
        // Map the server's reqId back to the segment UUID the browser owns.
        const id = this.reqToId.get(msg.reqId);
        this.reqToId.delete(msg.reqId);
        if (id !== undefined) this.refineCb?.(id, { text: msg.text ?? "", words: msg.words });
        break;
      }
      case "asrStatus":
        this.statusCb?.(msg.status);
        break;
      case "asrProgress":
        this.progressCb?.({ loaded: msg.loaded, total: msg.total });
        break;
      // P2: an `asrModels` advertisement lands here to populate the model picker.
    }
  }

  private failPending(): void {
    for (const resolve of this.pending.values()) resolve({ text: "" });
    this.pending.clear();
  }

  private reportUnavailable(): void {
    this.statusCb?.({
      state: "error",
      backend: "local-server",
      message: `Local ASR server unavailable at ${this.url}`,
    });
  }
}
