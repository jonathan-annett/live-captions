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


def test_parse_dictionary_comma_and_file(tmp_path):
    assert _parse_dictionary("Acme, Inc., Widget") == ["Acme", "Inc.", "Widget"]
    assert _parse_dictionary(None) == []
    f = tmp_path / "dict.txt"
    f.write_text("Alpha\nBeta, Gamma\n")
    assert _parse_dictionary(f"@{f}") == ["Alpha", "Beta", "Gamma"]
