import {
  DEFAULT_DISPLAY_CONFIG,
  type CaptionSegment,
  type DisplayConfig,
  type EngineStatus,
  type ServerMessage,
} from "@captions/protocol";

/**
 * Audience-side canonical log: an **uncapped**, in-memory, **upsert-by-id**
 * store of finalized caption segments (for scrollback) plus the live partial
 * tail. The data layer for the v2 mobile viewer.
 *
 * Contrast with {@link CaptionStore}, which is *bounded* — it only renders the
 * on-air tail, so the server owns history. A viewer instead keeps the whole
 * session locally so the audience can scroll back. A `final` with a known id
 * **replaces in place** (background refinement / operator correction) rather
 * than appending a duplicate — the same upsert-by-id contract the room enforces.
 *
 * Pure TypeScript (no Svelte runes) so it is directly unit-testable; the
 * reactive {@link ViewerStore} wraps it for the UI.
 */
export class ViewerLog {
  /** segment ids in arrival order (chronological for live capture) */
  private readonly order: string[] = [];
  private readonly byId = new Map<string, CaptionSegment>();

  partial: CaptionSegment | null = null;
  config: DisplayConfig = DEFAULT_DISPLAY_CONFIG;
  status: EngineStatus | null = null;

  apply(msg: ServerMessage): void {
    switch (msg.type) {
      case "partial":
        this.partial = msg.segment;
        break;
      case "final":
        // A finalized segment supersedes the partial it grew from.
        if (this.partial?.id === msg.segment.id) this.partial = null;
        this.upsert(msg.segment);
        break;
      case "history":
        // Replay / refinement batch — merge each by id (no duplicates).
        for (const seg of msg.segments) this.upsert(seg);
        break;
      case "clear":
        this.order.length = 0;
        this.byId.clear();
        this.partial = null;
        break;
      case "config":
        this.config = msg.config;
        break;
      case "status":
        this.status = msg.status;
        break;
    }
  }

  private upsert(seg: CaptionSegment): void {
    if (!this.byId.has(seg.id)) this.order.push(seg.id);
    this.byId.set(seg.id, seg);
  }

  /** Finalized segments in chronological order (uncapped). */
  get segments(): CaptionSegment[] {
    return this.order.map((id) => this.byId.get(id)!);
  }

  /** Count of distinct finalized segments retained. */
  get size(): number {
    return this.order.length;
  }
}
