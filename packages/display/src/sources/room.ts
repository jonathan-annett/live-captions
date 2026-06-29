import type { CaptionSource } from "./types.js";
import { WebSocketSource } from "./websocket.js";

/**
 * Audience subscription to a `CaptionRoom` (v2 audience layer).
 *
 * A room re-emits the same {@link ServerMessage} stream the display already
 * speaks, so a subscriber is just a {@link WebSocketSource} pointed at the
 * open `/r/:id/subscribe` endpoint — no new transport. RoomSource reuses it
 * (and its capped-backoff auto-reconnect) and only owns URL construction.
 */
export class RoomSource implements CaptionSource {
  private readonly ws: WebSocketSource;

  constructor(subscribeUrl: string) {
    this.ws = new WebSocketSource(subscribeUrl);
  }

  /** Build from a room id (+ optional base origin; defaults to page origin). */
  static forRoom(roomId: string, base?: string): RoomSource {
    return new RoomSource(roomSubscribeUrl(roomId, base));
  }

  connect(
    onMessage: Parameters<CaptionSource["connect"]>[0],
    onState?: Parameters<CaptionSource["connect"]>[1],
  ): void {
    this.ws.connect(onMessage, onState);
  }

  disconnect(): void {
    this.ws.disconnect();
  }
}

/**
 * Compose a room subscribe URL. `base` may be any http(s)/ws(s) origin; it is
 * normalized to ws(s). Without it, the current page origin is used (so the
 * viewer is same-origin with whatever channel served it — see DEPLOY.md
 * "Release channels").
 */
export function roomSubscribeUrl(roomId: string, base?: string): string {
  const origin =
    base ?? (typeof location !== "undefined" ? location.origin : "");
  const wsOrigin = origin.replace(/^http/, "ws").replace(/\/$/, "");
  return `${wsOrigin}/r/${encodeURIComponent(roomId)}/subscribe`;
}
