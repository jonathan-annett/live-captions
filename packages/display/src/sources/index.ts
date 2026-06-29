import { BroadcastChannelSource } from "./broadcast.js";
import { MockSource } from "./mock.js";
import type { CaptionSource } from "./types.js";
import { WebSocketSource } from "./websocket.js";

export type { CaptionSource } from "./types.js";
export { BroadcastChannelSource, MockSource, WebSocketSource };

/**
 * Build the caption source from URL params, so the same display page serves
 * every mode:
 *   ?source=broadcast&channel=captions
 *   ?source=ws&url=ws://localhost:8765/ws
 *   ?source=mock                          (default)
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
    case "mock":
    default:
      return new MockSource();
  }
}
