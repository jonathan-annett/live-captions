import queue
import threading

import numpy as np

from captions_desktop.clip_decoder import DEFAULT_ASR_MODELS, ClipDecoder
from captions_desktop.engines.base import TranscribeResult
from captions_desktop.protocol import (
    AsrModelsMessage,
    AsrRefinedMessage,
    AsrResultMessage,
    AsrStatusMessage,
    EngineStatus,
    Word,
)


class FakeEngine:
    """Records how it was called; returns fixed text (marks quality re-decodes)."""

    def __init__(self, text="hello", words=None):
        self._text = text
        self._words = words
        self.calls: list[dict] = []

    def load(self):
        return EngineStatus(state="listening", backend="fake", device="cpu")

    def transcribe(self, samples, hotwords=None, *, quality=False, prompt=None):
        self.calls.append({"quality": quality, "hotwords": hotwords, "prompt": prompt})
        return TranscribeResult(text=(self._text + " (refined)" if quality else self._text), words=self._words)


def _decoder(**kw):
    eng = kw.pop("engine", FakeEngine())
    return ClipDecoder(lambda _m: eng, "small.en", **kw), eng


def test_decode_clip_replies_asrresult_correlated_by_reqid():
    d, eng = _decoder(engine=FakeEngine(text="hi", words=[Word(text="hi", start=0.0, end=0.4)]))
    d._engine = eng
    out: list = []
    d._decode_clip(7, False, np.zeros(16000, dtype=np.float32), out.append)
    assert len(out) == 1
    assert isinstance(out[0], AsrResultMessage)
    assert out[0].req_id == 7 and out[0].text == "hi"
    assert out[0].words[0].text == "hi"  # clip-relative word times passed through
    # A partial (final=False) is never handed to refinement.
    assert d._refine_q.empty()


def test_final_clip_queues_refine_with_same_reqid():
    d, eng = _decoder(make_refine_engine=lambda _m: FakeEngine(), refine_model="large-v3")
    d._engine = eng
    d._refine_thread = threading.Thread(target=lambda: None)  # simulate refine running
    out: list = []
    d._decode_clip(9, True, np.zeros(8000, dtype=np.float32), out.append)
    assert isinstance(out[0], AsrResultMessage) and out[0].req_id == 9
    item = d._refine_q.get_nowait()
    assert item[0] == 9  # reqId carried through to the refine pass


def test_replies_are_point_to_point_not_broadcast():
    d, eng = _decoder(engine=FakeEngine(text="x"))
    d._engine = eng
    a: list = []
    b: list = []
    d._decode_clip(1, False, np.zeros(10, dtype=np.float32), a.append)
    d._decode_clip(2, False, np.zeros(10, dtype=np.float32), b.append)
    # Each result went ONLY to the socket that sent the clip (no cross-talk / fan-out).
    assert len(a) == 1 and a[0].req_id == 1
    assert len(b) == 1 and b[0].req_id == 2


def test_register_client_catches_up_with_models_and_status():
    d, _ = _decoder()
    d._last_status = EngineStatus(state="listening", model="small.en")
    out: list = []
    d.register_client(out.append)
    models = next(m for m in out if isinstance(m, AsrModelsMessage))
    assert models.models == DEFAULT_ASR_MODELS
    assert any(isinstance(m, AsrStatusMessage) for m in out)


def test_set_model_queues_load_when_changed_and_resyncs_when_not():
    d, _ = _decoder()
    d.set_model("large-v3")
    assert d._decode_q.get_nowait() == ("load", "large-v3")

    d._engine = FakeEngine()  # now "loaded"
    d._model = "large-v3"
    d._last_status = EngineStatus(state="listening", model="large-v3")
    out: list = []
    with d._clients_lock:
        d._clients.add(out.append)
    d.set_model("large-v3")  # unchanged + loaded → no reload, just re-sync status
    assert d._decode_q.empty()
    assert any(isinstance(m, AsrStatusMessage) for m in out)


def test_start_loads_then_decodes_on_the_worker_thread():
    d, _ = _decoder(engine=FakeEngine(text="threaded"))
    got: "queue.Queue" = queue.Queue()
    d.start()
    try:
        # Queued right after start(); it waits FIFO behind the load task, so the
        # engine is warm by the time this clip is decoded.
        d.submit_clip(5, True, np.zeros(1600, dtype=np.float32), got.put)
        msg = got.get(timeout=5.0)
        assert isinstance(msg, AsrResultMessage)
        assert msg.req_id == 5 and msg.text == "threaded"
    finally:
        d.stop()


def test_decoder_has_no_hub_reference():
    # Structural guarantee that ClipDecoder never broadcasts via the CaptionHub.
    d, _ = _decoder()
    assert not hasattr(d, "hub")
    assert not hasattr(d, "_hub")
