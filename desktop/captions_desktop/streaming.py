"""Caption producers.

- ``MockProducer``: scripted captions on the event loop — verifies the whole
  server/transport without audio or ASR deps.
- ``LiveStreamer``: real pipeline — sounddevice capture in a worker thread,
  energy VAD endpointing, faster-whisper transcription, published to the hub.

Both honor the ``Controller`` protocol the server's control channel drives.
"""

from __future__ import annotations

import asyncio
import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

from .engines.base import ASREngine
from .hub import CaptionHub
from .protocol import CaptionSegment, EngineStatus, Word
from .recorder import SessionRecorder
from .refine import RefinementPass
from .sanitize import is_degenerate, is_likely_speech
from .vad import EnergyVAD


class Controller(Protocol):
    def start(self) -> None: ...
    def stop(self) -> None: ...
    def set_dictionary(self, terms: list[str]) -> None: ...
    def set_model(self, model: str, refine_model: Optional[str] = None) -> None: ...
    def set_device(self, device: Optional[int]) -> None: ...
    def get_input_device(self) -> Optional[int]: ...


def list_input_devices() -> list[dict]:
    """Enumerate available audio INPUT devices as ``{index, name, channels}``.
    Best-effort: returns ``[]`` if PortAudio/sounddevice is unavailable (e.g. a
    headless CI box) so the caller never crashes on enumeration."""
    try:
        import sounddevice as sd

        devices = sd.query_devices()
    except Exception:  # noqa: BLE001 - no audio backend / no devices
        return []
    out: list[dict] = []
    for i, d in enumerate(devices):
        channels = int(d.get("max_input_channels", 0))
        if channels > 0:
            out.append(
                {"index": i, "name": str(d.get("name", f"device {i}")), "channels": channels}
            )
    return out


def _native_rate(device: Optional[int]) -> Optional[int]:
    """The input device's default samplerate (Hz), or None if undeterminable.
    ``device=None`` = the system default input."""
    try:
        import sounddevice as sd

        info = sd.query_devices(device, "input")
        rate = int(round(float(info["default_samplerate"])))
        return rate if rate > 0 else None
    except Exception:  # noqa: BLE001 - no PortAudio / bad device
        return None


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

    def set_model(self, model: str, refine_model: Optional[str] = None) -> None:
        pass  # the mock has no real ASR model to swap

    def set_device(self, device: Optional[int]) -> None:
        pass  # the mock captures no audio

    def get_input_device(self) -> Optional[int]:
        return None

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
        refiner: Optional[RefinementPass] = None,
        make_engine: Optional[Callable[[str], ASREngine]] = None,
        make_refine_engine: Optional[Callable[[str], ASREngine]] = None,
        model: Optional[str] = None,
        refine_model: Optional[str] = None,
        record_dir: Optional[str] = None,
    ) -> None:
        self.hub = hub
        self.engine = engine
        self.sample_rate = sample_rate
        self.block_ms = block_ms
        self.block = int(sample_rate * block_ms / 1000)
        self.device = device
        self.refiner = refiner
        self.dictionary: list[str] = []
        # Factories let set_model() rebuild the engine(s) for a live model swap
        # (the streamer is otherwise handed a bare engine instance).
        self._make_engine = make_engine
        self._make_refine_engine = make_refine_engine
        self.model = model
        self.refine_model = refine_model

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
        # If we fall this far behind real time (frames queued) AND we're between
        # utterances, discard the buffered silence to catch up to the live edge.
        self._catchup_frames = max(1, int(1.5 * sample_rate / self.block))

        # --- hi-fi session recording (post-production P1; opt-in) -------------
        # When record_dir is set, capture at the device's NATIVE rate and tee a
        # 16 kHz downsample to ASR; otherwise the capture path is byte-identical
        # to before. A "session" = operator Start→Stop; set_model/set_device do an
        # internal stop→start that must NOT split the recording (see _internal_restart).
        self._record_dir = record_dir
        self._recorder: Optional[SessionRecorder] = None
        self._session_dir: Optional[Path] = None
        self._session_meta: dict = {}
        self._internal_restart = False
        self._capture_rate = sample_rate  # native capture rate when recording

    def set_dictionary(self, terms: list[str]) -> None:
        self.dictionary = terms
        if self.refiner is not None:
            self.refiner.set_dictionary(terms)

    def set_model(self, model: str, refine_model: Optional[str] = None) -> None:
        """Hot-swap the live model and enable/disable/swap refinement. Rebuilds the
        engine(s) via the factories and, if capturing, does a controlled
        stop→reload→start (a brief 'loading' gap). `refine_model` controls the
        refiner: a model name enables it (creating the pass if needed), None/empty
        DISABLES it (live-only). Hub/history, WS clients and dictionary survive the
        swap. No-op if no engine factory was provided."""
        if self._make_engine is None:
            return
        running = self._running.is_set()
        if running:
            self._internal_restart = True  # keep the recording session intact
            self.stop()  # tears down capture + refiner; emits idle
        self.model = model
        self.engine = self._make_engine(model)
        # Refiner: build it for the requested model, or drop it (live-only).
        want = refine_model or None
        if self._make_refine_engine is not None:
            if want:
                self.refiner = RefinementPass(self.hub, self._make_refine_engine(want))
                self.refiner.set_dictionary(self.dictionary)
            else:
                self.refiner = None
            self.refine_model = want
        if running:
            self.start()  # reloads + warms the new engine(s), restarts capture
            self._internal_restart = False

    def set_device(self, device: Optional[int]) -> None:
        """Switch the audio input device (index; None = system default). If
        currently listening, the capture stream reopens on the new device without
        reloading the model — hub/history/dictionary all survive. Applied on the
        next start() otherwise."""
        if device == self.device:
            return
        running = self._running.is_set()
        if running:
            self._internal_restart = True  # keep the recording session intact
            self.stop()  # closes the current mic stream; emits idle
        self.device = device
        if running:
            self.start()  # reopens capture on the new device (model already warm-loads)
            self._internal_restart = False

    def get_input_device(self) -> Optional[int]:
        return self.device

    def start(self) -> None:
        import queue

        import numpy as np  # noqa: F401  (ensures numpy present before capture)
        import sounddevice as sd

        # Idempotent: the server autostarts capture, so a panel "Start" while
        # already running must not spawn a second mic stream + worker thread.
        if self._running.is_set():
            return

        status = self.engine.load()
        self.hub.emit_status(status)
        if status.state == "error":
            return
        # Warm the model (download/compile) BEFORE opening the mic. MLX loads the
        # model lazily on the first transcribe; without this, that cold first
        # decode runs while audio is already being captured, and the resulting
        # backlog never drains — it pins the latency for the whole session.
        try:
            self.engine.transcribe(np.zeros(self.sample_rate, dtype="float32"))
        except Exception:  # noqa: BLE001 - warmup is best-effort
            pass
        if self.refiner is not None:
            self.refiner.start()

        self._frames = queue.Queue(maxsize=256)
        self._running.set()

        # Recording (opt-in) inverts capture: open at the device's NATIVE rate and
        # tee a 16 kHz downsample to ASR. Without it, the path below is byte-for-byte
        # the same InputStream + callback as before.
        if self._record_dir is not None:
            self._begin_or_resume_session()

        if self._recorder is not None:
            import soxr  # lazy — only the recording tee needs it

            capture_rate = self._capture_rate
            asr_rate = self.sample_rate
            recorder = self._recorder

            def callback(indata, _frames, _time, _status):  # sounddevice thread
                native = indata[:, 0].copy()
                recorder.submit(native)  # hi-fi archive (native rate)
                try:
                    asr = soxr.resample(native, capture_rate, asr_rate).astype(
                        np.float32, copy=False
                    )
                    self._frames.put_nowait(asr)  # 16 kHz feed for the VAD/ASR
                except queue.Full:
                    pass

            self._stream = sd.InputStream(
                samplerate=capture_rate,
                channels=1,
                dtype="float32",
                blocksize=int(capture_rate * self.block_ms / 1000),
                device=self.device,
                callback=callback,
            )
        else:

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
            # Generous timeout: the worker runs a flush-on-stop final decode after
            # the loop exits (bounded — the in-flight clip is capped at _max_utter).
            self._worker.join(timeout=8.0)
            self._worker = None
        if self.refiner is not None:
            self.refiner.stop()
        # Close the recording + write the bundle manifest ONLY on an operator stop —
        # a model/device hot-swap does an internal stop→start and must keep recording.
        if self._recorder is not None and not self._internal_restart:
            self._end_session()
        self.hub.emit_status(EngineStatus(state="idle"))

    # --- hi-fi session recording --------------------------------------------

    def _begin_or_resume_session(self) -> None:
        """Ensure a recording session + recorder exist for this capture run.

        Fresh operator start → mint a bundle dir + recorder. Internal restart
        (model/device swap) → keep the existing session; if a device swap changed
        the native rate, roll to a new part. If the recording deps aren't installed,
        disable recording for the session (live captions continue unaffected)."""
        native = _native_rate(self.device) or self.sample_rate
        if self._internal_restart and self._recorder is not None:
            if native != self._capture_rate:
                self._recorder.roll(native)
                self._capture_rate = native
            return
        self._capture_rate = native
        try:
            self._start_new_session()
        except Exception as exc:  # noqa: BLE001 - recording is best-effort
            print(
                f"  record:   disabled — {exc} "
                "(install the 'audio' extra: soundfile + soxr)",
                flush=True,
            )
            self._recorder = None
            self._session_dir = None

    def _start_new_session(self) -> None:
        now = datetime.now(timezone.utc)
        sid = f"{now.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
        bundle = Path(self._record_dir) / sid  # type: ignore[arg-type]
        bundle.mkdir(parents=True, exist_ok=True)
        recorder = SessionRecorder(bundle, self._capture_rate)
        recorder.start()  # raises if soundfile is missing → caught by caller
        self._recorder = recorder
        self._session_dir = bundle
        self._session_meta = {
            "id": sid,
            "startedAt": now.isoformat(),
            "asrRate": self.sample_rate,
            "model": self.model,
            "refineModel": self.refine_model,
            "device": self.device,
            "format": recorder.fmt,
        }
        print(f"  record:   session {sid} → {bundle}", flush=True)

    def _end_session(self) -> None:
        recorder = self._recorder
        bundle = self._session_dir
        self._recorder = None
        self._session_dir = None
        if recorder is None or bundle is None:
            return
        try:
            recorder.stop()
        except Exception:  # noqa: BLE001
            pass
        try:
            self._write_bundle_meta(bundle, recorder)
            print(f"  record:   session saved → {bundle}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"  record:   failed to finalize {bundle} — {exc}", flush=True)

    def _write_bundle_meta(self, bundle: Path, recorder: SessionRecorder) -> None:
        # segments.json — the canonical log, same serialization as GET /history.
        segments = [
            s.model_dump(by_alias=True, exclude_none=True) for s in self.hub.history()
        ]
        (bundle / "segments.json").write_text(
            json.dumps({"segments": segments}, indent=2)
        )
        # session.json — manifest the offline post-production pass (P2/P3) reads.
        meta = dict(self._session_meta)
        meta["stoppedAt"] = datetime.now(timezone.utc).isoformat()
        meta["parts"] = recorder.parts
        meta["framesWritten"] = recorder.frames_written
        if recorder.dropped:
            meta["droppedBlocks"] = recorder.dropped
        meta["clockNote"] = (
            "segments.json start/end are ASR-clock seconds (sample_count / asrRate). "
            "The recording is wall-continuous native audio; in normal operation the two "
            "align to within VAD granularity. Under sustained ASR-queue overload the ASR "
            "clock can lag the recording — WhisperX (P2) forced-alignment resolves fine "
            "word timings against the full audio regardless."
        )
        (bundle / "session.json").write_text(json.dumps(meta, indent=2))

    def _run(self) -> None:
        import queue

        while self._running.is_set():
            try:
                frame = self._frames.get(timeout=0.2)
            except queue.Empty:
                continue
            self._on_frame(frame)
            # Between utterances and behind real time? The backlog is silence —
            # drop it to snap back to the live edge (no speech lost).
            if not self._in_utter and self._frames.qsize() > self._catchup_frames:
                self._catch_up()
        # Flush a still-open utterance on stop so its final caption isn't lost.
        # Without this, a session that ends mid-utterance — especially long
        # continuous speech that never hit a VAD endpoint or the max-utter
        # force-commit (e.g. under record-mode's added callback latency) — yields
        # NO finals at all, leaving segments.json empty. Runs in this worker
        # thread; the hub records the final synchronously so stop()'s bundle write
        # (which joins us) sees it.
        if self._in_utter:
            self._finish_utterance()

    def _catch_up(self) -> None:
        import queue

        dropped = 0
        while True:
            try:
                dropped += len(self._frames.get_nowait())
            except queue.Empty:
                break
        if dropped:
            # Keep the session clock aligned with real time (we skipped this audio)
            # and drop now-stale preroll so the next utterance starts clean.
            self._sample_count += dropped
            self._preroll = []
            self._preroll_n = 0

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
        # No-speech gate (mirror of the PWA's pre-decode peak-RMS/duration gate in
        # packages/pwa/src/engine/sanitize.ts): silent/near-silent clips are exactly
        # what make Whisper hallucinate phantom phrases, so never decode them. The
        # energy VAD can false-trigger on brief loud non-speech; this is the backstop.
        if not is_likely_speech(samples, self.sample_rate):
            return
        seg_id = self._current_id
        start = self._utter_start / self.sample_rate
        end = self._sample_count / self.sample_rate
        hotwords = ", ".join(self.dictionary) if self.dictionary else None
        result = self.engine.transcribe(samples, hotwords=hotwords)
        text = result.text
        # Drop non-speech junk. Repetition loops are NOT collapsed here: the raw
        # text is emitted and every render surface collapses at display time
        # (join_segments / TS joinSegments), so keep_repeats can restore a genuine
        # repeat and the operator correction panel still sees the loop to act on.
        # Matches the PWA captioner (which also emits raw and collapses at render).
        if not text or is_degenerate(text):
            return
        # Engine word timestamps are clip-relative; offset to session time. They
        # line up with the raw text we emit.
        words = (
            [
                Word(
                    text=w.text,
                    start=start + w.start,
                    end=start + w.end,
                    confidence=w.confidence,
                )
                for w in result.words
            ]
            if result.words
            else None
        )
        seg = CaptionSegment(id=seg_id, text=text, start=start, end=end, words=words)
        if final:
            self.hub.emit_final(seg)
            # Hand the utterance's audio to the background refinement pass (if on)
            # to re-decode at higher quality and re-emit under the same id.
            if self.refiner is not None:
                self.refiner.submit(seg_id, samples, start, end)
        else:
            self.hub.emit_partial(seg)
