"""faster-whisper (CTranslate2) ASR backend.

Default desktop engine: CPU everywhere, CUDA on NVIDIA. Note CTranslate2 has no
Apple-GPU support, so on macOS this runs on CPU — an MLX/whisper.cpp backend
(M7) is the GPU path there. Heavy imports are lazy so the server can run with the
mock producer on a Python version that lacks faster-whisper wheels.
"""

from __future__ import annotations

from typing import Any, Optional

from ..protocol import EngineStatus, Word
from .base import ASREngine, TranscribeResult


class FasterWhisperEngine(ASREngine):
    def __init__(
        self,
        model: str = "base.en",
        device: str = "auto",
        compute_type: Optional[str] = None,
        language: str = "en",
    ) -> None:
        self.model_name = model
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self._model: Any = None
        self._resolved_device = device

    def load(self) -> EngineStatus:
        try:
            from faster_whisper import WhisperModel  # lazy
        except Exception as exc:  # pragma: no cover - env dependent
            return EngineStatus(
                state="error",
                backend="faster-whisper",
                message=f"faster-whisper not installed: {exc}",
            )

        device = self.device
        if device == "auto":
            device = "cuda" if _cuda_available() else "cpu"
        self._resolved_device = device
        compute_type = self.compute_type or (
            "float16" if device == "cuda" else "int8"
        )

        try:
            self._model = WhisperModel(
                self.model_name, device=device, compute_type=compute_type
            )
        except Exception as exc:  # pragma: no cover - env dependent
            return EngineStatus(
                state="error",
                backend="faster-whisper",
                model=self.model_name,
                device=device,
                message=str(exc),
            )

        return EngineStatus(
            state="listening",
            backend="faster-whisper",
            model=self.model_name,
            device=device,
        )

    def transcribe(
        self, samples: Any, hotwords: Optional[str] = None
    ) -> TranscribeResult:
        if self._model is None:
            return TranscribeResult(text="")
        segments, _info = self._model.transcribe(
            samples,
            language=self.language,
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
            hotwords=hotwords or None,
            word_timestamps=True,
        )
        seg_list = list(segments)
        text = " ".join(s.text.strip() for s in seg_list).strip()
        words: list[Word] = []
        for s in seg_list:
            for w in getattr(s, "words", None) or []:
                words.append(
                    Word(
                        text=w.word,  # faster-whisper keeps a leading space
                        start=float(w.start),
                        end=float(w.end),
                        confidence=_clamp01(w.probability),
                    )
                )
        return TranscribeResult(text=text, words=words or None)


def _clamp01(p: Any) -> Optional[float]:
    """Coerce a decoder probability into the protocol's 0..1 confidence range."""
    try:
        return max(0.0, min(1.0, float(p)))
    except (TypeError, ValueError):
        return None


def _cuda_available() -> bool:
    try:
        import ctranslate2  # type: ignore

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False
