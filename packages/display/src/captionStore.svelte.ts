import {
  canReplaceSegment,
  DEFAULT_DISPLAY_CONFIG,
  type CaptionSegment,
  type DisplayConfig,
  type EngineStatus,
  type ServerMessage,
} from "@captions/protocol";

/** Keep a bounded buffer of finals in the display (server owns full history). */
const MAX_BUFFER = 200;
/** Lines rendered into a fixed caption box — more than fit, so CSS clips the
 * top for a smooth scroll-up effect (bounded so the DOM stays small). */
const CLIP_LINES = 40;

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
        // Ignore blank/whitespace partials so they can't wipe a good line.
        if (msg.segment.text.trim()) this.partial = msg.segment;
        break;
      case "final":
        // A finalize still clears its partial, but a blank final is never
        // buffered (it would eat a maxLines slot and look like the screen clearing).
        if (this.partial?.id === msg.segment.id) this.partial = null;
        if (!msg.segment.text.trim()) break;
        this.upsert(msg.segment);
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

  /** Upsert a final by id: replace in place (operator correction / refinement)
   *  rather than appending a duplicate; an operator-locked segment is never
   *  clobbered by a non-locked update. New ids append, bounded by MAX_BUFFER. */
  private upsert(seg: CaptionSegment): void {
    const i = this.segments.findIndex((s) => s.id === seg.id);
    if (i === -1) {
      this.segments.push(seg);
      if (this.segments.length > MAX_BUFFER) {
        this.segments = this.segments.slice(-MAX_BUFFER);
      }
      return;
    }
    if (canReplaceSegment(this.segments[i], seg)) this.segments[i] = seg;
  }

  /** Filtered finals + (optional) partial, newest last, with stable keys. */
  private buildLines(): { key: string; text: string; partial: boolean }[] {
    // Defensive: never render an empty line (e.g. a blank slipping in via history).
    const out = this.segments
      .filter((s) => s.text.trim() !== "")
      .map((s) => ({ key: s.id, text: s.text, partial: false }));
    // The partial (un-finalized "bleeding-edge" hypothesis) is hidden when the
    // operator turns showPartial off — a bit more latency, fewer visible errors.
    if (this.partial && this.config.showPartial && this.partial.text.trim()) {
      out.push({ key: "partial", text: this.partial.text, partial: true });
    }
    return out;
  }

  /** On-air rolling lines: trailing finals plus the partial, bounded by maxLines. */
  get lines(): { key: string; text: string; partial: boolean }[] {
    return this.buildLines().slice(-this.config.maxLines);
  }

  /** Deeper recent window for a fixed caption box — rendered bottom-anchored and
   * clipped by CSS, so older text scrolls off the top instead of resizing the box. */
  get recentLines(): { key: string; text: string; partial: boolean }[] {
    return this.buildLines().slice(-CLIP_LINES);
  }
}
