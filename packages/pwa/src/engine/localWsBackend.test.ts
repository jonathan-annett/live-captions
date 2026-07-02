import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineStatus } from "@captions/protocol";
import {
  CLIP_HEADER_BYTES,
  decodeClipHeader,
  decodeClipPcm,
  encodeClipFrame,
  FMT_F32LE,
  FMT_I16LE,
  LocalWsBackend,
} from "./localWsBackend.js";

describe("clip frame codec", () => {
  it("round-trips a Float32LE frame with the documented header layout", () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buf = encodeClipFrame(0xdeadbeef, { final: true }, pcm);

    expect(buf.byteLength).toBe(CLIP_HEADER_BYTES + pcm.length * 4);
    const h = decodeClipHeader(buf);
    expect(h.reqId).toBe(0xdeadbeef);
    expect(h.final).toBe(true);
    expect(h.format).toBe(FMT_F32LE);
    expect(h.sampleCount).toBe(pcm.length);
    // Float32 is exact through the round-trip.
    expect(Array.from(decodeClipPcm(buf))).toEqual(Array.from(pcm));
  });

  it("marks partial frames (final bit clear) and defaults to Float32LE", () => {
    const h = decodeClipHeader(encodeClipFrame(7, { final: false }, new Float32Array(3)));
    expect(h.final).toBe(false);
    expect(h.format).toBe(FMT_F32LE);
    expect(h.reqId).toBe(7);
  });

  it("round-trips Int16LE within quantization tolerance", () => {
    const pcm = new Float32Array([0, 0.25, -0.25, 0.999]);
    const buf = encodeClipFrame(1, { final: true, format: FMT_I16LE }, pcm);
    expect(buf.byteLength).toBe(CLIP_HEADER_BYTES + pcm.length * 2);
    const out = decodeClipPcm(buf);
    for (let i = 0; i < pcm.length; i++) {
      expect(out[i]!).toBeCloseTo(pcm[i]!, 3);
    }
  });
});

// Minimal WebSocket stand-in: capture sends, drive open/message/close by hand.
class MockWebSocket {
  static last: MockWebSocket | null = null;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor(public url: string) {
    MockWebSocket.last = this;
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
  fireOpen(): void {
    this.onopen?.();
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

describe("LocalWsBackend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWebSocket.last = null;
  });

  it("correlates a decode response by reqId", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const backend = new LocalWsBackend("ws://localhost:9999/ws");
    await backend.load("small.en");
    const ws = MockWebSocket.last!;
    ws.fireOpen();

    const pending = backend.transcribe(new Float32Array([0.1, 0.2, 0.3]), {
      words: true,
      id: "seg-abc",
    });
    // The transcribe frame was sent as binary; recover its reqId to reply.
    const frame = ws.sent.find((s) => s instanceof ArrayBuffer) as ArrayBuffer;
    expect(frame).toBeInstanceOf(ArrayBuffer);
    const { reqId, final } = decodeClipHeader(frame);
    expect(final).toBe(true); // words:true ⇒ final

    ws.fireMessage(JSON.stringify({ type: "asrResult", reqId, text: "hello world" }));
    await expect(pending).resolves.toEqual({ text: "hello world", words: undefined });
  });

  it("maps a refined result's reqId back to the segment UUID", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const backend = new LocalWsBackend("ws://localhost:9999/ws");
    const refined: Array<{ id: string; text: string }> = [];
    backend.onRefine((id, r) => refined.push({ id, text: r.text }));
    await backend.load("small.en");
    const ws = MockWebSocket.last!;
    ws.fireOpen();

    // A final decode registers the reqId → segment-id mapping.
    void backend.transcribe(new Float32Array([0.1]), { words: true, id: "seg-42" });
    const { reqId } = decodeClipHeader(ws.sent.find((s) => s instanceof ArrayBuffer) as ArrayBuffer);

    // The server refines it later, referencing only the reqId (never the UUID).
    ws.fireMessage(JSON.stringify({ type: "asrRefined", reqId, text: "refined text" }));
    expect(refined).toEqual([{ id: "seg-42", text: "refined text" }]);
  });

  it("does not track partials for refinement (no mapping ⇒ no onRefine)", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const backend = new LocalWsBackend("ws://localhost:9999/ws");
    const refined: string[] = [];
    backend.onRefine((id) => refined.push(id));
    await backend.load("small.en");
    const ws = MockWebSocket.last!;
    ws.fireOpen();

    // A partial (words:false) is not refinable and registers no mapping.
    void backend.transcribe(new Float32Array([0.1]), { words: false, id: "seg-partial" });
    const { reqId, final } = decodeClipHeader(
      ws.sent.find((s) => s instanceof ArrayBuffer) as ArrayBuffer,
    );
    expect(final).toBe(false);

    // An (erroneous) refine for that reqId has no mapping → onRefine must not fire.
    ws.fireMessage(JSON.stringify({ type: "asrRefined", reqId, text: "x" }));
    expect(refined).toEqual([]);
  });

  it("reports 'unavailable' (never falls back) when the socket closes", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const statuses: EngineStatus[] = [];
    const backend = new LocalWsBackend("ws://localhost:9999/ws");
    backend.onStatus((s) => statuses.push(s));
    await backend.load("small.en");
    MockWebSocket.last!.close(); // connection refused

    const unavailable = statuses.find((s) => s.state === "error" && s.backend === "local-server");
    expect(unavailable).toBeTruthy();
    expect(unavailable!.message).toContain("unavailable");
    backend.close();
  });

  it("resolves decodes empty while disconnected (no hang)", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const backend = new LocalWsBackend();
    // No load()/open() → not connected.
    await expect(
      backend.transcribe(new Float32Array([0.1]), { words: false, id: "seg-x" }),
    ).resolves.toEqual({ text: "" });
  });

  it("ignores a refined result for an unknown reqId (never crashes)", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const backend = new LocalWsBackend();
    const refined: string[] = [];
    backend.onRefine((id) => refined.push(id));
    await backend.load("small.en");
    MockWebSocket.last!.fireOpen();
    // No transcribe was issued, so reqId 999 maps to nothing.
    MockWebSocket.last!.fireMessage(JSON.stringify({ type: "asrRefined", reqId: 999, text: "x" }));
    expect(refined).toEqual([]);
  });
});
