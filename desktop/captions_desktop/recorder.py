"""Hi-fi session recorder (post-production tier, P1).

Streams the **native-rate** mic audio to a per-session bundle on disk while the
live 16 kHz ASR feed runs untouched. Modeled on ``RefinementPass``: a daemon
writer thread drains a bounded queue and appends blocks to disk via ``soundfile``
— the sounddevice callback only ``submit()``s (never blocks on I/O).

``soundfile`` is imported lazily so the non-recording server and the test suite
install/run without it.
"""

from __future__ import annotations

import queue
import threading
from pathlib import Path
from typing import Any, Optional


class SessionRecorder:
    """Writes native-rate mono audio to ``<bundle>/audio[.NNN].flac``.

    A device change mid-session can change the native samplerate; ``roll()`` closes
    the current file and opens a new numbered part at the new rate, recording each
    part + its rate in :attr:`parts` for the session manifest.
    """

    def __init__(
        self,
        bundle_dir: Path,
        capture_rate: int,
        *,
        fmt: str = "flac",
        max_queued: int = 4096,
    ) -> None:
        self.bundle_dir = Path(bundle_dir)
        self.capture_rate = int(capture_rate)
        self.fmt = fmt
        self.parts: list[dict] = []  # [{file, capture_rate}] for the manifest
        self.frames_written = 0
        self.dropped = 0

        self._q: "queue.Queue[Any]" = queue.Queue(maxsize=max_queued)
        self._running = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._file: Any = None
        self._part_index = 0

    # --- filename for a part -------------------------------------------------
    def _part_path(self, index: int) -> Path:
        name = "audio" if index == 0 else f"audio.{index:03d}"
        return self.bundle_dir / f"{name}.{self.fmt}"

    def _open(self, capture_rate: int) -> None:
        import soundfile as sf  # lazy — only the recording path needs it

        self.capture_rate = int(capture_rate)
        path = self._part_path(self._part_index)
        subtype = "PCM_16" if self.fmt.lower() == "wav" else None
        self._file = sf.SoundFile(
            str(path),
            mode="w",
            samplerate=self.capture_rate,
            channels=1,
            format=self.fmt.upper(),
            subtype=subtype,
        )
        self.parts.append({"file": path.name, "captureRate": self.capture_rate})

    # --- lifecycle -----------------------------------------------------------
    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self.bundle_dir.mkdir(parents=True, exist_ok=True)
        self._open(self.capture_rate)
        self._running.set()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def roll(self, capture_rate: int) -> None:
        """Start a new numbered part at a (possibly new) native rate — used when a
        device change alters the samplerate mid-session. Drains + closes the current
        file first so no blocks land in the wrong-rate file."""
        if self._file is None:
            self.capture_rate = int(capture_rate)
            return
        self._drain()
        self._file.close()
        self._part_index += 1
        self._open(capture_rate)

    def submit(self, block: Any) -> None:
        """Enqueue a native audio block (called from the sounddevice callback).
        Non-blocking: drops (and counts) rather than stall the audio thread — the
        writer is pure disk I/O and keeps up easily, so this should never fire."""
        try:
            self._q.put_nowait(block)
        except queue.Full:
            self.dropped += 1

    def stop(self) -> None:
        self._running.clear()
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None
        self._drain()
        if self._file is not None:
            self._file.close()
            self._file = None

    # --- writer thread -------------------------------------------------------
    def _run(self) -> None:
        while self._running.is_set():
            try:
                block = self._q.get(timeout=0.2)
            except queue.Empty:
                continue
            self._write(block)

    def _drain(self) -> None:
        while True:
            try:
                block = self._q.get_nowait()
            except queue.Empty:
                break
            self._write(block)

    def _write(self, block: Any) -> None:
        if self._file is None:
            return
        try:
            self._file.write(block)
            self.frames_written += len(block)
        except Exception:  # noqa: BLE001 - never let a write error kill capture
            pass
