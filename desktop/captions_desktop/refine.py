"""Two-tier refinement: a background pass that re-decodes settled utterances at
higher quality and re-emits cleaner text in place.

Tier 1 is the live, low-latency stream (short VAD-endpointed utterances, greedy
decode). Tier 2 — this — re-transcribes each finalized utterance's audio with a
slower, higher-quality decode (beam search + long-form conditioning on the
preceding text) on a **separate engine instance and thread**, then re-emits a
``final`` with the SAME segment id. The hub upserts by id (lock-aware), so the
refined text replaces the live text everywhere (display + room) but never
overwrites an operator-locked correction.

Compute-gated and off by default (``serve --refine``).
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any, Optional

from .engines.base import ASREngine
from .hub import CaptionHub
from .protocol import CaptionSegment, Word
from .sanitize import collapse_repeats, is_degenerate

# Tail of refined text kept as the decode prompt (cross-utterance context).
_PROMPT_TAIL = 400


def refine_decode(
    engine: ASREngine,
    samples: Any,
    start: float,
    end: float,
    *,
    hotwords: Optional[str] = None,
    prompt: Optional[str] = None,
) -> tuple[Optional[str], Optional[list[Word]]]:
    """Re-decode one utterance at higher quality and return ``(text, words)``.

    The shared core of a refinement decode (beam + long-form conditioning, drop
    degenerate output, collapse repeats, offset word times by ``start``). Returns
    ``(None, None)`` when the decode is empty/degenerate. Reused by
    :class:`RefinementPass` (which emits a same-id ``final`` to the hub) and the
    clip-decode ASR backend (which emits an ``asrRefined`` keyed by ``reqId``).
    Pass ``start=0.0`` for clip-relative word times.
    """
    result = engine.transcribe(samples, hotwords=hotwords, quality=True, prompt=prompt or None)
    raw = result.text.strip()
    if not raw or is_degenerate(raw):
        return None, None
    text = collapse_repeats(raw)
    words = (
        [
            Word(text=w.text, start=start + w.start, end=start + w.end, confidence=w.confidence)
            for w in result.words
        ]
        if result.words
        else None
    )
    return text, words


class RefinementPass:
    def __init__(
        self,
        hub: CaptionHub,
        engine: ASREngine,
        *,
        poll: float = 0.3,
        max_pending: int = 64,
    ) -> None:
        self.hub = hub
        self.engine = engine
        self._poll = poll
        # Drop the oldest if refinement falls behind live (it's best-effort).
        self._queue: "deque[tuple[str, Any, float, float]]" = deque(maxlen=max_pending)
        self._lock = threading.Lock()
        self._running = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._hotwords: Optional[str] = None
        self._recent = ""  # tail of refined text, used as the decode prompt

    def set_dictionary(self, terms: list[str]) -> None:
        self._hotwords = ", ".join(terms) if terms else None

    def set_engine(self, engine: ASREngine) -> None:
        """Swap the refinement engine (for a model change). Call while stopped;
        the running thread loads/warms it on next start. Dictionary + prompt tail
        are preserved."""
        self.engine = engine

    def submit(self, seg_id: str, samples: Any, start: float, end: float) -> None:
        """Queue a finalized utterance's audio for re-decode (called from the live thread)."""
        with self._lock:
            self._queue.append((seg_id, samples, start, end))

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._running.set()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running.clear()
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None

    def _run(self) -> None:
        # Load this pass's own model (separate instance — the live engine's model
        # isn't safe to call concurrently from two threads). The refine model can
        # be large and download in the background AFTER live captions have started,
        # so surface its progress (live flows the whole time; refinement joins when
        # this finishes).
        model = getattr(self.engine, "model_name", None) or "refine model"
        print(f"  refine:   loading {model} (live captions continue meanwhile)…", flush=True)
        status = self.engine.load()
        if status.state == "error":
            print(f"  refine:   FAILED to load {model}: {status.message}", flush=True)
            return
        # Warm the model before processing real audio (this is where a big model
        # actually downloads/compiles). A failure here (e.g. an interrupted
        # download) used to be swallowed silently — surface it and fall back to
        # live-only rather than pretending refinement is running.
        try:
            import numpy as np

            self.engine.transcribe(np.zeros(16000, dtype="float32"), quality=True)
        except Exception as exc:  # noqa: BLE001
            print(
                f"  refine:   {model} failed to load ({exc}); running live-only "
                "(check the model downloaded; set HF_TOKEN for the big models)",
                flush=True,
            )
            return
        print(f"  refine:   live — {model} now refining captions", flush=True)
        while self._running.is_set():
            item = None
            with self._lock:
                if self._queue:
                    item = self._queue.popleft()
            if item is None:
                time.sleep(self._poll)
                continue
            try:
                self.refine_one(*item)
            except Exception:  # noqa: BLE001 - never let refinement crash capture
                pass

    def refine_one(self, seg_id: str, samples: Any, start: float, end: float) -> None:
        """Re-decode one utterance and emit the refined final (also the unit test hook)."""
        text, words = refine_decode(
            self.engine, samples, start, end, hotwords=self._hotwords, prompt=self._recent or None
        )
        if text is None:
            return
        self.hub.emit_final(
            CaptionSegment(id=seg_id, text=text, start=start, end=end, words=words)
        )
        self._recent = (self._recent + " " + text)[-_PROMPT_TAIL:].strip()
