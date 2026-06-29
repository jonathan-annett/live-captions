import { safeParseServerMessage } from "@captions/protocol";
import type { CaptionSource } from "./types.js";

/** Receives captions over a same-origin BroadcastChannel (PWA mode). */
export class BroadcastChannelSource implements CaptionSource {
  private channel: BroadcastChannel | null = null;

  constructor(private readonly name: string) {}

  connect(onMessage: Parameters<CaptionSource["connect"]>[0]): void {
    this.channel = new BroadcastChannel(this.name);
    this.channel.onmessage = (ev) => {
      const msg = safeParseServerMessage(ev.data);
      if (msg) onMessage(msg);
    };
  }

  disconnect(): void {
    this.channel?.close();
    this.channel = null;
  }
}
