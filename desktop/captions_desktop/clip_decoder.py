"""Clip-decode ASR backend (`serve --asr-server`).

The pivot's Python role: a stateless, per-clip decode service. The BROWSER owns
capture, VAD, utterance framing, the transcript log, ids, and corrections; it
ships each finished utterance clip over a binary WebSocket frame (see
``clip_frame.py``) and this service decodes it and replies with the text —
correlated purely by the browser-allocated ``reqId``. It never sees a segment
UUID, never assembles utterances, and does not touch the ``CaptionHub`` (replies
are point-to-point on the requesting socket; see server.py).

- Immediate decode → ``asrResult{reqId, text, words}`` (greedy, low latency).
- FINAL clips are also queued to a higher-quality refine pass on its own engine
  + thread → ``asrRefined{reqId, …}`` (same reqId; the browser maps it back to
  the segment). Reuses ``refine.refine_decode``.
- ``asrStatus`` / ``asrModels`` are broadcast to every connected client;
  ``asrResult`` / ``asrRefined`` go only to the socket that sent the clip.

Decodes run on a worker thread (off the event loop); the process-wide MLX lock
already serializes Metal, and refine runs on its own thread. Implements the same
``Controller`` protocol as ``LiveStreamer``/``MockProducer``.
"""

from __future__ import annotations

import queue
import threading
from typing import Any, Callable, Optional

from .engines.base import ASREngine
from .protocol import (
    AsrModelsMessage,
    AsrRefinedMessage,
    AsrResultMessage,
    AsrStatusMessage,
    EngineStatus,
    ServerMessage,
)
from .refine import refine_decode

# Models the picker advertises for the local server (mirrors the desktop panel's
# MODELS list). Just a hint — any HF repo still works via an explicit asrLoad.
DEFAULT_ASR_MODELS = ["tiny.en", "small.en", "medium.en", "large-v3", "large-v3-turbo"]

Send = Callable[[ServerMessage], None]


class ClipDecoder:
    def __init__(
        self,
        make_engine: Callable[[str], ASREngine],
        model: str,
        *,
        make_refine_engine: Optional[Callable[[str], ASREngine]] = None,
        refine_model: Optional[str] = None,
        sample_rate: int = 16000,
        models: Optional[list[str]] = None,
    ) -> None:
        self._make_engine = make_engine
        self._make_refine_engine = make_refine_engine
        self._model = model
        self._refine_model = refine_model
        self._sample_rate = sample_rate
        self._models = models or list(DEFAULT_ASR_MODELS)

        self._engine: Optional[ASREngine] = None
        self._refine_engine: Optional[ASREngine] = None
        self._hotwords: Optional[str] = None
        self._recent = ""  # refine prompt tail (cross-utterance context)

        self._running = threading.Event()
        self._decode_q: "queue.Queue[tuple]" = queue.Queue()
        self._refine_q: "queue.Queue[tuple]" = queue.Queue()
        self._decode_thread: Optional[threading.Thread] = None
        self._refine_thread: Optional[threading.Thread] = None

        # Connected clients (their point-to-point send fns) for status/models
        # broadcast; guarded because register/unregister run on the loop thread
        # while the worker threads broadcast.
        self._clients: set[Send] = set()
        self._clients_lock = threading.Lock()
        self._last_status: Optional[EngineStatus] = None

    # --- Controller protocol ------------------------------------------------

    def start(self) -> None:
        if self._running.is_set():
            return
        self._running.set()
        self._decode_thread = threading.Thread(target=self._decode_run, daemon=True)
        self._decode_thread.start()
        if self._make_refine_engine is not None and self._refine_model:
            self._refine_thread = threading.Thread(target=self._refine_run, daemon=True)
            self._refine_thread.start()
        # Load the initial model on the worker (keeps start() off the load path);
        # clips are queued FIFO behind it, so the engine is ready before the first.
        self._decode_q.put(("load", self._model))

    def stop(self) -> None:
        self._running.clear()
        self._decode_q.put(("stop",))
        self._refine_q.put(("stop",))
        for t in (self._decode_thread, self._refine_thread):
            if t is not None:
                t.join(timeout=3.0)
        self._decode_thread = None
        self._refine_thread = None

    def set_dictionary(self, terms: list[str]) -> None:
        self._hotwords = ", ".join(terms) if terms else None

    def set_model(self, model: str, refine_model: Optional[str] = None) -> None:
        """Swap the live model (via the factory). ``refine_model`` is left
        unchanged when omitted (unlike LiveStreamer, this backend's refine config
        comes from CLI flags and isn't disabled by an asrLoad)."""
        if refine_model is not None:
            self._refine_model = refine_model
        if model == self._model and self._engine is not None:
            self._broadcast_status()  # already loaded — just re-sync the client
            return
        self._model = model
        self._decode_q.put(("load", model))

    def set_device(self, device: Optional[int]) -> None:
        pass  # the browser owns capture; there's no server-side mic in this mode.

    def get_input_device(self) -> Optional[int]:
        return None

    # --- client registration (server.py, on connect/disconnect) -------------

    def register_client(self, send: Send) -> None:
        with self._clients_lock:
            self._clients.add(send)
        # Catch the new client up: advertised models + the current engine status.
        send(AsrModelsMessage(models=list(self._models)))
        if self._last_status is not None:
            send(AsrStatusMessage(status=self._last_status))

    def unregister_client(self, send: Send) -> None:
        with self._clients_lock:
            self._clients.discard(send)

    # --- clip ingest (server.py, on a binary frame) -------------------------

    def submit_clip(self, req_id: int, final: bool, samples: Any, send: Send) -> None:
        """Queue a clip for decode. Called from the event loop; the actual decode
        runs on the worker thread so it never blocks the socket reader."""
        self._decode_q.put(("clip", req_id, final, samples, send))

    # --- workers ------------------------------------------------------------

    def _decode_run(self) -> None:
        while self._running.is_set():
            try:
                task = self._decode_q.get(timeout=0.2)
            except queue.Empty:
                continue
            kind = task[0]
            if kind == "stop":
                break
            if kind == "load":
                self._do_load(task[1])
            elif kind == "clip":
                _, req_id, final, samples, send = task
                try:
                    self._decode_clip(req_id, final, samples, send)
                except Exception:  # noqa: BLE001 - never let one clip kill the worker
                    pass

    def _do_load(self, model: str) -> None:
        self._broadcast_status(EngineStatus(state="loading", backend="local-server", model=model))
        try:
            engine = self._make_engine(model)
            status = engine.load()
            if status.state == "error":
                self._broadcast_status(status)
                return
            # Warm the model (first real compile/download happens here).
            import numpy as np

            engine.transcribe(np.zeros(self._sample_rate, dtype="float32"))
        except Exception as exc:  # noqa: BLE001
            self._broadcast_status(
                EngineStatus(state="error", backend="local-server", model=model, message=str(exc))
            )
            return
        self._engine = engine
        self._model = model
        self._broadcast_status(
            EngineStatus(
                state="listening",
                backend=status.backend or engine.__class__.__name__,
                model=model,
                device=status.device,
            )
        )

    def _decode_clip(self, req_id: int, final: bool, samples: Any, send: Send) -> None:
        engine = self._engine
        if engine is None:
            send(AsrResultMessage(req_id=req_id, text=""))
            return
        result = engine.transcribe(samples, hotwords=self._hotwords)
        # Word times are clip-relative (start from 0), exactly as the WebGPU
        # worker returns them — the browser offsets to session time uniformly.
        send(AsrResultMessage(req_id=req_id, text=result.text, words=result.words))
        # FINAL clips also go to the refine pass (if enabled), keyed by the same
        # reqId so the browser maps the refined text back to its segment.
        if final and self._refine_thread is not None:
            self._refine_q.put((req_id, samples, send))

    def _refine_run(self) -> None:
        try:
            self._refine_engine = self._make_refine_engine(self._refine_model)  # type: ignore[misc]
            status = self._refine_engine.load()
            if status.state == "error":
                return
            import numpy as np

            self._refine_engine.transcribe(np.zeros(self._sample_rate, dtype="float32"), quality=True)
        except Exception:  # noqa: BLE001 - fall back to live-only on a refine load failure
            self._refine_engine = None
            return
        while self._running.is_set():
            try:
                item = self._refine_q.get(timeout=0.2)
            except queue.Empty:
                continue
            if item[0] == "stop":
                break
            req_id, samples, send = item
            try:
                text, words = refine_decode(
                    self._refine_engine, samples, 0.0, 0.0,
                    hotwords=self._hotwords, prompt=self._recent or None,
                )
                if text is not None:
                    send(AsrRefinedMessage(req_id=req_id, text=text, words=words))
                    self._recent = (self._recent + " " + text)[-400:].strip()
            except Exception:  # noqa: BLE001 - refinement is best-effort
                pass

    # --- status broadcast ---------------------------------------------------

    def _broadcast_status(self, status: Optional[EngineStatus] = None) -> None:
        if status is not None:
            self._last_status = status
        if self._last_status is None:
            return
        msg = AsrStatusMessage(status=self._last_status)
        with self._clients_lock:
            clients = list(self._clients)
        for send in clients:
            try:
                send(msg)
            except Exception:  # noqa: BLE001
                pass
