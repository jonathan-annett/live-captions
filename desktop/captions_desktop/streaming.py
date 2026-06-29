"""Caption producers.

- ``MockProducer``: scripted captions on the event loop — verifies the whole
  server/transport without audio or ASR deps.
- ``LiveStreamer``: real pipeline — sounddevice capture in a worker thread,
  energy VAD endpointing, faster-whisper transcription, published to the hub.

Both honor the ``Controller`` protocol the server's control channel drives.
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from typing import Any, Optional, Protocol

from .engines.base import ASREngine
from .hub import CaptionHub
from .protocol import CaptionSegment, EngineStatus
from .vad import EnergyVAD


class Controller(Protocol):
    def start(self) -> None: ...
    def stop(self) -> None: ...
    def set_dictionary(self, terms: list[str]) -> None: ...


# ---------------------------------------------------------------------------
# Mock
# ---------------------------------------------------------------------------

_SCRIPT = [
    "Welcome everyone to tonight's event.",
    "These captions are generated entirely on device.",
    "No audio ever leaves this machine.",
    "The desktop build uses WhisperX under the hood.",
    "Let's get started.",
]


class MockProducer:
    def __init__(self, hub: CaptionHub) -> None:
        self.hub = hub
        self._task: Optional[asyncio.Task] = None
        self._counter = 0

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._run())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    def set_dictionary(self, terms: list[str]) -> None:
        pass

    async def _run(self) -> None:
        self.hub.emit_status(
            EngineStatus(state="listening", backend="mock", model="demo", device="cpu")
        )
        clock = 0.0
        while True:
            for sentence in _SCRIPT:
                self._counter += 1
                sid = f"mock-{self._counter}"
                words = sentence.split(" ")
                start = clock
                for i in range(len(words)):
                    seg = CaptionSegment(
                        id=sid,
                        text=" ".join(words[: i + 1]),
                        start=start,
                        end=start + (i + 1) * 0.3,
                    )
                    self.hub.emit_partial(seg)
                    await asyncio.sleep(0.22)
                end = start + len(words) * 0.3
                self.hub.emit_final(
                    CaptionSegment(id=sid, text=sentence, start=start, end=end)
                )
                clock = end + 0.6
                await asyncio.sleep(0.6)


# ---------------------------------------------------------------------------
# Live
# ---------------------------------------------------------------------------


class LiveStreamer:
    def __init__(
        self,
        hub: CaptionHub,
        engine: ASREngine,
        sample_rate: int = 16000,
        block_ms: int = 32,
        device: Optional[int] = None,
    ) -> None:
        self.hub = hub
        self.engine = engine
        self.sample_rate = sample_rate
        self.block = int(sample_rate * block_ms / 1000)
        self.device = device
        self.dictionary: list[str] = []

        self._vad = EnergyVAD(sample_rate)
        self._stream: Any = None
        self._worker: Optional[threading.Thread] = None
        self._running = threading.Event()
        self._frames: "Any" = None  # queue.Queue, set on start

        # utterance state
        self._sample_count = 0
        self._preroll: list[Any] = []
        self._preroll_n = 0
        self._utter: list[Any] = []
        self._utter_n = 0
        self._utter_start = 0
        self._in_utter = False
        self._current_id = ""
        self._since_partial = 0

        self._preroll_cap = int(sample_rate * 0.25)
        self._partial_every = int(sample_rate * 0.7)
        self._max_utter = int(sample_rate * 14)

    def set_dictionary(self, terms: list[str]) -> None:
        self.dictionary = terms

    def start(self) -> None:
        import queue

        import numpy as np  # noqa: F401  (ensures numpy present before capture)
        import sounddevice as sd

        status = self.engine.load()
        self.hub.emit_status(status)
        if status.state == "error":
            return

        self._frames = queue.Queue(maxsize=256)
        self._running.set()

        def callback(indata, _frames, _time, _status):  # sounddevice thread
            try:
                self._frames.put_nowait(indata[:, 0].copy())
            except queue.Full:
                pass

        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=1,
            dtype="float32",
            blocksize=self.block,
            device=self.device,
            callback=callback,
        )
        self._stream.start()

        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._running.clear()
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        if self._worker:
            self._worker.join(timeout=2.0)
            self._worker = None
        self.hub.emit_status(EngineStatus(state="idle"))

    def _run(self) -> None:
        import queue

        while self._running.is_set():
            try:
                frame = self._frames.get(timeout=0.2)
            except queue.Empty:
                continue
            self._on_frame(frame)

    def _on_frame(self, frame: Any) -> None:
        self._sample_count += len(frame)
        ev = self._vad.process(frame)

        if ev == "start":
            self._start_utterance()

        if self._in_utter:
            self._utter.append(frame)
            self._utter_n += len(frame)
            self._since_partial += len(frame)
        else:
            self._push_preroll(frame)

        if ev == "end":
            self._finish_utterance()
            return

        if self._in_utter and self._utter_n >= self._max_utter:
            self._finish_utterance()
            self._start_utterance()
            return

        if self._in_utter and self._since_partial >= self._partial_every:
            self._since_partial = 0
            self._decode(final=False)

    def _push_preroll(self, frame: Any) -> None:
        self._preroll.append(frame)
        self._preroll_n += len(frame)
        while self._preroll_n > self._preroll_cap and len(self._preroll) > 1:
            self._preroll_n -= len(self._preroll.pop(0))

    def _start_utterance(self) -> None:
        self._in_utter = True
        self._utter = list(self._preroll)
        self._utter_n = self._preroll_n
        self._utter_start = self._sample_count - self._preroll_n
        self._since_partial = 0
        self._current_id = uuid.uuid4().hex
        self._preroll = []
        self._preroll_n = 0

    def _finish_utterance(self) -> None:
        if not self._in_utter:
            return
        self._decode(final=True)
        self._in_utter = False
        self._utter = []
        self._utter_n = 0

    def _decode(self, final: bool) -> None:
        import numpy as np

        if self._utter_n == 0:
            return
        samples = np.concatenate(self._utter).astype(np.float32)
        seg_id = self._current_id
        start = self._utter_start / self.sample_rate
        end = self._sample_count / self.sample_rate
        hotwords = ", ".join(self.dictionary) if self.dictionary else None
        text = self.engine.transcribe(samples, hotwords=hotwords)
        if not text:
            return
        seg = CaptionSegment(id=seg_id, text=text, start=start, end=end)
        if final:
            self.hub.emit_final(seg)
        else:
            self.hub.emit_partial(seg)
