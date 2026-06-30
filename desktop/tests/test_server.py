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
            # New clients are caught up with config then history.
            assert ws.receive_json()["type"] == "config"
            assert ws.receive_json()["type"] == "history"
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


def test_root_help_when_no_frontend():
    hub = CaptionHub()
    app = build_app(hub, MockProducer(hub), web_dir=None, autostart=False)
    with TestClient(app) as client:
        r = client.get("/")
        assert r.status_code == 200
        assert "Caption Guru server" in r.text
