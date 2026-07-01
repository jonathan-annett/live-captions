from captions_desktop.cli import _parse_dictionary
from captions_desktop.export import (
    export_transcript,
    to_plain_text,
    to_srt,
    to_vtt,
)
from captions_desktop.protocol import CaptionSegment

SEGMENTS = [
    CaptionSegment(id="a", text="Hello world.", start=0.5, end=2.0),
    CaptionSegment(id="b", text="Second line.", start=2.4, end=3.916),
]


def test_plain_text():
    assert to_plain_text(SEGMENTS) == "Hello world.\nSecond line.\n"


def test_srt_indices_and_comma_separator():
    srt = to_srt(SEGMENTS)
    assert "1\n00:00:00,500 --> 00:00:02,000\nHello world." in srt
    assert "2\n00:00:02,400 --> 00:00:03,916\nSecond line." in srt


def test_vtt_header_and_dot_separator():
    vtt = to_vtt(SEGMENTS)
    assert vtt.startswith("WEBVTT\n\n")
    assert "00:00:00.500 --> 00:00:02.000\nHello world." in vtt


def test_export_transcript_dispatch():
    assert export_transcript(SEGMENTS, "srt")[2] == "transcript.srt"
    assert export_transcript(SEGMENTS, "vtt")[1] == "text/vtt"
    assert export_transcript(SEGMENTS, "txt")[1] == "text/plain"


def test_join_next_merges_segments_into_one_line():
    # First segment's join_next merges the next onto it — one line/cue, not two.
    segs = [
        CaptionSegment(id="a", text="hello", start=0.0, end=1.0, join_next="period"),
        CaptionSegment(id="b", text="world", start=1.0, end=2.0),
    ]
    assert to_plain_text(segs) == "hello. world\n"
    srt = to_srt(segs)
    assert "1\n00:00:00,000 --> 00:00:02,000\nhello. world" in srt
    assert "2\n" not in srt  # merged, so no second block


def test_join_next_plain_does_not_double_punctuate():
    # prev already ends hard, so a merge must not add another mark.
    segs = [
        CaptionSegment(id="a", text="Done.", start=0.0, end=1.0, join_next="comma"),
        CaptionSegment(id="b", text="next", start=1.0, end=2.0),
    ]
    assert to_plain_text(segs) == "Done. next\n"


def test_export_collapses_repeats_unless_kept():
    loop = "warning warning warning warning"
    assert to_plain_text([CaptionSegment(id="a", text=loop, start=0.0, end=1.0)]) == "warning\n"
    kept = [CaptionSegment(id="a", text=loop, start=0.0, end=1.0, keep_repeats=True)]
    assert to_plain_text(kept) == loop + "\n"


def test_parse_dictionary_comma_and_file(tmp_path):
    assert _parse_dictionary("Acme, Inc., Widget") == ["Acme", "Inc.", "Widget"]
    assert _parse_dictionary(None) == []
    f = tmp_path / "dict.txt"
    f.write_text("Alpha\nBeta, Gamma\n")
    assert _parse_dictionary(f"@{f}") == ["Alpha", "Beta", "Gamma"]
