import numpy as np

from captions_desktop.engines.base import TranscribeResult
from captions_desktop.hub import CaptionHub
from captions_desktop.protocol import CaptionSegment, FinalMessage, Word
from captions_desktop.refine import RefinementPass


class _FakeEngine:
    """Records how it was called and returns a fixed clip-relative result."""

    def __init__(self, result: TranscribeResult) -> None:
        self._result = result
        self.calls: list[dict] = []

    def load(self):
        from captions_desktop.protocol import EngineStatus

        return EngineStatus(state="listening", backend="fake")

    def transcribe(self, samples, hotwords=None, *, quality=False, prompt=None):
        self.calls.append({"hotwords": hotwords, "quality": quality, "prompt": prompt})
        return self._result


def _hub_sync() -> CaptionHub:
    hub = CaptionHub()
    hub.submit = hub._dispatch  # dispatch synchronously (no event loop in tests)
    return hub


def test_refine_one_reemits_same_id_with_quality_and_offsets():
    hub = _hub_sync()
    # The live segment that will be refined.
    hub._dispatch(FinalMessage(segment=CaptionSegment(id="u1", text="cooper netties", start=2.0, end=3.0)))

    engine = _FakeEngine(
        TranscribeResult(
            text="Kubernetes",
            words=[Word(text="Kubernetes", start=0.0, end=0.8, confidence=0.95)],
        )
    )
    refiner = RefinementPass(hub, engine)
    refiner.refine_one("u1", np.zeros(16000, dtype=np.float32), 2.0, 3.0)

    # Same id replaced in place, refined text, words offset to session time.
    assert len(hub.history()) == 1
    seg = hub.history()[0]
    assert seg.id == "u1"
    assert seg.text == "Kubernetes"
    assert seg.words[0].start == 2.0  # 0.0 + 2.0 offset
    # Decoded with the high-quality path.
    assert engine.calls[0]["quality"] is True


def test_refine_does_not_clobber_a_locked_segment():
    hub = _hub_sync()
    hub._dispatch(
        FinalMessage(
            segment=CaptionSegment(id="u1", text="Operator fix", start=0, end=1, locked=True)
        )
    )
    refiner = RefinementPass(hub, _FakeEngine(TranscribeResult(text="machine guess")))
    refiner.refine_one("u1", np.zeros(16000, dtype=np.float32), 0, 1)
    # Refinement is non-locked → the locked operator text wins.
    assert hub.history()[0].text == "Operator fix"


def test_refine_passes_recent_text_as_prompt_and_dictionary():
    hub = _hub_sync()
    engine = _FakeEngine(TranscribeResult(text="second"))
    refiner = RefinementPass(hub, engine)
    refiner.set_dictionary(["Kubernetes"])
    refiner.refine_one("a", np.zeros(8000, dtype=np.float32), 0, 1)
    refiner.refine_one("b", np.zeros(8000, dtype=np.float32), 1, 2)
    # First call has no prior text; second is conditioned on the first refinement.
    assert engine.calls[0]["prompt"] is None
    assert engine.calls[1]["prompt"] == "second"
    assert engine.calls[1]["hotwords"] == "Kubernetes"


def test_refine_skips_empty_decode():
    hub = _hub_sync()
    refiner = RefinementPass(hub, _FakeEngine(TranscribeResult(text="")))
    refiner.refine_one("a", np.zeros(8000, dtype=np.float32), 0, 1)
    assert hub.history() == []
