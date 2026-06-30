import { describe, expect, it } from "vitest";
import {
  canReplaceSegment,
  DEFAULT_DISPLAY_CONFIG,
  joinSegments,
  parseClientMessage,
  parseServerMessage,
  safeParseServerMessage,
  type CaptionSegment,
  type ServerMessage,
} from "./index.js";

describe("server messages", () => {
  it("round-trips a final segment through JSON", () => {
    const msg: ServerMessage = {
      type: "final",
      segment: {
        id: "seg-1",
        text: "hello world",
        start: 0.5,
        end: 1.8,
        words: [
          { text: "hello", start: 0.5, end: 1.0 },
          { text: "world", start: 1.0, end: 1.8 },
        ],
      },
    };
    const parsed = parseServerMessage(JSON.stringify(msg));
    expect(parsed).toEqual(msg);
  });

  it("accepts a config message with the default display config", () => {
    const parsed = parseServerMessage({
      type: "config",
      config: DEFAULT_DISPLAY_CONFIG,
    });
    expect(parsed.type).toBe("config");
  });

  it("accepts a config with an operator caption region", () => {
    const parsed = parseServerMessage({
      type: "config",
      config: { ...DEFAULT_DISPLAY_CONFIG, region: { x: 5, y: 70, width: 90, height: 25 } },
    });
    expect(parsed.type === "config" && parsed.config.region?.height).toBe(25);
  });

  it("accepts a config with a QR overlay", () => {
    const parsed = parseServerMessage({
      type: "config",
      config: {
        ...DEFAULT_DISPLAY_CONFIG,
        qr: { url: "https://v2.caption.guru/r/abc/subscribe", x: 70, y: 5, size: 25 },
      },
    });
    expect(parsed.type === "config" && parsed.config.qr?.url).toContain("/r/abc/");
  });

  it("rejects an out-of-range caption region", () => {
    expect(() =>
      parseServerMessage({
        type: "config",
        config: { ...DEFAULT_DISPLAY_CONFIG, region: { x: 0, y: 0, width: 120, height: 10 } },
      }),
    ).toThrow();
  });

  it("accepts a history replay message", () => {
    const parsed = parseServerMessage({
      type: "history",
      segments: [{ id: "a", text: "x", start: 0, end: 1 }],
    });
    expect(parsed.type).toBe("history");
  });

  it("rejects an unknown message type", () => {
    expect(() => parseServerMessage({ type: "bogus" })).toThrow();
  });

  it("safeParse returns null on garbage", () => {
    expect(safeParseServerMessage("{not json")).toBeNull();
    expect(safeParseServerMessage({ type: "nope" })).toBeNull();
  });
});

describe("joinSegments (operator line-merge)", () => {
  const seg = (
    id: string,
    text: string,
    extra: Partial<CaptionSegment> = {},
  ): CaptionSegment => ({ id, text, start: 0, end: 1, ...extra });

  it("keeps unmerged segments as separate lines", () => {
    const lines = joinSegments([seg("a", "hello"), seg("b", "world")]);
    expect(lines.map((l) => l.text)).toEqual(["hello", "world"]);
  });

  it("merges with a comma", () => {
    const lines = joinSegments([
      seg("a", "first part", { joinNext: "comma" }),
      seg("b", "second part"),
    ]);
    expect(lines.length).toBe(1);
    expect(lines[0]?.text).toBe("first part, second part");
    expect(lines[0]?.members.length).toBe(2);
  });

  it("merges with a period", () => {
    const lines = joinSegments([
      seg("a", "a sentence", { joinNext: "period" }),
      seg("b", "another one"),
    ]);
    expect(lines[0]?.text).toBe("a sentence. another one");
  });

  it("does not double-punctuate when the line already ends hard", () => {
    // Engine already added a period — merge adds only a space regardless of state.
    const lines = joinSegments([
      seg("a", "Already done.", { joinNext: "period" }),
      seg("b", "Next bit"),
    ]);
    expect(lines[0]?.text).toBe("Already done. Next bit");
  });

  it("plain merge joins with a space", () => {
    const lines = joinSegments([
      seg("a", "ends with comma,", { joinNext: "plain" }),
      seg("b", "more"),
    ]);
    expect(lines[0]?.text).toBe("ends with comma, more");
  });

  it("chains three segments into one line, end time from the last", () => {
    const lines = joinSegments([
      seg("a", "one", { joinNext: "comma", end: 1 }),
      seg("b", "two", { joinNext: "period", start: 1, end: 2 }),
      seg("c", "three", { start: 2, end: 3 }),
    ]);
    expect(lines.length).toBe(1);
    expect(lines[0]?.text).toBe("one, two. three");
    expect(lines[0]?.end).toBe(3);
  });

  it("marks a line locked if any member is locked", () => {
    const lines = joinSegments([
      seg("a", "x", { joinNext: "comma" }),
      seg("b", "y", { locked: true }),
    ]);
    expect(lines[0]?.locked).toBe(true);
  });

  it("skips blank segments", () => {
    const lines = joinSegments([seg("a", "real"), seg("b", "   "), seg("c", "also")]);
    expect(lines.map((l) => l.text)).toEqual(["real", "also"]);
  });
});

describe("canReplaceSegment", () => {
  const s = (text: string, locked?: boolean): CaptionSegment => ({
    id: "a",
    text,
    start: 0,
    end: 1,
    locked,
  });
  it("blocks a non-locked update over a locked segment", () => {
    expect(canReplaceSegment(s("x", true), s("y"))).toBe(false);
  });
  it("allows a locked update to win", () => {
    expect(canReplaceSegment(s("x", true), s("y", true))).toBe(true);
  });
  it("allows any update over a non-locked segment", () => {
    expect(canReplaceSegment(s("x"), s("y"))).toBe(true);
    expect(canReplaceSegment(undefined, s("y"))).toBe(true);
  });
});

describe("client messages", () => {
  it("parses a partial setConfig", () => {
    const parsed = parseClientMessage({
      type: "setConfig",
      config: { fontSize: 8, uppercase: true },
    });
    expect(parsed.type).toBe("setConfig");
  });

  it("parses a control command", () => {
    const parsed = parseClientMessage({ type: "command", command: "clear" });
    expect(parsed).toEqual({ type: "command", command: "clear" });
  });

  it("parses a history request", () => {
    expect(parseClientMessage({ type: "requestHistory", since: 30 }).type).toBe(
      "requestHistory",
    );
  });
});
