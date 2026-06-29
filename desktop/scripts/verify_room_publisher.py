"""End-to-end check for the desktop RoomPublisher against a running room Worker.

Start the isolated room Worker first:
    pnpm --filter @captions/room dev          # http://127.0.0.1:8787

Then, from desktop/ with the venv:
    .venv/bin/python scripts/verify_room_publisher.py

It creates a room, relays a CaptionHub through RoomPublisher, and asserts a raw
subscriber receives the seeded config, the live final, and an upsert correction.
Override the target with ROOM_URL.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx
import websockets

from captions_desktop.hub import CaptionHub
from captions_desktop.protocol import CaptionSegment
from captions_desktop.room_publisher import RoomPublisher

BASE = os.environ.get("ROOM_URL", "http://127.0.0.1:8787")

failures = 0


def check(cond: bool, msg: str) -> None:
    global failures
    print(f"{'  ok  ' if cond else ' FAIL '} {msg}")
    if not cond:
        failures += 1


async def wait_for(ws, pred, timeout: float = 4.0) -> dict:
    async def _loop():
        while True:
            msg = json.loads(await ws.recv())
            if pred(msg):
                return msg

    return await asyncio.wait_for(_loop(), timeout)


async def main() -> int:
    async with httpx.AsyncClient() as client:
        res = await client.post(f"{BASE}/r/new")
        res.raise_for_status()
        room = res.json()
    check(bool(room.get("id")), f"created room {room.get('id')}")

    hub = CaptionHub()
    hub.bind_loop(asyncio.get_running_loop())

    publisher = RoomPublisher(hub, room["publishUrl"])
    publisher.start()
    await asyncio.sleep(0.5)  # let the publisher connect + seed

    async with websockets.connect(room["subscribeUrl"]) as sub:
        # Publisher seeds config on connect.
        cfg = await wait_for(sub, lambda m: m["type"] == "config")
        check(cfg["config"].get("fontFamily") is not None, "subscriber got seeded config")

        # Live final flows hub -> publisher -> room -> subscriber.
        hub.emit_final(CaptionSegment(id="d1", text="from the desktop", start=0.0, end=1.0))
        got = await wait_for(sub, lambda m: m["type"] == "final" and m["segment"]["id"] == "d1")
        check(got["segment"]["text"] == "from the desktop", "subscriber received the live final")

        # Upsert-by-id: re-emit the same id corrected.
        hub.emit_final(CaptionSegment(id="d1", text="from the desktop!", start=0.0, end=1.0))
        upd = await wait_for(
            sub, lambda m: m["type"] == "final" and m["segment"]["text"] == "from the desktop!"
        )
        check(upd["segment"]["id"] == "d1", "subscriber received the correction")

    await publisher.stop()
    print("\nALL PASSED" if failures == 0 else f"\n{failures} CHECK(S) FAILED")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
