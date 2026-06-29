"""MLX-Whisper ASR backend — GPU-accelerated Whisper on Apple Silicon.

This is the macOS GPU path: faster-whisper/CTranslate2 is CPU-only on Mac, while
MLX runs on the Apple GPU. Used automatically on Apple Silicon when installed
(see engines.create_engine). Heavy import is lazy.
"""

from __future__ import annotations

from typing import Any, Optional

from ..protocol import EngineStatus
from .base import ASREngine


def _resolve_repo(model: str) -> str:
    """Map a short model name to an mlx-community repo; pass full repos through."""
    if "/" in model:
        return model
    return f"mlx-community/whisper-{model}-mlx"


class MLXWhisperEngine(ASREngine):
    def __init__(self, model: str = "base.en", language: str = "en") -> None:
        self.model_name = model
        self.repo = _resolve_repo(model)
        self.language = language
        self._mlx: Any = None

    def load(self) -> EngineStatus:
        try:
            import mlx_whisper  # lazy
        except Exception as exc:  # pragma: no cover - env dependent
            return EngineStatus(
                state="error",
                backend="mlx-whisper",
                model=self.repo,
                message=f"mlx-whisper not installed: {exc}",
            )
        self._mlx = mlx_whisper
        return EngineStatus(
            state="listening",
            backend="mlx-whisper",
            model=self.repo,
            device="mlx (apple gpu)",
        )

    def transcribe(self, samples: Any, hotwords: Optional[str] = None) -> str:
        if self._mlx is None:
            return ""
        kwargs: dict[str, Any] = {
            "path_or_hf_repo": self.repo,
            "language": self.language,
        }
        # MLX has no hotwords param; bias via the initial prompt instead.
        if hotwords:
            kwargs["initial_prompt"] = hotwords
        result = self._mlx.transcribe(samples, **kwargs)
        return (result.get("text") or "").strip()
