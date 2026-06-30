import numpy as np

from captions_desktop.engines.base import TranscribeResult
from captions_desktop.hub import CaptionHub
from captions_desktop.protocol import Word
from captions_desktop.refine import RefinementPass
from captions_desktop.streaming import LiveStreamer


class _FakeEngine:
    """Returns fixed clip-relative words so we can check the streamer's offset."""

    def __init__(self, result: TranscribeResult) -> None:
        self._result = result
        self.hotwords: str | None = None

    def load(self):  # pragma: no cover - unused
        raise NotImplementedError

    def transcribe(self, samples, hotwords=None) -> TranscribeResult:
        self.hotwords = hotwords
        return self._result


def _decode_one(result: TranscribeResult, *, utter_start: int, end_count: int):
    hub = CaptionHub()
    hub.submit = hub._dispatch  # dispatch synchronously (no event loop in tests)
    engine = _FakeEngine(result)
    streamer = LiveStreamer(hub, engine, sample_rate=16000)
    streamer._current_id = "u1"
    streamer._utter = [np.zeros(16000, dtype=np.float32)]
    streamer._utter_n = 16000
    streamer._utter_start = utter_start
    streamer._sample_count = end_count
    streamer._decode(final=True)
    return hub.history()[-1], engine


def test_word_timestamps_offset_to_session_time():
    # Utterance starts at 2.0s (32000 samples) and ends at 3.0s.
    seg, _ = _decode_one(
        TranscribeResult(
            text="hello world",
            words=[
                Word(text="hello", start=0.0, end=0.4, confidence=0.9),
                Word(text="world", start=0.4, end=0.8, confidence=0.8),
            ],
        ),
        utter_start=32000,
        end_count=48000,
    )
    assert seg.text == "hello world"
    assert seg.words is not None
    assert seg.words[0].start == 2.0  # 0.0 + 2.0s offset
    assert round(seg.words[1].end, 3) == 2.8  # 0.8 + 2.0s offset
    assert seg.words[0].confidence == 0.9


def test_decode_without_words_emits_plain_segment():
    seg, _ = _decode_one(
        TranscribeResult(text="just text"), utter_start=0, end_count=16000
    )
    assert seg.text == "just text"
    assert seg.words is None


def test_catch_up_drains_silence_backlog_and_keeps_the_clock():
    import queue

    hub = CaptionHub()
    streamer = LiveStreamer(hub, _FakeEngine(TranscribeResult(text="x")), sample_rate=16000)
    streamer._frames = queue.Queue(maxsize=256)
    for _ in range(50):  # ~1.6s of buffered frames
        streamer._frames.put_nowait(np.zeros(streamer.block, dtype=np.float32))
    streamer._in_utter = False
    before = streamer._sample_count
    streamer._catch_up()
    assert streamer._frames.qsize() == 0  # backlog dropped
    # Session clock advanced by the skipped audio so timestamps stay real-time.
    assert streamer._sample_count == before + 50 * streamer.block


class _RecordingRefiner:
    def __init__(self):
        self.submitted = []
        self.terms = None

    def set_dictionary(self, terms):
        self.terms = terms

    def submit(self, seg_id, samples, start, end):
        self.submitted.append((seg_id, start, end))


def test_finalized_utterance_is_submitted_to_the_refiner():
    hub = CaptionHub()
    hub.submit = hub._dispatch
    refiner = _RecordingRefiner()
    streamer = LiveStreamer(
        hub, _FakeEngine(TranscribeResult(text="hello")), sample_rate=16000, refiner=refiner
    )
    streamer.set_dictionary(["Kubernetes"])  # forwarded to the refiner
    streamer._current_id = "u1"
    streamer._utter = [np.zeros(16000, dtype=np.float32)]
    streamer._utter_n = 16000
    streamer._utter_start = 0
    streamer._sample_count = 16000
    streamer._decode(final=True)
    assert refiner.terms == ["Kubernetes"]
    assert refiner.submitted == [("u1", 0.0, 1.0)]


def test_partial_is_not_submitted_to_the_refiner():
    hub = CaptionHub()
    hub.submit = hub._dispatch
    refiner = _RecordingRefiner()
    streamer = LiveStreamer(
        hub, _FakeEngine(TranscribeResult(text="hello")), sample_rate=16000, refiner=refiner
    )
    streamer._current_id = "u1"
    streamer._utter = [np.zeros(16000, dtype=np.float32)]
    streamer._utter_n = 16000
    streamer._utter_start = 0
    streamer._sample_count = 16000
    streamer._decode(final=False)
    assert refiner.submitted == []


def test_set_model_swaps_engine_via_factory():
    hub = CaptionHub()

    def make_engine(model):
        return _FakeEngine(TranscribeResult(text=model))

    def make_refine_engine(model):
        return _FakeEngine(TranscribeResult(text="r:" + model))

    refiner = RefinementPass(hub, make_refine_engine("base.en"))
    streamer = LiveStreamer(
        hub,
        make_engine("base.en"),
        sample_rate=16000,
        refiner=refiner,
        make_engine=make_engine,
        make_refine_engine=make_refine_engine,
        model="base.en",
        refine_model="base.en",
    )
    # Idle (not capturing): set_model just rebuilds the engines via the factories.
    streamer.set_model("small.en", "large-v3")
    assert streamer.model == "small.en"
    assert streamer.engine._result.text == "small.en"  # new live engine
    assert streamer.refine_model == "large-v3"
    assert refiner.engine._result.text == "r:large-v3"  # new refine engine


def test_set_model_noop_without_factory():
    hub = CaptionHub()
    engine = _FakeEngine(TranscribeResult(text="base"))
    streamer = LiveStreamer(hub, engine, sample_rate=16000)  # no make_engine
    streamer.set_model("small.en")
    assert streamer.engine is engine  # unchanged


def test_dictionary_passed_as_hotwords():
    hub = CaptionHub()
    engine = _FakeEngine(TranscribeResult(text="x"))
    streamer = LiveStreamer(hub, engine, sample_rate=16000)
    streamer.set_dictionary(["Kubernetes", "Anthropic"])
    streamer._current_id = "u1"
    streamer._utter = [np.zeros(16000, dtype=np.float32)]
    streamer._utter_n = 16000
    streamer._utter_start = 0
    streamer._sample_count = 16000
    streamer._decode(final=True)
    assert engine.hotwords == "Kubernetes, Anthropic"
