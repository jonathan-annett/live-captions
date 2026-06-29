import type { CaptionSegment } from "@captions/protocol";
import { describe, expect, it } from "vitest";
import { roomSubscribeUrl } from "./sources/room.js";
import { roomPublishUrl } from "./sources/roomPublisher.js";
import { ViewerLog } from "./viewerLog.js";

const seg = (id: string, text: string, start = 0, end = 1): CaptionSegment => ({
  id,
  text,
  start,
  end,
});

describe("ViewerLog (upsert-by-id, uncapped)", () => {
  it("appends new finals in arrival order", () => {
    const log = new ViewerLog();
    log.apply({ type: "final", segment: seg("a", "hello", 0, 1) });
    log.apply({ type: "final", segment: seg("b", "world", 1, 2) });
    expect(log.segments.map((s) => s.text)).toEqual(["hello", "world"]);
    expect(log.size).toBe(2);
  });

  it("replaces in place on a repeated id (correction/refinement)", () => {
    const log = new ViewerLog();
    log.apply({ type: "final", segment: seg("a", "helo", 0, 1) });
    log.apply({ type: "final", segment: seg("a", "hello", 0, 1) });
    expect(log.size).toBe(1);
    expect(log.segments[0]?.text).toBe("hello");
  });

  it("is uncapped (keeps the whole session)", () => {
    const log = new ViewerLog();
    for (let i = 0; i < 1000; i++) {
      log.apply({ type: "final", segment: seg(`s${i}`, `t${i}`, i, i + 1) });
    }
    expect(log.size).toBe(1000);
  });

  it("drops the partial once its id is finalized", () => {
    const log = new ViewerLog();
    log.apply({ type: "partial", segment: seg("a", "hel") });
    expect(log.partial?.text).toBe("hel");
    log.apply({ type: "final", segment: seg("a", "hello") });
    expect(log.partial).toBeNull();
    expect(log.segments[0]?.text).toBe("hello");
  });

  it("merges a history batch by id without duplicating", () => {
    const log = new ViewerLog();
    log.apply({ type: "final", segment: seg("a", "a") });
    log.apply({ type: "history", segments: [seg("a", "A"), seg("b", "B")] });
    expect(log.size).toBe(2);
    expect(log.segments.map((s) => s.text)).toEqual(["A", "B"]);
  });

  it("clear empties the log and partial", () => {
    const log = new ViewerLog();
    log.apply({ type: "final", segment: seg("a", "a") });
    log.apply({ type: "partial", segment: seg("b", "b") });
    log.apply({ type: "clear" });
    expect(log.size).toBe(0);
    expect(log.partial).toBeNull();
  });

  it("tracks config and status", () => {
    const log = new ViewerLog();
    log.apply({ type: "status", status: { state: "listening" } });
    expect(log.status?.state).toBe("listening");
  });
});

describe("roomSubscribeUrl", () => {
  it("normalizes an http(s) base to ws(s)", () => {
    expect(roomSubscribeUrl("abc", "https://v2.caption.guru")).toBe(
      "wss://v2.caption.guru/r/abc/subscribe",
    );
  });

  it("leaves a ws(s) base scheme intact and trims a trailing slash", () => {
    expect(roomSubscribeUrl("abc", "ws://localhost:8787/")).toBe(
      "ws://localhost:8787/r/abc/subscribe",
    );
  });

  it("url-encodes the room id", () => {
    expect(roomSubscribeUrl("a b", "http://x")).toBe("ws://x/r/a%20b/subscribe");
  });
});

describe("roomPublishUrl", () => {
  it("includes the token and normalizes scheme", () => {
    expect(roomPublishUrl("abc", "tok123", "https://v2.caption.guru")).toBe(
      "wss://v2.caption.guru/r/abc/publish?token=tok123",
    );
  });

  it("url-encodes the room id and token", () => {
    expect(roomPublishUrl("a b", "t/k", "http://x")).toBe(
      "ws://x/r/a%20b/publish?token=t%2Fk",
    );
  });
});
