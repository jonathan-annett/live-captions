"""Pluggable ASR engine interface.

A live utterance (16 kHz mono float32) goes in; recognized text comes out. This
keeps the streaming/transport code independent of the backend, so faster-whisper
(CPU/CUDA), an Apple-Silicon MLX backend (M7), or a mock can be swapped freely.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Optional

from ..protocol import EngineStatus


class ASREngine(ABC):
    @abstractmethod
    def load(self) -> EngineStatus:
        """Load the model. Returns a 'listening' status (or 'error')."""

    @abstractmethod
    def transcribe(self, samples: Any, hotwords: Optional[str] = None) -> str:
        """Transcribe a 16 kHz mono float32 numpy array to text.

        ``hotwords`` optionally biases decoding toward event-specific
        names/jargon (the custom dictionary).
        """

    def unload(self) -> None:  # optional override
        pass
