import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@captions/protocol";
import { RoomPublisher } from "./roomPublisher.js";

/** Minimal WebSocket stand-in: captures sends, lets the test drive open/close. */
class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
}

const msg = (o: object): ServerMessage => o as unknown as ServerMessage;

afterEach(() => {
  FakeWS.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function useFakeWs(): void {
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
}

describe("RoomPublisher re-seed", () => {
  it("sends the seed snapshot before flushing the queue on connect", () => {
    useFakeWs();
    const seed = vi.fn((): ServerMessage[] => [
      msg({ type: "config", config: {} }),
      msg({ type: "history", segments: [] }),
    ]);
    const pub = new RoomPublisher("wss://x/publish", { seed });
    // A message produced before the socket opens is queued.
    pub.publish(msg({ type: "final", segment: { id: "a" } }));
    pub.start();
    FakeWS.instances.at(-1)!.open();

    expect(seed).toHaveBeenCalledTimes(1);
    const types = FakeWS.instances.at(-1)!.sent.map((s) => JSON.parse(s).type);
    // config + history first (seed), then the queued final.
    expect(types).toEqual(["config", "history", "final"]);
  });

  it("re-seeds again on reconnect", () => {
    useFakeWs();
    vi.useFakeTimers();
    const seed = vi.fn((): ServerMessage[] => [msg({ type: "config", config: {} })]);
    const pub = new RoomPublisher("wss://x", { seed });
    pub.start();
    FakeWS.instances.at(-1)!.open();
    expect(seed).toHaveBeenCalledTimes(1);

    FakeWS.instances.at(-1)!.close(); // schedules a reconnect
    vi.advanceTimersByTime(600);
    FakeWS.instances.at(-1)!.open(); // the reconnected socket
    expect(seed).toHaveBeenCalledTimes(2);
  });

  it("still accepts a bare onState callback (back-compat)", () => {
    useFakeWs();
    const states: string[] = [];
    const pub = new RoomPublisher("wss://x", (s) => states.push(s));
    pub.start();
    FakeWS.instances.at(-1)!.open();
    expect(states).toContain("open");
  });
});
