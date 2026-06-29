import type { ServerMessage } from "@captions/protocol";

/**
 * A transport that delivers caption messages to the display.
 *
 * The display is identical across builds; only the source differs:
 *  - PWA:      BroadcastChannel (engine runs in a sibling tab/window)
 *  - Desktop:  WebSocket (Python server pushes captions)
 *  - Dev:      Mock (scripted partial/final sequences)
 */
export interface CaptionSource {
  /** Begin receiving messages. May be called once. */
  connect(onMessage: (msg: ServerMessage) => void): void;
  /** Stop and release resources. */
  disconnect(): void;
}
