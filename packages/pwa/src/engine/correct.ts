/**
 * Operator caption edits — pure, testable segment transforms.
 *
 * A correction replaces or suppresses one token of a finalized segment and marks
 * the result `locked` (the operator's canonical text), so neither a live engine
 * re-emit nor the background refinement pass overwrites it (see
 * `canReplaceSegment` in @captions/protocol).
 */
import type { CaptionSegment, Word } from "@captions/protocol";

export interface EditToken {
  text: string;
  /** decoder/heuristic confidence 0..1, when the segment carries words */
  confidence?: number;
}

/** A segment's clickable tokens: word-level when available, else split text. */
export function segmentTokens(seg: CaptionSegment): EditToken[] {
  if (seg.words && seg.words.length) {
    return seg.words.map((w) => ({ text: w.text.trim(), confidence: w.confidence }));
  }
  return seg.text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text }));
}

/** Rebuild a segment's display text from its (trimmed) word list. */
function textFromWords(words: Word[]): string {
  return words
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Apply an edit at `index`: replace the token with `replacement`, or suppress it
 * when `replacement` is empty/whitespace. Returns a new locked segment (the
 * input is never mutated). An out-of-range index returns the segment unchanged.
 */
export function applyEdit(
  seg: CaptionSegment,
  index: number,
  replacement: string,
): CaptionSegment {
  const repl = replacement.trim();
  const suppress = repl === "";

  if (seg.words && seg.words.length) {
    if (index < 0 || index >= seg.words.length) return seg;
    const words = seg.words.slice();
    if (suppress) {
      words.splice(index, 1);
    } else {
      // Operator-confirmed text: full confidence, keep the original timing.
      words[index] = { ...words[index]!, text: repl, confidence: 1 };
    }
    return { ...seg, text: textFromWords(words), words, locked: true };
  }

  const toks = seg.text.trim().split(/\s+/).filter(Boolean);
  if (index < 0 || index >= toks.length) return seg;
  if (suppress) toks.splice(index, 1);
  else toks[index] = repl;
  return { ...seg, text: toks.join(" "), locked: true };
}
