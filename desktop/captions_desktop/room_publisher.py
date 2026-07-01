"""Forward the local caption stream to a CaptionRoom (v2 audience layer).

The desktop hub is the source of truth; this opens one outbound WebSocket to a
room's token-gated ``/r/:id/publish`` endpoint and relays every ``ServerMessage``
the hub emits, so audience phones can subscribe at the edge. It's just another
hub subscriber (like the on-air display), but pointed at the cloud room.

Reconnects with capped backoff; on each (re)connect it seeds the room with the
current config + history so a freshly-created room catches up.
"""

from __future__ import annotations

import asyncio
from typing import Optional

import websockets

from .rooms import USER_AGENT

from .hub import CaptionHub
from .protocol import dump_message


class RoomPublisher:
    def __init__(self, hub: CaptionHub, publish_url: str) -> None:
        self._hub = hub
        self._url = publish_url
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

    def start(self) -> None:
        """Launch the relay task on the running loop (idempotent)."""
        if self._task is None:
            self._stop.clear()
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        backoff = 0.5
        while not self._stop.is_set():
            try:
                # A real User-Agent — Cloudflare's edge 403s the default
                # `websockets/x.y` UA on the publish handshake (same as /r/new).
                async with websockets.connect(self._url, user_agent_header=USER_AGENT) as ws:
                    backoff = 0.5
                    await self._pump(ws)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Connection refused / dropped / room not ready — retry.
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 5.0)

    async def _pump(self, ws) -> None:
        q = self._hub.subscribe()
        drain = asyncio.create_task(self._drain(ws))
        try:
            # Seed the room with current state so it (and late joiners) catch up.
            for m in self._hub.snapshot_for_new_client():
                await ws.send(dump_message(m))
            while not self._stop.is_set():
                msg = await q.get()
                await ws.send(dump_message(msg))
        finally:
            drain.cancel()
            self._hub.unsubscribe(q)

    @staticmethod
    async def _drain(ws) -> None:
        # The room pushes messages to publishers too (e.g. `presence` device
        # counts). We don't use them, but must read inbound so they can't buffer
        # and stall the outbound relay.
        try:
            async for _ in ws:
                pass
        except Exception:  # noqa: BLE001 - connection closing; the send loop handles it
            pass
