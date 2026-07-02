import asyncio
import json

from fastapi.testclient import TestClient

from captions_desktop.hub import CaptionHub
from captions_desktop.protocol import CaptionSegment, FinalMessage
from captions_desktop.server import _handle_client, build_app
from captions_desktop.streaming import MockProducer


def test_edit_segment_message_upserts_via_hub():
    hub = CaptionHub()
    hub.submit = hub._dispatch  # dispatch synchronously (no event loop in tests)
    hub._dispatch(
        FinalMessage(segment=CaptionSegment(id="u1", text="cooper netties", start=0, end=1))
    )
    data = json.dumps(
        {
            "type": "editSegment",
            "segment": {"id": "u1", "text": "Kubernetes", "start": 0, "end": 1, "locked": True},
        }
    )
    _handle_client(hub, MockProducer(hub), data, asyncio.Queue())
    assert len(hub.history()) == 1  # upsert by id, not append
    assert hub.history()[-1].text == "Kubernetes"


def test_room_control_message_dispatches_to_manager():
    hub = CaptionHub()
    hub.submit = hub._dispatch

    class FakeManager:
        def __init__(self):
            self.calls = []

        async def handle(self, action, qr):
            self.calls.append((action, qr))

    mgr = FakeManager()

    async def drive():
        data = json.dumps({"type": "roomControl", "action": "start", "qr": {"x": 10}})
        _handle_client(hub, MockProducer(hub), data, asyncio.Queue(), mgr)
        # create_task schedules on the loop; yield so it runs.
        await asyncio.sleep(0)

    asyncio.run(drive())
    assert mgr.calls and mgr.calls[0][0] == "start"
    assert mgr.calls[0][1] is not None and mgr.calls[0][1].x == 10


def test_request_devices_replies_to_caller():
    hub = CaptionHub()
    hub.submit = hub._dispatch
    q = asyncio.Queue()
    # MockProducer.get_input_device() -> None; list_input_devices is best-effort ([]).
    _handle_client(hub, MockProducer(hub), json.dumps({"type": "requestDevices"}), q)
    reply = q.get_nowait()
    assert reply.type == "audioDevices"
    assert isinstance(reply.devices, list)
    assert reply.current is None


def test_set_input_device_switches_and_echoes_selection():
    hub = CaptionHub()
    hub.submit = hub._dispatch

    class FakeController(MockProducer):
        def set_device(self, device):
            self._device = device

        def get_input_device(self):
            return getattr(self, "_device", None)

    ctrl = FakeController(hub)
    q = asyncio.Queue()
    _handle_client(hub, ctrl, json.dumps({"type": "setInputDevice", "device": 3}), q)
    assert ctrl.get_input_device() == 3
    reply = q.get_nowait()
    assert reply.type == "audioDevices" and reply.current == 3


def test_snapshot_replays_current_status_after_emit():
    # A refreshed control panel must learn the true engine state (Start/Stop
    # buttons key off it) — the snapshot replays the last status.
    from captions_desktop.protocol import EngineStatus

    hub = CaptionHub()
    hub.submit = hub._dispatch  # no event loop in this test
    assert [m.type for m in hub.snapshot_for_new_client()] == ["config", "history"]
    hub.emit_status(EngineStatus(state="listening", model="small.en"))
    snap = hub.snapshot_for_new_client()
    assert [m.type for m in snap] == ["config", "status", "history"]
    status_msg = next(m for m in snap if m.type == "status")
    assert status_msg.status.state == "listening" and status_msg.status.model == "small.en"


def test_history_endpoint_empty_without_autostart():
    hub = CaptionHub()
    app = build_app(hub, MockProducer(hub), web_dir=None, autostart=False)
    with TestClient(app) as client:
        r = client.get("/history")
        assert r.status_code == 200
        assert r.json() == {"segments": []}


def test_ws_sends_catchup_then_streams_captions():
    hub = CaptionHub()
    app = build_app(hub, MockProducer(hub), web_dir=None)  # autostart mock
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            # New clients are caught up with config, an optional current-status
            # snapshot (if the engine has emitted one), then history.
            assert ws.receive_json()["type"] == "config"
            msg = ws.receive_json()
            if msg["type"] == "status":
                msg = ws.receive_json()
            assert msg["type"] == "history"
            # The mock producer should stream captions shortly after.
            seen = set()
            for _ in range(40):
                seen.add(ws.receive_json()["type"])
                if {"partial", "final"} & seen:
                    break
            assert {"partial", "final"} & seen


def test_ws_request_history_replies_to_caller():
    hub = CaptionHub()
    app = build_app(hub, MockProducer(hub), web_dir=None, autostart=False)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()  # config
            ws.receive_json()  # history (initial)
            ws.send_json({"type": "requestHistory"})
            assert ws.receive_json()["type"] == "history"


def test_export_endpoint_returns_attachment():
    hub = CaptionHub()
    app = build_app(hub, MockProducer(hub), web_dir=None, autostart=False)
    with TestClient(app) as client:
        r = client.get("/export?format=vtt")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/vtt")
        assert "attachment" in r.headers["content-disposition"]
        assert r.text.startswith("WEBVTT")


def test_ws_clip_decode_replies_asrresult_for_a_binary_frame():
    import numpy as np

    from captions_desktop.clip_decoder import ClipDecoder
    from captions_desktop.clip_frame import encode_clip_frame
    from captions_desktop.engines.base import TranscribeResult
    from captions_desktop.protocol import EngineStatus

    class FakeEngine:
        def load(self):
            return EngineStatus(state="listening", backend="fake")

        def transcribe(self, samples, hotwords=None, *, quality=False, prompt=None):
            return TranscribeResult(text="server hi")

    hub = CaptionHub()
    decoder = ClipDecoder(lambda _m: FakeEngine(), "small.en")
    app = build_app(hub, decoder, web_dir=None, autostart=True)  # starts the decoder
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            # Send a FINAL clip; the server decodes on its worker and replies with
            # an asrResult echoing the reqId (point-to-point on this socket).
            frame = encode_clip_frame(11, np.array([0.1, 0.2, 0.1], dtype=np.float32), final=True)
            ws.send_bytes(frame)
            got = None
            for _ in range(50):  # skip snapshot / asrModels / asrStatus chatter
                msg = ws.receive_json()
                if msg.get("type") == "asrResult":
                    got = msg
                    break
            assert got is not None
            assert got["reqId"] == 11 and got["text"] == "server hi"


def test_root_help_when_no_frontend():
    hub = CaptionHub()
    app = build_app(hub, MockProducer(hub), web_dir=None, autostart=False)
    with TestClient(app) as client:
        r = client.get("/")
        assert r.status_code == 200
        assert "Caption Guru server" in r.text
