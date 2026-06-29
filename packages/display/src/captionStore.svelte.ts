import {
  DEFAULT_DISPLAY_CONFIG,
  type CaptionSegment,
  type DisplayConfig,
  type EngineStatus,
  type ServerMessage,
} from "@captions/protocol";

/** Keep a bounded buffer of finals in the display (server owns full history). */
const MAX_BUFFER = 200;

/**
 * Reactive caption state. Applies protocol messages to a renderable view:
 * a buffer of finalized segments plus the live (un-finalized) partial.
 */
export class CaptionStore {
  segments = $state<CaptionSegment[]>([]);
  partial = $state<CaptionSegment | null>(null);
  config = $state<DisplayConfig>(DEFAULT_DISPLAY_CONFIG);
  status = $state<EngineStatus | null>(null);

  apply = (msg: ServerMessage): void => {
    switch (msg.type) {
      case "partial":
        this.partial = msg.segment;
        break;
      case "final":
        if (this.partial?.id === msg.segment.id) this.partial = null;
        this.segments.push(msg.segment);
        if (this.segments.length > MAX_BUFFER) {
          this.segments = this.segments.slice(-MAX_BUFFER);
        }
        break;
      case "clear":
        this.segments = [];
        this.partial = null;
        break;
      case "config":
        this.config = msg.config;
        break;
      case "status":
        this.status = msg.status;
        break;
      case "history":
        this.segments = msg.segments.slice(-MAX_BUFFER);
        break;
    }
  };

  /** Lines to render: trailing finals plus the partial, bounded by maxLines. */
  get lines(): { text: string; partial: boolean }[] {
    const out: { text: string; partial: boolean }[] = this.segments.map((s) => ({
      text: s.text,
      partial: false,
    }));
    if (this.partial && this.config.showPartial) {
      out.push({ text: this.partial.text, partial: true });
    }
    return out.slice(-this.config.maxLines);
  }
}
