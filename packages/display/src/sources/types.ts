import type { ServerMessage } from "@captions/protocol";

/** Transport connection lifecycle, surfaced to the UI (e.g. the audience viewer). */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

/**
 * A transport that delivers caption messages to the display.
 *
 * The display is identical across builds; only the source differs:
 *  - PWA:      BroadcastChannel (engine runs in a sibling tab/window)
 *  - Desktop:  WebSocket (Python server pushes captions)
 *  - Room:     WebSocket to a CaptionRoom (audience viewer)
 *  - Dev:      Mock (scripted partial/final sequences)
 */
export interface CaptionSource {
  /**
   * Begin receiving messages. May be called once.
   * @param onMessage caption stream handler
   * @param onState optional connection-state observer (for status UI)
   */
  connect(
    onMessage: (msg: ServerMessage) => void,
    onState?: (state: ConnectionState) => void,
  ): void;
  /** Stop and release resources. */
  disconnect(): void;
}
