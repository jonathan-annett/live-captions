import type { ConnectionState } from "./sources/types.js";

/**
 * Pure presentation helpers for the audience viewer, split out so the
 * follow-live and status logic is unit-testable without a DOM.
 */

/**
 * Whether the scroll position is at (or within `threshold` px of) the bottom —
 * i.e. the viewer should keep auto-following new captions. Scrolling up to read
 * back puts the user beyond the threshold and pauses following.
 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 80,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

export interface ConnectionView {
  /** Short status label for the indicator. */
  label: string;
  /** True only when the stream is connected and flowing. */
  live: boolean;
}

/** Map a transport state to a viewer status indicator. */
export function connectionView(state: ConnectionState): ConnectionView {
  switch (state) {
    case "open":
      return { label: "Live", live: true };
    case "connecting":
      return { label: "Connecting…", live: false };
    case "reconnecting":
      return { label: "Reconnecting…", live: false };
    case "closed":
      return { label: "Disconnected", live: false };
  }
}
