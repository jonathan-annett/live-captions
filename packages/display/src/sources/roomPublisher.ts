import type { ServerMessage } from "@captions/protocol";
import type { ConnectionState } from "./types.js";

/** Cap the offline buffer so a long disconnect can't grow memory without bound. */
const MAX_QUEUE = 500;

/**
 * Publishes a caption stream to a `CaptionRoom` over the token-gated
 * `/r/:id/publish` WebSocket — the source half of the v2 audience layer.
 *
 * Mirrors {@link WebSocketSource}'s capped-backoff reconnect, but outbound: the
 * caller pumps {@link ServerMessage}s in via {@link publish}. Messages produced
 * while the socket is down are buffered (oldest dropped past {@link MAX_QUEUE})
 * and flushed on (re)connect, so a brief blip doesn't lose finals.
 *
 * Used by both clients (PWA captioner tee, desktop hub) — see DEPLOY.md.
 */
export class RoomPublisher {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 500;
  private readonly maxRetryMs = 5000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];

  constructor(
    private readonly publishUrl: string,
    private readonly onState?: (state: ConnectionState) => void,
  ) {}

  /** Open the publish socket (idempotent). */
  start(): void {
    this.closed = false;
    this.setState("connecting");
    this.open();
  }

  /** Enqueue a message; sent immediately if connected, else buffered. */
  publish(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.queue.push(data);
      if (this.queue.length > MAX_QUEUE) this.queue.shift();
    }
  }

  private open(): void {
    if (this.closed) return;
    this.ws = new WebSocket(this.publishUrl);
    this.ws.onopen = () => {
      this.retryMs = 500;
      this.setState("open");
      this.flush();
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => this.ws?.close();
  }

  private flush(): void {
    const pending = this.queue;
    this.queue = [];
    for (const data of pending) this.ws?.send(data);
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

  /** Close the socket and stop reconnecting. */
  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setState("closed");
  }
}

/**
 * Compose a room publish URL (token-gated). `base` may be any http(s)/ws(s)
 * origin; it is normalized to ws(s). Without it, the page origin is used.
 */
export function roomPublishUrl(roomId: string, token: string, base?: string): string {
  const origin =
    base ?? (typeof location !== "undefined" ? location.origin : "");
  const wsOrigin = origin.replace(/^http/, "ws").replace(/\/$/, "");
  return `${wsOrigin}/r/${encodeURIComponent(roomId)}/publish?token=${encodeURIComponent(token)}`;
}
