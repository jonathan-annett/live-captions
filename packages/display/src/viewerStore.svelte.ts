import {
  DEFAULT_DISPLAY_CONFIG,
  type CaptionSegment,
  type DisplayConfig,
  type EngineStatus,
  type ServerMessage,
} from "@captions/protocol";
import { ViewerLog } from "./viewerLog.js";

/**
 * Reactive wrapper over {@link ViewerLog} for the v2 mobile viewer UI (Phase C).
 *
 * The log holds the canonical (uncapped, upsert-by-id) state; this exposes
 * Svelte 5 `$state` snapshots the UI can bind to, refreshed from the log on
 * each applied message. Segment list refresh is gated to the messages that
 * actually mutate it, so the live partial stream stays cheap.
 */
export class ViewerStore {
  private readonly log = new ViewerLog();

  segments = $state<CaptionSegment[]>([]);
  partial = $state<CaptionSegment | null>(null);
  config = $state<DisplayConfig>(DEFAULT_DISPLAY_CONFIG);
  status = $state<EngineStatus | null>(null);

  apply = (msg: ServerMessage): void => {
    this.log.apply(msg);
    if (msg.type === "final" || msg.type === "history" || msg.type === "clear") {
      this.segments = this.log.segments;
    }
    this.partial = this.log.partial;
    this.config = this.log.config;
    this.status = this.log.status;
  };
}
