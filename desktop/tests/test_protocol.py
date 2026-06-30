"""Cross-language contract checks: the pydantic mirror must (de)serialize the
same camelCase wire JSON that the TypeScript protocol produces.
"""

import json

from captions_desktop.protocol import (
    DEFAULT_DISPLAY_CONFIG,
    CaptionSegment,
    FinalMessage,
    SetModelMessage,
    Word,
    dump_message,
    parse_client_message,
    parse_server_message,
)


def test_set_model_message_parses_camelcase():
    msg = parse_client_message(
        json.dumps({"type": "setModel", "model": "small.en", "refineModel": "large-v3"})
    )
    assert isinstance(msg, SetModelMessage)
    assert msg.model == "small.en"
    assert msg.refine_model == "large-v3"  # camelCase refineModel -> snake_case


def test_set_model_message_refine_optional():
    msg = parse_client_message(json.dumps({"type": "setModel", "model": "tiny.en"}))
    assert isinstance(msg, SetModelMessage)
    assert msg.refine_model is None


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
    assert "qr" in json.loads(dump_message(msg))["config"]


def test_parse_client_history_request():
    msg = parse_client_message(json.dumps({"type": "requestHistory", "since": 30}))
    assert msg.since == 30
