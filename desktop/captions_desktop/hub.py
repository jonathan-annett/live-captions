"""Caption hub: the single source of truth the server fans out from.

Holds the current display config plus a rolling, append-only log of finalized
segments (default last 30 min). Every connected client (on-air display, operator,
and future audience-scrollback viewers) subscribes here. `submit()` is
thread-safe so the audio/ASR worker thread can publish onto the asyncio loop.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Optional

from .protocol import (
    CaptionSegment,
    ClearMessage,
    ConfigMessage,
    DEFAULT_DISPLAY_CONFIG,
    DisplayConfig,
    EngineStatus,
    FinalMessage,
    HistoryMessage,
    PartialMessage,
    ServerMessage,
    StatusMessage,
    can_replace_segment,
)

# Drop subscribers' oldest messages rather than grow unbounded if one stalls.
_QUEUE_MAX = 256


class CaptionHub:
    def __init__(self, window_seconds: float = 1800.0) -> None:
        self.window_seconds = window_seconds
        self.config: DisplayConfig = DEFAULT_DISPLAY_CONFIG.model_copy(deep=True)
        self._status: Optional[EngineStatus] = None
        self._finals: list[CaptionSegment] = []
        # Guards _finals so history() stays correct when finals are recorded from
        # the ASR worker thread while the event loop is momentarily blocked.
        self._finals_lock = threading.Lock()
        self._subscribers: set[asyncio.Queue[ServerMessage]] = set()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._start = time.monotonic()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._start = time.monotonic()

    def elapsed(self) -> float:
        return time.monotonic() - self._start

    # --- subscriptions ------------------------------------------------------

    def subscribe(self) -> "asyncio.Queue[ServerMessage]":
        q: asyncio.Queue[ServerMessage] = asyncio.Queue(maxsize=_QUEUE_MAX)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: "asyncio.Queue[ServerMessage]") -> None:
        self._subscribers.discard(q)

    # --- history ------------------------------------------------------------

    def history(self, since: Optional[float] = None) -> list[CaptionSegment]:
        with self._finals_lock:
            if since is None:
                return list(self._finals)
            return [s for s in self._finals if s.end >= since]

    # --- publishing ---------------------------------------------------------

    def submit(self, msg: ServerMessage) -> None:
        """Thread-safe entry point (callable from the ASR worker thread).

        The durable log (``_finals``) is updated **synchronously** here so
        ``history()`` is always current — even when the event loop is momentarily
        blocked (e.g. ``stop()`` joining the worker while it flushes a last final).
        Only the subscriber fan-out hops onto the loop (those are asyncio queues).
        """
        self._record(msg)
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(self._fanout, msg)

    def _record(self, msg: ServerMessage) -> None:
        # Apply a message to the durable rolling log (thread-safe). Upsert finals
        # by id so a refined / corrected re-emit replaces in place (lock-aware)
        # instead of duplicating.
        if isinstance(msg, FinalMessage):
            with self._finals_lock:
                self._upsert_final(msg.segment)
                self._prune()
        elif isinstance(msg, ClearMessage):
            with self._finals_lock:
                self._finals.clear()

    def _fanout(self, msg: ServerMessage) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()  # drop oldest
                    q.put_nowait(msg)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    def _dispatch(self, msg: ServerMessage) -> None:
        # Synchronous apply (record + fan-out). Used directly by tests without an
        # event loop; production goes through submit() (sync record + async fanout).
        self._record(msg)
        self._fanout(msg)

    def _upsert_final(self, seg: CaptionSegment) -> None:
        for i, existing in enumerate(self._finals):
            if existing.id == seg.id:
                if can_replace_segment(existing, seg):
                    self._finals[i] = seg
                return
        self._finals.append(seg)

    def _prune(self) -> None:
        cutoff = self.elapsed() - self.window_seconds
        if cutoff <= 0:
            return
        self._finals = [s for s in self._finals if s.end >= cutoff]

    # --- config / control ---------------------------------------------------

    def set_config(self, patch: dict) -> DisplayConfig:
        merged = self.config.model_dump(by_alias=True)
        merged.update(patch)
        self.config = DisplayConfig.model_validate(merged)
        self.submit(ConfigMessage(config=self.config))
        return self.config

    def clear(self) -> None:
        self.submit(ClearMessage())

    # Convenience constructors used by producers ----------------------------

    def emit_partial(self, segment: CaptionSegment) -> None:
        self.submit(PartialMessage(segment=segment))

    def emit_final(self, segment: CaptionSegment) -> None:
        self.submit(FinalMessage(segment=segment))

    def emit_status(self, status: EngineStatus) -> None:
        # Remember the latest status so a freshly-connected control panel learns
        # the true engine state (e.g. `listening`) on refresh — the panel's audio
        # is server-side, so a browser reload must re-sync state, not reset it.
        self._status = status
        self.submit(StatusMessage(status=status))

    def snapshot_for_new_client(self) -> list[ServerMessage]:
        """Messages a freshly connected client should receive to catch up."""
        snapshot: list[ServerMessage] = [ConfigMessage(config=self.config)]
        if self._status is not None:
            snapshot.append(StatusMessage(status=self._status))
        with self._finals_lock:
            snapshot.append(HistoryMessage(segments=list(self._finals)))
        return snapshot
