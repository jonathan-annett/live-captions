"""Segment -> rendered lines (mirror of ``joinSegments`` in
``packages/protocol/src/index.ts``).

Groups finalized segments into display lines honoring each segment's
``join_next`` (the operator line-merge control) with context-aware punctuation,
and collapses repeat runs to one occurrence unless ``keep_repeats`` is set. Kept
in lockstep with the TS ``joinSegments`` so desktop exports match the PWA's for
the same segment log. Blank (post-collapse empty) segments are skipped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Sequence

from .protocol import CaptionSegment
from .sanitize import collapse_repeats

# True if text already ends in a hard period/comma so a merge mustn't add one.
_ENDS_HARD = re.compile(r"[.,]\s*$")


@dataclass
class JoinedLine:
    """One rendered line: one or more segments merged via the operator line-merge."""

    text: str
    start: float
    end: float
    locked: bool
    members: list[CaptionSegment] = field(default_factory=list)


def ends_hard(text: str) -> bool:
    return bool(_ENDS_HARD.search(text))


def join_separator(prev_text: str, join: str) -> str:
    """Separator inserted before the next segment when merging onto ``prev_text``.
    Context-aware: if ``prev_text`` already ends in . or , the added mark is dropped."""
    if ends_hard(prev_text):
        return " "
    if join == "comma":
        return ", "
    if join == "period":
        return ". "
    return " "


def _member_text(seg: CaptionSegment) -> str:
    # A segment's contributed text: repeat-runs collapsed to one by default, unless
    # the operator confirmed the repetition is real (keep_repeats).
    t = seg.text.strip()
    return t if seg.keep_repeats else collapse_repeats(t)


def join_segments(segments: Sequence[CaptionSegment]) -> list[JoinedLine]:
    lines: list[JoinedLine] = []
    for seg in segments:
        text = _member_text(seg)
        if not text:
            continue
        line = lines[-1] if lines else None
        prev = line.members[-1] if line and line.members else None
        if line is not None and prev is not None and prev.join_next:
            line.text += join_separator(line.text, prev.join_next) + text
            line.members.append(seg)
            line.end = seg.end
            line.locked = line.locked or bool(seg.locked)
        else:
            lines.append(
                JoinedLine(
                    text=text,
                    start=seg.start,
                    end=seg.end,
                    locked=bool(seg.locked),
                    members=[seg],
                )
            )
    return lines
