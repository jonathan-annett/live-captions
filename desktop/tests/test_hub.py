from captions_desktop.hub import CaptionHub
from captions_desktop.protocol import (
    CaptionSegment,
    ClearMessage,
    FinalMessage,
)


def _final(id: str, start: float, end: float, text: str = "x", locked=None) -> FinalMessage:
    return FinalMessage(
        segment=CaptionSegment(id=id, text=text, start=start, end=end, locked=locked)
    )


def test_dispatch_upserts_final_by_id():
    hub = CaptionHub()
    hub._dispatch(_final("a", 0, 1, "live"))
    hub._dispatch(_final("a", 0, 1, "refined"))  # same id → replace, not duplicate
    assert [s.id for s in hub.history()] == ["a"]
    assert hub.history()[0].text == "refined"


def test_dispatch_does_not_clobber_a_locked_final():
    hub = CaptionHub()
    hub._dispatch(_final("a", 0, 1, "operator fix", locked=True))
    hub._dispatch(_final("a", 0, 1, "refinement"))  # non-locked → ignored
    assert hub.history()[0].text == "operator fix"


def test_dispatch_records_finals_in_history():
    hub = CaptionHub()
    hub._dispatch(_final("a", 0, 1))
    hub._dispatch(_final("b", 1, 2))
    assert [s.id for s in hub.history()] == ["a", "b"]


def test_history_since_filters_by_end():
    hub = CaptionHub()
    hub._dispatch(_final("a", 0, 1))
    hub._dispatch(_final("b", 10, 11))
    assert [s.id for s in hub.history(since=5)] == ["b"]


def test_clear_message_empties_log():
    hub = CaptionHub()
    hub._dispatch(_final("a", 0, 1))
    hub._dispatch(ClearMessage())
    assert hub.history() == []


def test_prune_drops_segments_outside_window():
    hub = CaptionHub(window_seconds=30)
    hub._dispatch(_final("old", 0, 1))
    # Force elapsed far past the window so the next final triggers a prune.
    hub._start -= 100
    hub._dispatch(_final("new", 95, 99))
    ids = [s.id for s in hub.history()]
    assert "old" not in ids and "new" in ids


def test_set_config_merges_patch():
    hub = CaptionHub()
    cfg = hub.set_config({"fontSize": 9, "uppercase": True})
    assert cfg.font_size == 9
    assert cfg.uppercase is True
    # untouched fields preserved
    assert cfg.position == "bottom"
