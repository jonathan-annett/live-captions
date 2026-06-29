import { describe, expect, it } from "vitest";
import { analyzeClip, isDegenerate, isLikelySpeech, peakRms } from "./sanitize.js";

describe("isDegenerate", () => {
  it("rejects pure symbol spam (the reported hallucinations)", () => {
    expect(isDegenerate(">>>>>>>>>>")).toBe(true);
    expect(isDegenerate("[[[")).toBe(true);
    expect(isDegenerate("....")).toBe(true);
    expect(isDegenerate("   ")).toBe(true);
    expect(isDegenerate(">>>>>>>>>>a")).toBe(true); // a token drowning in symbols
  });

  it("keeps real captions", () => {
    expect(isDegenerate("Welcome to the conference.")).toBe(false);
    expect(isDegenerate("OK!")).toBe(false);
    // A single phantom phrase isn't 'degenerate' text — it's caught by the
    // no-speech gate (silence never reaches the decoder) instead.
    expect(isDegenerate("I'm sorry")).toBe(false);
  });
});

describe("peakRms / isLikelySpeech", () => {
  const SR = 16000;
  const silence = (ms: number) => new Float32Array(Math.round((SR * ms) / 1000));
  const tone = (ms: number, amp = 0.2) => {
    const n = Math.round((SR * ms) / 1000);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
    return a;
  };

  it("peakRms ~0 for silence, sizable for a tone", () => {
    expect(peakRms(silence(500), SR)).toBeLessThan(0.001);
    expect(peakRms(tone(500), SR)).toBeGreaterThan(0.1);
  });

  it("gates out silence and too-short clips", () => {
    expect(isLikelySpeech(silence(500), SR)).toBe(false);
    expect(isLikelySpeech(tone(100), SR)).toBe(false); // < minMs
  });

  it("passes a loud-enough clip of sufficient length", () => {
    expect(isLikelySpeech(tone(500), SR)).toBe(true);
  });

  it("analyzeClip reports the why (long/loud) and honors overrides", () => {
    const quiet = analyzeClip(tone(500, 0.005), SR); // below default 0.012
    expect(quiet.longEnough).toBe(true);
    expect(quiet.loudEnough).toBe(false);
    expect(quiet.isSpeech).toBe(false);
    // A lower threshold (as ?minrms would set) lets the same clip through.
    expect(analyzeClip(tone(500, 0.005), SR, 0.002).isSpeech).toBe(true);
  });
});
