"""Audience-room minting + runtime lifecycle (v2 audience layer, Phase 5).

``create_room`` / ``join_url`` were originally private to ``cli.py`` (used once
at ``--start-room``). They're shared here so the server can mint rooms at
*runtime* from the operator panel's ``roomControl`` message, not just at launch.

``RoomManager`` holds the mutable room state — the current ``RoomPublisher`` (or
None), the current room's join info, and the last-stopped room (for ``restart``)
— and drives start / stop / restart on the running event loop.
"""

from __future__ import annotations

import asyncio
import json
import sys
import urllib.request
from typing import Optional

from .hub import CaptionHub
from .protocol import QrOverlay, QrOverlayOverrides

# Default join-QR placement (top-right band) when the operator doesn't override
# it — matches the original hardcoded --start-room overlay.
DEFAULT_QR_POS = {"x": 72.0, "y": 6.0, "size": 24.0}


class RoomError(RuntimeError):
    """A room could not be minted (network / bad base URL)."""


def create_room(base: str) -> dict:
    """POST ``<base>/r/new`` to mint an audience room; returns its URLs (id,
    publishUrl, …). Raises :class:`RoomError` on failure."""
    url = base.rstrip("/") + "/r/new"
    req = urllib.request.Request(url, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:  # noqa: BLE001 - surface a clean error to the caller
        raise RoomError(f"could not create a room at {url}: {exc}") from exc


def join_url(viewer_base: str, room_base: str, room_id: str) -> str:
    """Short audience join URL the QR encodes (the /room page, not the ws socket)."""
    vb = viewer_base.rstrip("/")
    if room_base.rstrip("/") == vb:
        return f"{vb}/room?{room_id}"  # → /room?<id>
    # Room WebSocket on a different host than the viewer page: be explicit.
    from urllib.parse import quote

    return f"{vb}/room?room={room_id}&base=" + quote(room_base.rstrip("/"), safe="")


def build_qr_config(join: str, overrides: Optional[QrOverlayOverrides]) -> dict:
    """Merge the minted join URL with optional operator overrides into a full,
    validated QrOverlay dict (camelCase) suitable for ``hub.set_config({"qr": …})``.

    Pure + side-effect-free so the merge logic is unit-testable without network.
    """
    data: dict = dict(DEFAULT_QR_POS)
    data["url"] = join
    if overrides is not None:
        data.update(overrides.model_dump(exclude_none=True))
    # Validate through QrOverlay to fill enabled/label/exclusive defaults + bounds.
    return QrOverlay(**data).model_dump(by_alias=True)


class RoomManager:
    """Owns the runtime audience-room state for one server instance."""

    def __init__(
        self,
        hub: CaptionHub,
        *,
        room_base: Optional[str] = None,
        viewer_base: Optional[str] = None,
        qr_png_path: Optional[str] = None,
    ) -> None:
        self._hub = hub
        self.room_base = room_base
        self.viewer_base = viewer_base or room_base
        self.qr_png_path = qr_png_path
        self._publisher = None  # RoomPublisher | None
        self._current: Optional[dict] = None  # {publishUrl, joinUrl, roomId?}
        self._last: Optional[dict] = None  # last stopped room, for restart

    # -- launch-time adoption -------------------------------------------------

    def adopt(self, publisher, publish_url: str, join: Optional[str]) -> None:
        """Register a publisher created at startup (``--start-room``/``--publish-url``)
        as the current room so runtime stop/restart can manage it."""
        self._publisher = publisher
        self._current = {"publishUrl": publish_url, "joinUrl": join}

    # -- roomControl dispatch -------------------------------------------------

    async def handle(self, action: str, overrides: Optional[QrOverlayOverrides]) -> None:
        if action == "start":
            await self.start(overrides)
        elif action == "stop":
            await self.stop()
        elif action == "restart":
            await self.restart(overrides)

    async def start(self, overrides: Optional[QrOverlayOverrides]) -> None:
        if not self.room_base:
            print(
                "roomControl(start): no room base configured "
                "(pass --start-room or --viewer-base); ignoring.",
                file=sys.stderr,
            )
            return
        try:
            room = await asyncio.to_thread(create_room, self.room_base)
        except RoomError as exc:
            print(f"roomControl(start): {exc}", file=sys.stderr)
            return
        join = join_url(self.viewer_base or self.room_base, self.room_base, room["id"])
        await self._swap_publisher(room["publishUrl"])
        self._current = {"publishUrl": room["publishUrl"], "joinUrl": join, "roomId": room["id"]}
        self._last = None
        self._apply_qr(join, overrides)
        await self._write_png(join)

    async def stop(self) -> None:
        await self._stop_publisher()
        if self._current is not None:
            self._last = self._current
            self._current = None
        # Drop the overlay entirely (qr → None) rather than just hiding it.
        self._hub.set_config({"qr": None})

    async def restart(self, overrides: Optional[QrOverlayOverrides]) -> None:
        target = self._last or self._current
        if target is None or not target.get("joinUrl"):
            # Nothing to reopen — behave like a fresh start.
            await self.start(overrides)
            return
        await self._swap_publisher(target["publishUrl"])
        self._current = target
        self._last = None
        self._apply_qr(target["joinUrl"], overrides)
        await self._write_png(target["joinUrl"])

    # -- internals ------------------------------------------------------------

    async def _swap_publisher(self, publish_url: str) -> None:
        await self._stop_publisher()
        from .room_publisher import RoomPublisher

        self._publisher = RoomPublisher(self._hub, publish_url)
        self._publisher.start()

    async def _stop_publisher(self) -> None:
        if self._publisher is not None:
            await self._publisher.stop()
            self._publisher = None

    def _apply_qr(self, join: str, overrides: Optional[QrOverlayOverrides]) -> None:
        self._hub.set_config({"qr": build_qr_config(join, overrides)})

    async def _write_png(self, join: str) -> None:
        if not self.qr_png_path:
            return
        from .qr_png import write_qr_slide_png

        try:
            await asyncio.to_thread(write_qr_slide_png, join, self.qr_png_path)
        except Exception as exc:  # noqa: BLE001 - a bad path shouldn't kill the room
            print(f"roomControl: could not write QR PNG: {exc}", file=sys.stderr)
