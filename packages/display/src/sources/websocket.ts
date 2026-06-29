import { safeParseServerMessage } from "@captions/protocol";
import type { CaptionSource, ConnectionState } from "./types.js";

/**
 * Receives captions over a WebSocket (desktop mode). Auto-reconnects with a
 * capped backoff so an unattended on-air display recovers if the server blips.
 *
 * Reports {@link ConnectionState} transitions so a viewer can show live /
 * reconnecting status.
 */
export class WebSocketSource implements CaptionSource {
  private ws: WebSocket | null = null;
  private onMessage: ((msg: import("@captions/protocol").ServerMessage) => void) | null = null;
  private onState: ((state: ConnectionState) => void) | null = null;
  private closed = false;
  private retryMs = 500;
  private readonly maxRetryMs = 5000;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string) {}

  connect(
    onMessage: (msg: import("@captions/protocol").ServerMessage) => void,
    onState?: (state: ConnectionState) => void,
  ): void {
    this.onMessage = onMessage;
    this.onState = onState ?? null;
    this.setState("connecting");
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
      this.setState("open");
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.setState("reconnecting");
    this.timer = setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
  }

  private setState(state: ConnectionState): void {
    this.onState?.(state);
  }

  disconnect(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setState("closed");
  }
}
