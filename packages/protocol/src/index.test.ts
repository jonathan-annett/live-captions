import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_CONFIG,
  parseClientMessage,
  parseServerMessage,
  safeParseServerMessage,
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
