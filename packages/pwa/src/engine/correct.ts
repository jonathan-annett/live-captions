/**
 * Operator caption edits — pure, testable segment transforms.
 *
 * A correction replaces or suppresses one token of a finalized segment and marks
 * the result `locked` (the operator's canonical text), so neither a live engine
 * re-emit nor the background refinement pass overwrites it (see
 * `canReplaceSegment` in @captions/protocol).
 */
import { findRepeatRuns, type CaptionSegment, type Word } from "@captions/protocol";

export interface EditToken {
  text: string;
  /** decoder/heuristic confidence 0..1, when the segment carries words */
  confidence?: number;
}

/** A rendered token group: a normal word, or a collapsed repetition run (a
 *  single word OR a repeated phrase — a Whisper loop flagged for the operator).
 *  `count` = number of repeats; `period` = words per repeated phrase (1 = word);
 *  the run spans `period * count` tokens from `start`. */
export type TokenGroup =
  | { kind: "word"; index: number; text: string; confidence?: number }
  | { kind: "run"; start: number; period: number; count: number; text: string };

/**
 * Group a segment's tokens, collapsing any repetition loop — a single word
 * repeated 3+ times OR a phrase repeated 3+ times — into a single flagged `run`
 * group. The operator-side antidote to Whisper loops ("warning warning…",
 * "I'm sorry. I'm sorry.…"). keepRepeats opts the segment out.
 */
export function groupTokens(seg: CaptionSegment): TokenGroup[] {
  const toks = segmentTokens(seg);
  if (seg.keepRepeats) {
    return toks.map((t, index) => ({
      kind: "word",
      index,
      text: t.text,
      confidence: t.confidence,
    }));
  }
  const runs = findRepeatRuns(toks.map((t) => t.text));
  const groups: TokenGroup[] = [];
  let i = 0;
  let r = 0;
  while (i < toks.length) {
    if (r < runs.length && runs[r]!.start === i) {
      const run = runs[r++]!;
      const phrase = toks
        .slice(i, i + run.period)
        .map((t) => t.text)
        .join(" ");
      groups.push({ kind: "run", start: i, period: run.period, count: run.reps, text: phrase });
      i += run.period * run.reps;
    } else {
      groups.push({
        kind: "word",
        index: i,
        text: toks[i]!.text,
        confidence: toks[i]!.confidence,
      });
      i++;
    }
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

/** Keep all repeats in a segment (opt out of auto-collapse), locking it. Used
 *  when the operator confirms a flagged repetition is real, not a hallucination. */
export function applyKeepRepeats(seg: CaptionSegment): CaptionSegment {
  return { ...seg, keepRepeats: true, locked: true };
}

/** Set (or clear) a segment's join-to-next state, locking it as operator-set. */
export function applyJoin(
  seg: CaptionSegment,
  join: CaptionSegment["joinNext"],
): CaptionSegment {
  const { joinNext: _drop, ...rest } = seg;
  return join ? { ...rest, joinNext: join, locked: true } : { ...rest, locked: true };
}
