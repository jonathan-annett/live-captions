"""Energy-based VAD (Python port of the PWA's, so both builds endpoint alike).

Adaptive noise floor + on/off hangover. A Silero-VAD upgrade can sit behind the
same ``process()`` interface later.
"""

from __future__ import annotations

import math
from typing import Optional, Sequence


class EnergyVAD:
    def __init__(
        self,
        sample_rate: int = 16000,
        start_ms: float = 120,
        end_ms: float = 600,
        margin: float = 2.5,
    ) -> None:
        self.sample_rate = sample_rate
        self.start_ms = start_ms
        self.end_ms = end_ms
        self.margin = margin
        self.noise_floor = 0.005
        self.speaking = False
        self._speech_ms = 0.0
        self._silence_ms = 0.0

    def process(self, frame: Sequence[float]) -> Optional[str]:
        """Returns 'start', 'end', or None for this frame."""
        rms = _rms(frame)
        dur_ms = (len(frame) / self.sample_rate) * 1000
        threshold = max(self.noise_floor * self.margin, 0.006)
        is_speech = rms > threshold

        if not is_speech:
            self.noise_floor = self.noise_floor * 0.95 + rms * 0.05

        if self.speaking:
            if is_speech:
                self._silence_ms = 0.0
            else:
                self._silence_ms += dur_ms
                if self._silence_ms >= self.end_ms:
                    self.speaking = False
                    self._speech_ms = 0.0
                    return "end"
        elif is_speech:
            self._speech_ms += dur_ms
            if self._speech_ms >= self.start_ms:
                self.speaking = True
                self._silence_ms = 0.0
                return "start"
        else:
            self._speech_ms = 0.0
        return None


def _rms(frame: Sequence[float]) -> float:
    # Fast path for numpy arrays (the live audio frames).
    if hasattr(frame, "size"):
        import numpy as np  # type: ignore

        arr = frame  # type: ignore[assignment]
        if arr.size == 0:  # type: ignore[attr-defined]
            return 0.0
        return float(np.sqrt(np.mean(np.square(arr, dtype=np.float64))))
    if len(frame) == 0:
        return 0.0
    total = 0.0
    for x in frame:
        total += x * x
    return math.sqrt(total / len(frame))
