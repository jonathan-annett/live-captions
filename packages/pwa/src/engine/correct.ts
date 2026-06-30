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

/** A rendered token group: a normal word, or a collapsed run of one repeated
 *  word (a Whisper repetition hallucination flagged for the operator). */
export type TokenGroup =
  | { kind: "word"; index: number; text: string; confidence?: number }
  | { kind: "run"; start: number; count: number; text: string };

/** Comparable core of a token (lowercase, punctuation stripped). */
function normWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9']/g, "");
}

/**
 * Group a segment's tokens, collapsing any run of the SAME word repeated `min`+
 * times in a row (default 3 — "more than twice") into a single flagged `run`
 * group. This is the operator-side antidote to Whisper repetition loops
 * (e.g. "warning warning warning…" on music/non-speech).
 */
export function groupTokens(seg: CaptionSegment, min = 3): TokenGroup[] {
  const toks = segmentTokens(seg);
  const groups: TokenGroup[] = [];
  let i = 0;
  while (i < toks.length) {
    const key = normWord(toks[i]!.text);
    let j = i + 1;
    while (j < toks.length && key && normWord(toks[j]!.text) === key) j++;
    const count = j - i;
    if (count >= min && key) {
      groups.push({ kind: "run", start: i, count, text: toks[i]!.text });
    } else {
      for (let k = i; k < j; k++) {
        groups.push({
          kind: "word",
          index: k,
          text: toks[k]!.text,
          confidence: toks[k]!.confidence,
        });
      }
    }
    i = j;
  }
  return groups;
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

/**
 * Collapse a run of repeated tokens: keep the first `keep` (1 = reduce to one,
 * 0 = delete the whole run), remove the rest. Locks the segment. A delete-all
 * that empties the segment yields blank text (callers treat a blank locked
 * segment as a removal).
 */
export function applyRangeEdit(
  seg: CaptionSegment,
  start: number,
  count: number,
  keep: 0 | 1,
): CaptionSegment {
  const removeAt = start + keep;
  const removeN = count - keep;
  if (removeN <= 0 || start < 0) return seg;
  if (seg.words && seg.words.length) {
    if (start >= seg.words.length) return seg;
    const words = seg.words.slice();
    words.splice(removeAt, removeN);
    return { ...seg, text: textFromWords(words), words, locked: true };
  }
  const toks = seg.text.trim().split(/\s+/).filter(Boolean);
  if (start >= toks.length) return seg;
  toks.splice(removeAt, removeN);
  return { ...seg, text: toks.join(" "), locked: true };
}

/**
 * Next state for the line-merge boundary control. Binary (break ⇄ merge) when
 * this segment already ends in hard punctuation — the merge would add nothing —
 * else 3-state: break → comma → period → break.
 */
export function nextJoin(seg: CaptionSegment): CaptionSegment["joinNext"] {
  const endsHard = /[.,]\s*$/.test(seg.text);
  const cur = seg.joinNext;
  if (endsHard) return cur ? undefined : "plain";
  if (!cur) return "comma";
  if (cur === "comma") return "period";
  return undefined;
}

/** Set (or clear) a segment's join-to-next state, locking it as operator-set. */
export function applyJoin(
  seg: CaptionSegment,
  join: CaptionSegment["joinNext"],
): CaptionSegment {
  const { joinNext: _drop, ...rest } = seg;
  return join ? { ...rest, joinNext: join, locked: true } : { ...rest, locked: true };
}
