"""Cross-language contract checks: the pydantic mirror must (de)serialize the
same camelCase wire JSON that the TypeScript protocol produces.
"""

import json

import pytest
from pydantic import ValidationError

from captions_desktop.protocol import (
    DEFAULT_DISPLAY_CONFIG,
    CaptionSegment,
    DisplayConfig,
    EditSegmentMessage,
    FinalMessage,
    PresenceMessage,
    SetModelMessage,
    Word,
    dump_message,
    parse_client_message,
    parse_server_message,
)


@pytest.mark.parametrize(
    "bad",
    [
        {"fontWeight": 5000},  # > 900
        {"fontWeight": 50},  # < 100
        {"fontSize": 0},  # not positive
        {"maxLines": 0},  # not positive
        {"region": {"x": 0, "y": 0, "width": 200, "height": 10}},  # > 100
    ],
)
def test_display_config_rejects_out_of_range(bad):
    # Numeric bounds mirror the Zod constraints so PWA and desktop reject the same
    # patches (see packages/protocol/src/index.ts DisplayConfigSchema).
    merged = {**DEFAULT_DISPLAY_CONFIG.model_dump(by_alias=True), **bad}
    with pytest.raises(ValidationError):
        DisplayConfig.model_validate(merged)


def test_display_config_accepts_in_range():
    merged = {**DEFAULT_DISPLAY_CONFIG.model_dump(by_alias=True), "fontWeight": 900}
    assert DisplayConfig.model_validate(merged).font_weight == 900


def test_set_model_message_parses_camelcase():
    msg = parse_client_message(
        json.dumps({"type": "setModel", "model": "small.en", "refineModel": "large-v3"})
    )
    assert isinstance(msg, SetModelMessage)
    assert msg.model == "small.en"
    assert msg.refine_model == "large-v3"  # camelCase refineModel -> snake_case


def test_presence_message_round_trips():
    # DO -> client presence; the desktop publisher must be able to parse it (it's
    # in the ServerMessage union) even though it just drains/ignores it.
    msg = parse_server_message(json.dumps({"type": "presence", "count": 3}))
    assert isinstance(msg, PresenceMessage)
    assert msg.count == 3
    assert json.loads(dump_message(PresenceMessage(count=0))) == {
        "type": "presence",
        "count": 0,
    }


def test_set_model_message_refine_optional():
    msg = parse_client_message(json.dumps({"type": "setModel", "model": "tiny.en"}))
    assert isinstance(msg, SetModelMessage)
    assert msg.refine_model is None


def test_edit_segment_message_parses():
    msg = parse_client_message(
        json.dumps(
            {
                "type": "editSegment",
                "segment": {
                    "id": "a",
                    "text": "Kubernetes",
                    "start": 0,
                    "end": 1,
                    "locked": True,
                },
            }
        )
    )
    assert isinstance(msg, EditSegmentMessage)
    assert msg.segment.text == "Kubernetes"
    assert msg.segment.locked is True


def test_final_message_round_trips_camelcase():
    msg = FinalMessage(
        segment=CaptionSegment(
            id="seg-1",
            text="hello world",
            start=0.5,
            end=1.8,
            words=[Word(text="hello", start=0.5, end=1.0)],
        )
    )
    wire = dump_message(msg)
    data = json.loads(wire)
    assert data["type"] == "final"
    assert data["segment"]["id"] == "seg-1"
    # camelCase + no None leakage
    assert "speaker" not in data["segment"]

    back = parse_server_message(wire)
    assert back.segment.text == "hello world"


def test_default_display_config_uses_camelcase_keys():
    data = json.loads(DEFAULT_DISPLAY_CONFIG.model_dump_json(by_alias=True))
    assert "fontFamily" in data
    assert "showPartial" in data
    assert data["background"]["kind"] == "solid"


def test_parse_config_message_from_ts_shape():
    # Shape as emitted by the TS side.
    wire = json.dumps(
        {
            "type": "config",
            "config": {
                "fontFamily": "Inter",
                "fontSize": 6,
                "fontWeight": 700,
                "orientation": "horizontal",
                "color": "#fff",
                "background": {"kind": "chroma", "color": "#00ff00"},
                "position": "bottom",
                "textAlign": "center",
                "maxLines": 2,
                "mode": "rolling",
                "showPartial": True,
                "uppercase": False,
            },
        }
    )
    msg = parse_server_message(wire)
    assert msg.config.background.kind == "chroma"


def test_caption_region_round_trips_camelcase():
    wire = json.dumps(
        {
            "type": "config",
            "config": {
                "fontFamily": "Inter",
                "fontSize": 6,
                "fontWeight": 700,
                "orientation": "horizontal",
                "color": "#fff",
                "background": {"kind": "chroma", "color": "#00ff00"},
                "position": "bottom",
                "textAlign": "center",
                "maxLines": 2,
                "mode": "rolling",
                "showPartial": True,
                "uppercase": False,
                "region": {"x": 5, "y": 70, "width": 90, "height": 25},
            },
        }
    )
    msg = parse_server_message(wire)
    assert msg.config.region is not None
    assert msg.config.region.height == 25
    # Round-trips back to camelCase, and omitted when None.
    assert "region" in json.loads(dump_message(msg))["config"]
    assert "region" not in json.loads(DEFAULT_DISPLAY_CONFIG.model_dump_json(by_alias=True, exclude_none=True))


def test_qr_overlay_round_trips_camelcase():
    wire = json.dumps(
        {
            "type": "config",
            "config": {
                "fontFamily": "Inter",
                "fontSize": 6,
                "fontWeight": 700,
                "orientation": "horizontal",
                "color": "#fff",
                "background": {"kind": "chroma", "color": "#00ff00"},
                "position": "bottom",
                "textAlign": "center",
                "maxLines": 2,
                "mode": "rolling",
                "showPartial": True,
                "uppercase": False,
                "qr": {"url": "https://v2.caption.guru/r/abc/subscribe", "x": 70, "y": 5, "size": 25},
            },
        }
    )
    msg = parse_server_message(wire)
    assert msg.config.qr is not None
    assert msg.config.qr.url.endswith("/r/abc/subscribe")
    # v8: standalone fields default when omitted (legacy configs stay valid)
    assert msg.config.qr.enabled is True
    assert msg.config.qr.label == "Scan for live captions"
    assert msg.config.qr.exclusive is False
    assert "qr" in json.loads(dump_message(msg))["config"]


def test_qr_overlay_standalone_fields_round_trip():
    wire = json.dumps(
        {
            "type": "config",
            "config": {
                "fontFamily": "Inter",
                "fontSize": 6,
                "fontWeight": 700,
                "orientation": "horizontal",
                "color": "#fff",
                "background": {"kind": "solid", "color": "#000"},
                "position": "bottom",
                "textAlign": "center",
                "maxLines": 2,
                "mode": "rolling",
                "showPartial": True,
                "uppercase": False,
                "qr": {
                    "url": "https://v2.caption.guru/r/abc/subscribe",
                    "x": 70,
                    "y": 5,
                    "size": 25,
                    "enabled": False,
                    "label": "Scan now",
                    "exclusive": True,
                },
            },
        }
    )
    msg = parse_server_message(wire)
    assert msg.config.qr.enabled is False
    assert msg.config.qr.label == "Scan now"
    assert msg.config.qr.exclusive is True
    out = json.loads(dump_message(msg))["config"]["qr"]
    assert out["enabled"] is False and out["label"] == "Scan now" and out["exclusive"] is True


def test_parse_room_control_message():
    msg = parse_client_message(
        json.dumps(
            {
                "type": "roomControl",
                "action": "start",
                "qr": {"x": 60, "size": 30, "label": "Join", "exclusive": True},
            }
        )
    )
    assert msg.action == "start"
    assert msg.qr is not None and msg.qr.label == "Join" and msg.qr.exclusive is True


def test_parse_room_control_stop_bare():
    msg = parse_client_message(json.dumps({"type": "roomControl", "action": "stop"}))
    assert msg.action == "stop"
    assert msg.qr is None


def test_parse_request_devices_and_set_input_device():
    a = parse_client_message(json.dumps({"type": "requestDevices"}))
    assert a.type == "requestDevices"
    b = parse_client_message(json.dumps({"type": "setInputDevice", "device": 4}))
    assert b.device == 4
    c = parse_client_message(json.dumps({"type": "setInputDevice", "device": None}))
    assert c.device is None  # system default


def test_audio_devices_message_round_trips():
    from captions_desktop.protocol import AudioDevice, AudioDevicesMessage

    msg = AudioDevicesMessage(
        devices=[AudioDevice(index=2, name="BlackHole 2ch", channels=2)], current=2
    )
    out = json.loads(dump_message(msg))
    assert out["type"] == "audioDevices"
    assert out["devices"][0]["name"] == "BlackHole 2ch"
    assert out["current"] == 2
    # round-trip back through the server-message parser
    back = parse_server_message(dump_message(msg))
    assert back.devices[0].channels == 2 and back.current == 2


def test_parse_client_history_request():
    msg = parse_client_message(json.dumps({"type": "requestHistory", "since": 30}))
    assert msg.since == 30
