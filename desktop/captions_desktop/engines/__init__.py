"""ASR engines + a factory that picks the best backend for the platform."""

from __future__ import annotations

import importlib.util
import platform

from .base import ASREngine

__all__ = ["ASREngine", "create_engine", "is_apple_silicon", "mlx_available"]


def is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def mlx_available() -> bool:
    return importlib.util.find_spec("mlx_whisper") is not None


def create_engine(
    name: str = "auto",
    model: str = "base.en",
    device: str = "auto",
    language: str = "en",
) -> ASREngine:
    """Build an ASR engine.

    name: "auto" | "faster-whisper" | "mlx". "auto" prefers MLX (Apple GPU) on
    Apple Silicon when installed, otherwise faster-whisper (CPU/CUDA).
    """
    name = (name or "auto").lower()

    if name == "mlx" or (name == "auto" and is_apple_silicon() and mlx_available()):
        from .mlx import MLXWhisperEngine

        return MLXWhisperEngine(model=model, language=language)

    from .faster_whisper import FasterWhisperEngine

    return FasterWhisperEngine(model=model, device=device, language=language)
