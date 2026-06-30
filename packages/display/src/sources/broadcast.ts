import { safeParseServerMessage } from "@captions/protocol";
import type { CaptionSource } from "./types.js";

/** Receives captions over a same-origin BroadcastChannel (PWA mode). */
export class BroadcastChannelSource implements CaptionSource {
  private channel: BroadcastChannel | null = null;

  constructor(private readonly name: string) {}

  connect(
    onMessage: Parameters<CaptionSource["connect"]>[0],
    onState?: Parameters<CaptionSource["connect"]>[1],
  ): void {
    this.channel = new BroadcastChannel(this.name);
    this.channel.onmessage = (ev) => {
      const msg = safeParseServerMessage(ev.data);
      if (msg) onMessage(msg);
    };
    // Same-origin channel: effectively always connected.
    onState?.("open");
    // BroadcastChannel has no replay, so a display opened after the controller's
    // last config broadcast would miss it (stuck on defaults). Announce on
    // connect so the controller re-sends the current display config.
    this.channel.postMessage({ type: "requestConfig" });
  }

  disconnect(): void {
    this.channel?.close();
    this.channel = null;
  }
}
