"""Post-decode hallucination hygiene for the desktop engine.

Mirror of the browser's defenses so the desktop stream is as clean as the PWA:
 - ``is_degenerate`` — drop symbol-spam / no-letter junk (``packages/pwa/src/
   engine/sanitize.ts``).
 - ``collapse_repeats`` — collapse repetition loops (a single word OR a repeated
   phrase) to one occurrence (``packages/protocol/src/index.ts`` findRepeatRuns/
   collapseRepeats). Keep these in lockstep with their TS counterparts.
"""

from __future__ import annotations

import re

_ALNUM = re.compile(r"[^\W_]", re.UNICODE)  # unicode letters/digits (not underscore)
_NORM = re.compile(r"[^a-z0-9']")


def is_degenerate(text: str) -> bool:
    """True if ``text`` is non-speech junk (no letters/digits, or mostly symbols)."""
    t = text.strip()
    if not t:
        return True
    compact = re.sub(r"\s+", "", t)
    alnum = len(_ALNUM.findall(compact))
    if alnum == 0:
        return True  # pure punctuation/symbols: ">>>>", "[[[", "...."
    return len(compact) >= 6 and alnum / len(compact) < 0.4


def _norm_word(s: str) -> str:
    return _NORM.sub("", s.lower())


def collapse_repeats(
    text: str, min_word: int = 3, min_phrase: int = 3, max_period: int = 6
) -> str:
    """Collapse repetition loops to a single occurrence — single words
    ("warning warning warning…") and phrases ("I'm sorry. I'm sorry.…").
    Smallest period wins; a word run needs ``min_word``+ copies, a phrase
    ``min_phrase``+ (so a natural double is spared)."""
    toks = text.split()
    norm = [_norm_word(t) for t in toks]
    n = len(toks)
    out: list[str] = []
    i = 0
    while i < n:
        best = None
        for p in range(1, max_period + 1):
            if i + 2 * p > n:
                break
            if not any(norm[i + k] for k in range(p)):
                continue
            reps = 1
            while True:
                base = i + reps * p
                if base + p > n:
                    break
                if all(norm[base + k] == norm[i + k] for k in range(p)):
                    reps += 1
                else:
                    break
            if reps >= (min_word if p == 1 else min_phrase):
                best = (p, reps)
                break  # smallest period wins
        if best:
            p, reps = best
            out.extend(toks[i : i + p])  # keep one copy
            i += p * reps
        else:
            out.append(toks[i])
            i += 1
    return " ".join(out)
