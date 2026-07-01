"""Post-decode hallucination hygiene for the desktop engine.

Mirror of the browser's defenses so the desktop stream is as clean as the PWA:
 - ``is_degenerate`` — drop symbol-spam / no-letter junk (``packages/pwa/src/
   engine/sanitize.ts``).
 - ``is_likely_speech`` — pre-decode peak-RMS + duration gate; silent/near-silent
   clips are exactly what make Whisper hallucinate phantom phrases, so we never
   decode them (mirror of ``peakRms``/``isLikelySpeech`` in the same TS file).
 - ``collapse_repeats`` — collapse repetition loops (a single word OR a repeated
   phrase) to one occurrence (``packages/protocol/src/index.ts`` findRepeatRuns/
   collapseRepeats). Keep these in lockstep with their TS counterparts.
"""

from __future__ import annotations

import re
from typing import Sequence

import numpy as np

_ALNUM = re.compile(r"[^\W_]", re.UNICODE)  # unicode letters/digits (not underscore)
_NORM = re.compile(r"[^a-z0-9']")

# Default speech-gate thresholds (mirror MIN_PEAK_RMS / MIN_SPEECH_MS in the TS).
MIN_PEAK_RMS = 0.012
MIN_SPEECH_MS = 250.0


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


def peak_rms(samples: Sequence[float], sample_rate: int, window_ms: float = 100) -> float:
    """Peak RMS over ~``window_ms`` windows. Using the peak (not the mean) is robust
    to the leading/trailing silence in a VAD-endpointed clip — real speech spikes in
    at least one window, while silence/quiet-noise stays low throughout."""
    x = np.asarray(samples, dtype=np.float64)
    n = x.shape[0]
    if n == 0:
        return 0.0
    w = max(1, int(sample_rate * window_ms / 1000))
    peak = 0.0
    for start in range(0, n, w):
        chunk = x[start : start + w]
        rms = float(np.sqrt(np.mean(chunk * chunk)))
        if rms > peak:
            peak = rms
    return peak


def is_likely_speech(
    samples: Sequence[float],
    sample_rate: int,
    min_peak_rms: float = MIN_PEAK_RMS,
    min_ms: float = MIN_SPEECH_MS,
) -> bool:
    """Speech gate before sending a clip to the recognizer: it must be long enough
    and have a loud-enough peak to plausibly contain speech. Silent / near-silent
    clips are what make Whisper hallucinate, so we never decode them."""
    ms = len(samples) / sample_rate * 1000
    if ms < min_ms:
        return False
    return peak_rms(samples, sample_rate) >= min_peak_rms


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
