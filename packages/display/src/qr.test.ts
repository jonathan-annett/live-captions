import { describe, expect, it } from "vitest";
import { qrMatrix, qrSvg } from "./qr.js";

const URL = "https://v2.caption.guru/r/abc/subscribe";

describe("qrMatrix", () => {
  it("produces a non-empty square matrix", () => {
    const m = qrMatrix(URL);
    expect(m.length).toBeGreaterThan(0);
    expect(m.every((row) => row.length === m.length)).toBe(true);
  });

  it("encodes more modules for longer data", () => {
    const small = qrMatrix("hi").length;
    const big = qrMatrix(URL.repeat(4)).length;
    expect(big).toBeGreaterThanOrEqual(small);
  });
});

describe("qrSvg", () => {
  it("renders a scalable SVG with dark modules", () => {
    const svg = qrSvg(URL);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox");
    expect(svg).toContain("<rect");
  });

  it("honors custom colors", () => {
    expect(qrSvg("x", { dark: "#123456" })).toContain("#123456");
  });
});
