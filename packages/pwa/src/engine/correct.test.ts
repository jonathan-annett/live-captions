import type { CaptionSegment } from "@captions/protocol";
import { describe, expect, it } from "vitest";
import { applyEdit, applyJoin, nextJoin, segmentTokens } from "./correct.js";

const withWords = (): CaptionSegment => ({
  id: "a",
  text: "cooper netties is great",
  start: 0,
  end: 4,
  words: [
    { text: " cooper", start: 0, end: 0.5, confidence: 0.3 },
    { text: " netties", start: 0.5, end: 1, confidence: 0.4 },
    { text: " is", start: 1, end: 1.2, confidence: 0.95 },
    { text: " great", start: 1.2, end: 1.8, confidence: 0.9 },
  ],
});

const plain = (): CaptionSegment => ({
  id: "b",
  text: "cooper netties is great",
  start: 0,
  end: 4,
});

describe("segmentTokens", () => {
  it("uses words (trimmed) with confidence when present", () => {
    const toks = segmentTokens(withWords());
    expect(toks.map((t) => t.text)).toEqual(["cooper", "netties", "is", "great"]);
    expect(toks[0]?.confidence).toBe(0.3);
  });

  it("falls back to splitting text when no words", () => {
    const toks = segmentTokens(plain());
    expect(toks.map((t) => t.text)).toEqual(["cooper", "netties", "is", "great"]);
    expect(toks[0]?.confidence).toBeUndefined();
  });
});

describe("applyEdit (word-level)", () => {
  it("replaces a word, rebuilds text, locks, and confirms confidence", () => {
    // Replace the two mis-tokens; here replace index 0 then 1.
    let seg = applyEdit(withWords(), 0, "Kubernetes");
    seg = applyEdit(seg, 1, "");
    expect(seg.text).toBe("Kubernetes is great");
    expect(seg.locked).toBe(true);
    expect(seg.words?.[0]?.confidence).toBe(1);
  });

  it("suppresses a word", () => {
    const seg = applyEdit(withWords(), 1, "");
    expect(seg.text).toBe("cooper is great");
    expect(seg.words?.length).toBe(3);
  });

  it("does not mutate the input segment", () => {
    const seg = withWords();
    applyEdit(seg, 0, "Kubernetes");
    expect(seg.text).toBe("cooper netties is great");
    expect(seg.locked).toBeUndefined();
  });

  it("ignores an out-of-range index", () => {
    const seg = withWords();
    expect(applyEdit(seg, 9, "x")).toBe(seg);
  });
});

describe("nextJoin (boundary toggle)", () => {
  const s = (text: string, joinNext?: CaptionSegment["joinNext"]): CaptionSegment => ({
    id: "a",
    text,
    start: 0,
    end: 1,
    joinNext,
  });

  it("3-state cycle when the line has no hard ending: break→comma→period→break", () => {
    expect(nextJoin(s("no punctuation"))).toBe("comma");
    expect(nextJoin(s("no punctuation", "comma"))).toBe("period");
    expect(nextJoin(s("no punctuation", "period"))).toBeUndefined();
  });

  it("binary cycle when the line already ends hard: break⇄plain", () => {
    expect(nextJoin(s("Ends here."))).toBe("plain");
    expect(nextJoin(s("Ends here.", "plain"))).toBeUndefined();
    expect(nextJoin(s("comma end,"))).toBe("plain");
  });
});

describe("applyJoin", () => {
  const s = (joinNext?: CaptionSegment["joinNext"]): CaptionSegment => ({
    id: "a",
    text: "x",
    start: 0,
    end: 1,
    joinNext,
  });

  it("sets the join state and locks", () => {
    const out = applyJoin(s(), "comma");
    expect(out.joinNext).toBe("comma");
    expect(out.locked).toBe(true);
  });

  it("clears the join state when undefined (back to break)", () => {
    const out = applyJoin(s("period"), undefined);
    expect(out.joinNext).toBeUndefined();
    expect("joinNext" in out).toBe(false);
    expect(out.locked).toBe(true);
  });
});

describe("applyEdit (plain text)", () => {
  it("replaces a token and locks without inventing words", () => {
    const seg = applyEdit(plain(), 0, "Kubernetes");
    expect(seg.text).toBe("Kubernetes netties is great");
    expect(seg.locked).toBe(true);
    expect(seg.words).toBeUndefined();
  });

  it("suppresses a token", () => {
    expect(applyEdit(plain(), 3, "").text).toBe("cooper netties is");
  });
});
