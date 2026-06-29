import { safeParseServerMessage } from "@captions/protocol";
import type { CaptionSource } from "./types.js";

/**
 * Receives captions over a WebSocket (desktop mode). Auto-reconnects with a
 * capped backoff so an unattended on-air display recovers if the server blips.
 */
export class WebSocketSource implements CaptionSource {
  private ws: WebSocket | null = null;
  private onMessage: Parameters<CaptionSource["connect"]>[0] | null = null;
  private closed = false;
  private retryMs = 500;
  private readonly maxRetryMs = 5000;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string) {}

  connect(onMessage: Parameters<CaptionSource["connect"]>[0]): void {
    this.onMessage = onMessage;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev) => {
      const msg = safeParseServerMessage(ev.data);
      if (msg && this.onMessage) this.onMessage(msg);
    };
    this.ws.onopen = () => {
      this.retryMs = 500;
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
  }

  disconnect(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
