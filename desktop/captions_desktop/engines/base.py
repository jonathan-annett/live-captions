"""Pluggable ASR engine interface.

A live utterance (16 kHz mono float32) goes in; recognized text comes out. This
keeps the streaming/transport code independent of the backend, so faster-whisper
(CPU/CUDA), an Apple-Silicon MLX backend (M7), or a mock can be swapped freely.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, Optional, TypeVar

from ..protocol import EngineStatus, Word

_T = TypeVar("_T")


def download_with_retry(
    fn: Callable[[], _T], what: str, *, attempts: int = 5, base_delay: float = 2.0
) -> _T:
    """Run a model download/load with exponential-backoff retry.

    huggingface_hub resumes partial blobs automatically between attempts, so a
    flaky or rate-limited big-model download recovers (continuing the partial)
    instead of restarting or leaving an orphaned `.incomplete` for the next run.
    Re-raises the last error if all attempts fail. (We intentionally avoid
    `hf_transfer` — faster but less resilient on unstable links.)
    """
    delay = base_delay
    last: Optional[BaseException] = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - report + retry any download error
            last = exc
            if attempt < attempts:
                print(
                    f"  model:    {what} interrupted ({type(exc).__name__}); "
                    f"resuming — attempt {attempt + 1}/{attempts} in {delay:.0f}s…",
                    flush=True,
                )
                time.sleep(delay)
                delay = min(delay * 2, 30.0)
    assert last is not None
    raise last


@dataclass
class TranscribeResult:
    """An engine decode: the text plus optional word-level timing/confidence.

    ``words`` carry **clip-relative** timestamps (seconds from the start of the
    audio passed in); the streamer offsets them to session time. ``confidence``
    is a real decoder probability when the backend supplies one (faster-whisper
    ``word.probability``, MLX ``word["probability"]``).
    """

    text: str
    words: Optional[list[Word]] = None


class ASREngine(ABC):
    @abstractmethod
    def load(self) -> EngineStatus:
        """Load the model. Returns a 'listening' status (or 'error')."""

    @abstractmethod
    def transcribe(
        self,
        samples: Any,
        hotwords: Optional[str] = None,
        *,
        quality: bool = False,
        prompt: Optional[str] = None,
    ) -> TranscribeResult:
        """Transcribe a 16 kHz mono float32 numpy array.

        ``hotwords`` optionally biases decoding toward event-specific
        names/jargon (the custom dictionary). ``quality`` enables the slower,
        higher-quality decode used by the background refinement pass (beam search
        + long-form conditioning). ``prompt`` is preceding text to condition on
        (cross-utterance context for refinement).
        """

    def unload(self) -> None:  # optional override
        pass
