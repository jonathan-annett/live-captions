import { BroadcastChannelSource } from "./broadcast.js";
import { MockSource } from "./mock.js";
import { RoomSource, roomSubscribeUrl } from "./room.js";
import type { CaptionSource } from "./types.js";
import { WebSocketSource } from "./websocket.js";

export type { CaptionSource } from "./types.js";
export { BroadcastChannelSource, MockSource, RoomSource, roomSubscribeUrl, WebSocketSource };

/**
 * Build the caption source from URL params, so the same display page serves
 * every mode:
 *   ?source=broadcast&channel=captions
 *   ?source=ws&url=ws://localhost:8765/ws
 *   ?source=room&room=<id>[&base=<origin>]    (audience viewer)
 *   ?source=room&url=<subscribeUrl>
 *   ?source=mock                              (default)
 */
export function createSourceFromUrl(search = window.location.search): CaptionSource {
  const params = new URLSearchParams(search);
  const kind = params.get("source") ?? "mock";

  switch (kind) {
    case "broadcast":
      return new BroadcastChannelSource(params.get("channel") ?? "captions");
    case "ws": {
      const url =
        params.get("url") ??
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
      return new WebSocketSource(url);
    }
    case "room": {
      const url = params.get("url");
      if (url) return new RoomSource(url);
      const room = params.get("room");
      if (room) return RoomSource.forRoom(room, params.get("base") ?? undefined);
      throw new Error("source=room requires ?room=<id> or ?url=<subscribeUrl>");
    }
    case "mock":
    default:
      return new MockSource();
  }
}
