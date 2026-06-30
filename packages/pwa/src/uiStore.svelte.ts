import {
  canReplaceSegment,
  type CaptionSegment,
  type EngineStatus,
  type ServerMessage,
} from "@captions/protocol";

/** Mirrors the caption stream into reactive state for the control UI preview. */
export class UiStore {
  status = $state<EngineStatus>({ state: "idle" });
  finals = $state<CaptionSegment[]>([]);
  partial = $state<CaptionSegment | null>(null);

  apply = (msg: ServerMessage): void => {
    switch (msg.type) {
      case "status":
        this.status = msg.status;
        break;
      case "final":
        this.partial = null;
        // Keep the full session transcript for export (preview slices the tail).
        // Upsert by id so an operator correction replaces in place, not appends.
        this.upsert(msg.segment);
        break;
      case "partial":
        this.partial = msg.segment;
        break;
      case "clear":
        this.finals = [];
        this.partial = null;
        break;
      default:
        break;
    }
  };

  /** Upsert a final by id: an operator correction replaces its segment in place
   *  (never clobbering a locked one with a non-locked engine re-emit). */
  private upsert(seg: CaptionSegment): void {
    const i = this.finals.findIndex((s) => s.id === seg.id);
    if (i === -1) {
      this.finals.push(seg);
      if (this.finals.length > 10000) this.finals = this.finals.slice(-10000);
      return;
    }
    if (canReplaceSegment(this.finals[i], seg)) this.finals[i] = seg;
  }
}
