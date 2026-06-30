import { describe, expect, it } from "vitest";
import { suggestCorrections } from "./suggest.js";

const DICT = ["Kubernetes", "Anthropic", "PostgreSQL", "Grafana"];

describe("suggestCorrections", () => {
  it("ranks a sound-alike dictionary term first", () => {
    expect(suggestCorrections("cooper netties", DICT)[0]).toBe("Kubernetes");
  });

  it("matches a single mis-token to its term", () => {
    expect(suggestCorrections("antropic", DICT)[0]).toBe("Anthropic");
  });

  it("drops an already-correct word (exact match)", () => {
    expect(suggestCorrections("Kubernetes", DICT)).not.toContain("Kubernetes");
  });

  it("returns nothing for an empty/garbage word", () => {
    expect(suggestCorrections("", DICT)).toEqual([]);
    expect(suggestCorrections("!!!", DICT)).toEqual([]);
  });

  it("excludes phonetically distant terms", () => {
    // "hello" sounds like none of the dictionary terms.
    expect(suggestCorrections("hello", DICT)).toEqual([]);
  });

  it("honors the limit", () => {
    const many = ["Cat", "Kat", "Catt", "Khat", "Kit", "Cut"];
    expect(suggestCorrections("cat", many, 2).length).toBeLessThanOrEqual(2);
  });

  it("dedupes case-variant terms", () => {
    const out = suggestCorrections("antropic", ["Anthropic", "anthropic"]);
    expect(out).toEqual(["Anthropic"]);
  });
});
