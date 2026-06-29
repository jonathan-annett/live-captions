import { describe, expect, it } from "vitest";
import type { CaptionSegment } from "./index.js";
import { exportTranscript, toPlainText, toSRT, toVTT } from "./export.js";

const segments: CaptionSegment[] = [
  { id: "a", text: "Hello world.", start: 0.5, end: 2.0 },
  { id: "b", text: "Second line.", start: 2.4, end: 3.916 },
];

describe("export", () => {
  it("plain text joins one segment per line", () => {
    expect(toPlainText(segments)).toBe("Hello world.\nSecond line.\n");
  });

  it("SRT has indices and comma millisecond separators", () => {
    const srt = toSRT(segments);
    expect(srt).toContain("1\n00:00:00,500 --> 00:00:02,000\nHello world.");
    expect(srt).toContain("2\n00:00:02,400 --> 00:00:03,916\nSecond line.");
  });

  it("VTT has header and dot millisecond separators", () => {
    const vtt = toVTT(segments);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.500 --> 00:00:02.000\nHello world.");
  });

  it("exportTranscript picks mime + filename by format", () => {
    expect(exportTranscript(segments, "srt").filename).toBe("transcript.srt");
    expect(exportTranscript(segments, "vtt").mime).toBe("text/vtt");
    expect(exportTranscript(segments, "txt").mime).toBe("text/plain");
  });
});
