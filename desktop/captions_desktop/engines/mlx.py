"""MLX-Whisper ASR backend — GPU-accelerated Whisper on Apple Silicon.

This is the macOS GPU path: faster-whisper/CTranslate2 is CPU-only on Mac, while
MLX runs on the Apple GPU. Used automatically on Apple Silicon when installed
(see engines.create_engine). Heavy import is lazy.
"""

from __future__ import annotations

import threading
from typing import Any, Optional

from ..protocol import EngineStatus, Word
from .base import ASREngine, TranscribeResult, download_with_retry

# MLX/Metal is NOT safe for concurrent kernel compile/dispatch — two threads in
# transcribe at once (e.g. the live engine + the background refinement engine, or
# a model hot-swap racing an in-flight decode) crashes with SIGABRT in
# compile_and_invoke. This process-wide lock serializes every MLX decode across
# ALL engine instances, so only one runs on the GPU at a time. (Live takes the
# lock first; refinement is best-effort and simply waits its turn.)
_MLX_LOCK = threading.Lock()


def _clamp01(p: Any) -> Optional[float]:
    """Coerce a decoder probability into the protocol's 0..1 confidence range."""
    try:
        return max(0.0, min(1.0, float(p)))
    except (TypeError, ValueError):
        return None


# Short names whose mlx-community repo doesn't follow the `whisper-<name>-mlx`
# convention (e.g. the turbo repo has no `-mlx` suffix).
_REPO_OVERRIDES = {
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "turbo": "mlx-community/whisper-large-v3-turbo",
}


def _resolve_repo(model: str) -> str:
    """Map a short model name to an mlx-community repo; pass full repos through."""
    if "/" in model:
        return model
    if model in _REPO_OVERRIDES:
        return _REPO_OVERRIDES[model]
    return f"mlx-community/whisper-{model}-mlx"


class MLXWhisperEngine(ASREngine):
    def __init__(self, model: str = "base.en", language: str = "en") -> None:
        self.model_name = model
        self.repo = _resolve_repo(model)
        self.language = language
        self._mlx: Any = None
        # Local snapshot dir, resolved once in load(). Passing this to transcribe
        # (instead of the repo id) stops mlx_whisper from re-resolving the HF repo
        # on every decode (the "Fetching 4 files" spam + per-call overhead).
        self._path: Optional[str] = None

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
        # Pre-fetch the weights explicitly with resume + retry, rather than letting
        # the first transcribe trigger an opaque (and previously un-retried) download.
        try:
            from huggingface_hub import snapshot_download

            # snapshot_download returns the local snapshot dir — keep it and load
            # from disk on every decode (no per-call HF re-resolution).
            self._path = download_with_retry(
                lambda: snapshot_download(self.repo), self.repo
            )
        except Exception as exc:  # noqa: BLE001 - surface a clean error status
            return EngineStatus(
                state="error",
                backend="mlx-whisper",
                model=self.repo,
                message=f"model download failed: {exc}",
            )
        self._mlx = mlx_whisper
        return EngineStatus(
            state="listening",
            backend="mlx-whisper",
            model=self.repo,
            device="mlx (apple gpu)",
        )

    def transcribe(
        self,
        samples: Any,
        hotwords: Optional[str] = None,
        *,
        quality: bool = False,
        prompt: Optional[str] = None,
    ) -> TranscribeResult:
        if self._mlx is None:
            return TranscribeResult(text="")
        kwargs: dict[str, Any] = {
            # Load from the local snapshot dir (resolved once) so mlx_whisper
            # doesn't re-resolve the HF repo on every decode.
            "path_or_hf_repo": self._path or self.repo,
            "language": self.language,
            "word_timestamps": True,
        }
        # MLX has no hotwords/beam params; condition via the initial prompt — for
        # refinement that's the preceding text plus the dictionary bias.
        prompt_parts = [p for p in (prompt, hotwords) if p]
        if prompt_parts:
            kwargs["initial_prompt"] = " ".join(prompt_parts)
        # Serialize Metal work across live + refine threads (see _MLX_LOCK).
        with _MLX_LOCK:
            result = self._mlx.transcribe(samples, **kwargs)
        text = (result.get("text") or "").strip()
        words: list[Word] = []
        for seg in result.get("segments") or []:
            for w in seg.get("words") or []:
                words.append(
                    Word(
                        text=w.get("word", ""),
                        start=float(w.get("start", 0.0)),
                        end=float(w.get("end", 0.0)),
                        confidence=_clamp01(w.get("probability")),
                    )
                )
        return TranscribeResult(text=text, words=words or None)
