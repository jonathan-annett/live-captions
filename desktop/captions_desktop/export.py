"""Transcript export (mirror of packages/protocol/src/export.ts)."""

from __future__ import annotations

from typing import Sequence

from .protocol import CaptionSegment
from .render import join_segments


def to_plain_text(segments: Sequence[CaptionSegment]) -> str:
    return "\n".join(line.text for line in join_segments(segments)) + "\n"


def to_srt(segments: Sequence[CaptionSegment]) -> str:
    blocks = [
        f"{i + 1}\n{_fmt(line.start, ',')} --> {_fmt(line.end, ',')}\n{line.text}\n"
        for i, line in enumerate(join_segments(segments))
    ]
    return "\n".join(blocks)


def to_vtt(segments: Sequence[CaptionSegment]) -> str:
    cues = [
        f"{_fmt(line.start, '.')} --> {_fmt(line.end, '.')}\n{line.text}\n"
        for line in join_segments(segments)
    ]
    return "WEBVTT\n\n" + "\n".join(cues)


def export_transcript(
    segments: Sequence[CaptionSegment], fmt: str
) -> tuple[str, str, str]:
    """Return (body, mime, filename) for the given format."""
    if fmt == "srt":
        return to_srt(segments), "application/x-subrip", "transcript.srt"
    if fmt == "vtt":
        return to_vtt(segments), "text/vtt", "transcript.vtt"
    return to_plain_text(segments), "text/plain", "transcript.txt"


def _fmt(total_seconds: float, sep: str) -> str:
    # Round to whole milliseconds first to avoid float truncation (e.g. 2.4s).
    total_ms = round(max(0.0, total_seconds) * 1000)
    ms = total_ms % 1000
    total_sec = total_ms // 1000
    hh = total_sec // 3600
    mm = (total_sec % 3600) // 60
    ss = total_sec % 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}{sep}{ms:03d}"
