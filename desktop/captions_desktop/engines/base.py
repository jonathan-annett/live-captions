"""Pluggable ASR engine interface.

A live utterance (16 kHz mono float32) goes in; recognized text comes out. This
keeps the streaming/transport code independent of the backend, so faster-whisper
(CPU/CUDA), an Apple-Silicon MLX backend (M7), or a mock can be swapped freely.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional

from ..protocol import EngineStatus, Word


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
        self, samples: Any, hotwords: Optional[str] = None
    ) -> TranscribeResult:
        """Transcribe a 16 kHz mono float32 numpy array.

        ``hotwords`` optionally biases decoding toward event-specific
        names/jargon (the custom dictionary).
        """

    def unload(self) -> None:  # optional override
        pass
