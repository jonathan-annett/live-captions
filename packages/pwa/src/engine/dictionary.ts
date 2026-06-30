/**
 * Post-decode custom-dictionary correction for the PWA.
 *
 * transformers.js has limited prompt/hotword support, so instead we nudge the
 * recognized text toward event-specific names/jargon: each output token that is
 * a near-miss for a dictionary term (small edit distance) is replaced with the
 * canonical term. Conservative by design — exact matches and short/distant words
 * are left alone — to avoid corrupting otherwise-correct text.
 */

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

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
