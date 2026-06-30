import {
  safeParseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@captions/protocol";
import type { ConnectionState } from "./sources/types.js";

/**
 * Bidirectional control socket for the desktop control panel: receives the
 * caption ServerMessage stream (for the live preview) AND sends ClientMessages
 * (setConfig / setDictionary / command) back to the desktop server's /ws.
 *
 * Unlike {@link WebSocketSource} (receive-only), this can send; messages issued
 * while disconnected are queued and flushed on (re)connect. Auto-reconnects with
 * a capped backoff.
 */
export class ControlSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 500;
  private readonly maxRetryMs = 5000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending: string[] = [];

  constructor(
    private readonly url: string,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onState?: (s: ConnectionState) => void,
  ) {}

  connect(): void {
    this.onState?.("connecting");
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev) => {
      const msg = safeParseServerMessage(ev.data);
      if (msg) this.onMessage(msg);
    };
    this.ws.onopen = () => {
      this.retryMs = 500;
      this.onState?.("open");
      for (const data of this.pending.splice(0)) this.ws?.send(data);
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.onState?.("reconnecting");
    this.timer = setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
  }

  /** Send a control message (queued + flushed on reconnect if not yet open). */
  send(msg: ClientMessage): void {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.pending.push(data);
  }

  disconnect(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
