/**
 * Sound-alike suggestions for operator correction.
 *
 * When the operator clicks a likely-misheard word, we rank the custom-dictionary
 * terms (their event-specific proper nouns / jargon) by how close they *sound* to
 * the clicked word — Double-Metaphone phonetic codes, with an edit-distance
 * tiebreak. The operator can always type a free-form replacement instead; this
 * just surfaces the obvious candidates (e.g. "cooper netties" → "Kubernetes").
 */
import { doubleMetaphone } from "double-metaphone";
import { levenshtein } from "./dictionary.js";

export interface Suggestion {
  term: string;
  /** lower is closer (0 = identical phonetic code) */
  score: number;
}

/** Strip to the comparable core (letters/apostrophes), lowercased. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z']/g, "");
}

/** Phonetic distance: best (smallest) edit distance over the metaphone code pair. */
function phoneticDistance(a: string, b: string): number {
  const [a1, a2] = doubleMetaphone(a);
  const [b1, b2] = doubleMetaphone(b);
  return Math.min(
    levenshtein(a1, b1),
    levenshtein(a1, b2),
    levenshtein(a2, b1),
    levenshtein(a2, b2),
  );
}

/**
 * Rank `terms` by sound-alike closeness to `word`. Returns the closest few,
 * dropping an exact (already-correct) match and obvious non-matches.
 */
export function suggestCorrections(
  word: string,
  terms: string[],
  limit = 5,
): string[] {
  const w = norm(word);
  if (!w) return [];
  const seen = new Set<string>();
  const scored: Suggestion[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    const t = norm(term);
    if (!t || t === w) continue; // empty or already-correct
    if (seen.has(t)) continue;
    seen.add(t);
    // Phonetic distance dominates; a small string-distance tiebreak keeps
    // ordering stable among homophones.
    const score = phoneticDistance(w, t) * 4 + Math.min(4, levenshtein(w, t));
    scored.push({ term, score });
  }
  scored.sort((a, b) => a.score - b.score || a.term.localeCompare(b.term));
  // Keep close candidates: phonetic distance ≤ 2 (score ≤ ~12) is a plausible
  // mishearing; never show more than `limit`.
  return scored
    .filter((s) => s.score <= 12)
    .slice(0, limit)
    .map((s) => s.term);
}
