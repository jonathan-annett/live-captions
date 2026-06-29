/**
 * Heuristics that reject Whisper's degenerate output on non-speech audio:
 *  - symbol-spam (">>>>", "[[[", "....") — repetition hallucination
 *  - silent / near-silent clips — which make Whisper emit phantom phrases
 *    ("I'm sorry", "Thank you", "Thanks for watching") out of nothing
 *
 * Pure (no DOM / model) so they're unit-testable.
 */

/** True if `text` is non-speech junk (no letters/digits, or overwhelmingly symbols). */
export function isDegenerate(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const compact = t.replace(/\s+/g, "");
  const alnum = (compact.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (alnum === 0) return true; // pure punctuation/symbols: ">>>>", "[[[", "...."
  // A token or two of text drowning in symbols.
  return compact.length >= 6 && alnum / compact.length < 0.4;
}

/**
 * Peak RMS over ~`windowMs` windows. Using the peak (not the mean) is robust to
 * the leading/trailing silence in a VAD-endpointed clip — real speech spikes in
 * at least one window, while silence/quiet-noise stays low throughout.
 */
export function peakRms(
  samples: Float32Array,
  sampleRate: number,
  windowMs = 100,
): number {
  const w = Math.max(1, Math.floor((sampleRate * windowMs) / 1000));
  let peak = 0;
  for (let start = 0; start < samples.length; start += w) {
    const end = Math.min(start + w, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
    const rms = Math.sqrt(sum / Math.max(end - start, 1));
    if (rms > peak) peak = rms;
  }
  return peak;
}

/**
 * Speech gate before sending a clip to the recognizer: it must be long enough
 * and have a loud-enough peak to plausibly contain speech. Silent / near-silent
 * clips are exactly what make Whisper hallucinate, so we never decode them.
 * Thresholds are conservative (kept lenient so real, quiet speech still passes)
 * and live here as named constants for easy tuning (future config panel).
 */
export function isLikelySpeech(
  samples: Float32Array,
  sampleRate: number,
  minPeakRms = 0.012,
  minMs = 250,
): boolean {
  if ((samples.length / sampleRate) * 1000 < minMs) return false;
  return peakRms(samples, sampleRate) >= minPeakRms;
}
