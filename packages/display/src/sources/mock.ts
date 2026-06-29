import type { ServerMessage } from "@captions/protocol";
import type { CaptionSource } from "./types.js";

const SCRIPT = [
  "Welcome everyone to tonight's event.",
  "We're thrilled to have such a fantastic crowd here with us.",
  "These captions are generated entirely on device.",
  "No audio ever leaves this machine.",
  "Let's get started.",
];

/**
 * Dev source: simulates a live engine by streaming word-by-word partials that
 * commit to finals. Lets us build and tune the display with no ASR running.
 */
export class MockSource implements CaptionSource {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;

  connect(onMessage: (msg: ServerMessage) => void): void {
    let clock = 0; // seconds from session start
    let delay = 400;
    const at = (ms: number, fn: () => void) => {
      this.timers.push(setTimeout(fn, ms));
    };

    SCRIPT.forEach((sentence, i) => {
      const id = `mock-${i}`;
      const words = sentence.split(" ");
      const start = clock;
      // Stream growing partials.
      words.forEach((_, w) => {
        at(delay, () => {
          if (this.stopped) return;
          onMessage({
            type: "partial",
            segment: {
              id,
              text: words.slice(0, w + 1).join(" "),
              start,
              end: start + (w + 1) * 0.3,
            },
          });
        });
        delay += 220;
      });
      // Commit the final.
      delay += 200;
      const end = start + words.length * 0.3;
      at(delay, () => {
        if (this.stopped) return;
        onMessage({ type: "final", segment: { id, text: sentence, start, end } });
      });
      delay += 700;
      clock = end + 0.5;
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}
