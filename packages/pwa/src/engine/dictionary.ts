/**
 * Post-decode custom-dictionary correction for the PWA.
 *
 * transformers.js has limited prompt/hotword support, so instead we nudge the
 * recognized text toward event-specific names/jargon: each output token that is
 * a near-miss for a dictionary term (small edit distance) is replaced with the
 * canonical term. Conservative by design — exact matches and short/distant words
 * are left alone — to avoid corrupting otherwise-correct text.
 */
import { levenshtein } from "@captions/protocol";

export function correctText(text: string, terms: string[]): string {
  const single = terms
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !t.includes(" "));
  if (single.length === 0) return text;

  return text.replace(/[A-Za-z][A-Za-z'-]*/g, (word) => {
    const lower = word.toLowerCase();
    let best: { term: string; dist: number } | null = null;
    for (const term of single) {
      const tl = term.toLowerCase();
      if (tl === lower) return word; // already correct
      if (Math.abs(tl.length - lower.length) > 2) continue;
      const dist = levenshtein(lower, tl);
      const limit = lower.length <= 6 ? 1 : 2;
      if (dist <= limit && (best === null || dist < best.dist)) {
        best = { term, dist };
      }
    }
    return best ? matchCase(word, best.term) : word;
  });
}

/** Preserve the casing style of the original word on the replacement. */
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0]?.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
