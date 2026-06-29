"""Cross-language contract checks: the pydantic mirror must (de)serialize the
same camelCase wire JSON that the TypeScript protocol produces.
"""

import json

from captions_desktop.protocol import (
    DEFAULT_DISPLAY_CONFIG,
    CaptionSegment,
    FinalMessage,
    Word,
    dump_message,
    parse_client_message,
    parse_server_message,
)


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


def test_parse_client_history_request():
    msg = parse_client_message(json.dumps({"type": "requestHistory", "since": 30}))
    assert msg.since == 30
