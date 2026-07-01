import asyncio

from captions_desktop.hub import CaptionHub
from captions_desktop.protocol import QrOverlayOverrides
from captions_desktop.qr_png import write_qr_slide_png
from captions_desktop.rooms import RoomManager, build_qr_config


def test_build_qr_config_fills_defaults():
    cfg = build_qr_config("https://v2.caption.guru/room?abc", None)
    assert cfg["url"] == "https://v2.caption.guru/room?abc"
    # Default placement + v8 fields (enabled/label/exclusive).
    assert cfg["x"] == 72.0 and cfg["y"] == 6.0 and cfg["size"] == 24.0
    assert cfg["enabled"] is True
    assert cfg["label"] == "Scan for live captions"
    assert cfg["exclusive"] is False


def test_build_qr_config_applies_overrides():
    over = QrOverlayOverrides(x=10, size=30, label="Join now", exclusive=True)
    cfg = build_qr_config("https://x/room?z", over)
    assert cfg["x"] == 10.0
    assert cfg["size"] == 30.0
    assert cfg["y"] == 6.0  # untouched → default
    assert cfg["label"] == "Join now"
    assert cfg["exclusive"] is True
    assert cfg["enabled"] is True  # not overridden → default


def test_write_qr_slide_png(tmp_path):
    out = tmp_path / "slide.png"
    write_qr_slide_png("https://v2.caption.guru/room?abc", str(out))
    assert out.is_file()
    # PNG magic number.
    assert out.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_room_manager_stop_clears_qr_overlay():
    hub = CaptionHub()  # no event loop bound: set_config still updates config state
    hub.set_config({"qr": build_qr_config("https://x/room?z", None)})
    assert hub.config.qr is not None
    manager = RoomManager(hub, room_base="https://x")
    asyncio.run(manager.stop())
    assert hub.config.qr is None  # overlay dropped, not just hidden


def test_room_manager_start_without_base_is_noop():
    hub = CaptionHub()
    manager = RoomManager(hub)  # no base → cannot mint
    asyncio.run(manager.start(None))
    assert hub.config.qr is None  # nothing minted, no overlay set
