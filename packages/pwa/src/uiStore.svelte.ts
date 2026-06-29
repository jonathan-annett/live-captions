import type {
  CaptionSegment,
  EngineStatus,
  ServerMessage,
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
        this.finals.push(msg.segment);
        if (this.finals.length > 50) this.finals = this.finals.slice(-50);
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
}
