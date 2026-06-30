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
        # isn't safe to call concurrently from two threads).
        status = self.engine.load()
        if status.state == "error":
            return
        # Warm the model before processing real audio (avoid a cold first decode).
        try:
            import numpy as np

            self.engine.transcribe(np.zeros(16000, dtype="float32"), quality=True)
        except Exception:  # noqa: BLE001 - warmup is best-effort
            pass
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
        result = self.engine.transcribe(
            samples, hotwords=self._hotwords, quality=True, prompt=self._recent or None
        )
        raw = result.text.strip()
        if not raw or is_degenerate(raw):
            return
        text = collapse_repeats(raw)
        words = (
            [
                Word(
                    text=w.text,
                    start=start + w.start,
                    end=start + w.end,
                    confidence=w.confidence,
                )
                for w in result.words
            ]
            if result.words
            else None
        )
        self.hub.emit_final(
            CaptionSegment(id=seg_id, text=text, start=start, end=end, words=words)
        )
        self._recent = (self._recent + " " + text)[-_PROMPT_TAIL:].strip()
