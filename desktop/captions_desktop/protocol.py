"""Python mirror of ``packages/protocol`` (the shared caption protocol).

Field names are snake_case in Python but (de)serialize to the camelCase JSON the
TypeScript side uses, via a camelCase alias generator. Keep this file in lockstep
with ``packages/protocol/src/index.ts``.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic.alias_generators import to_camel

# Bumped on breaking changes to the message shapes below.
# v2: CaptionSegment gains `locked` (operator corrections) + populated `words`.
# v3: CaptionSegment gains `joinNext` (operator line-merge control).
# v4: CaptionSegment gains `keepRepeats` (opt out of auto repeat-collapse).
# v5: `setModel` client message (desktop live/refine model hot-swap).
# v6: `editSegment` client message (operator correction over the control WS).
PROTOCOL_VERSION = 6


class _Model(BaseModel):
    """Base: serialize to camelCase JSON, accept either casing on input."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


# ---------------------------------------------------------------------------
# Segments
# ---------------------------------------------------------------------------


class Word(_Model):
    text: str
    start: float  # seconds from session start
    end: float
    confidence: Optional[float] = None


class CaptionSegment(_Model):
    id: str  # stable; a partial keeps its id until finalized
    text: str
    start: float
    end: float
    speaker: Optional[str] = None
    lang: Optional[str] = None
    words: Optional[list[Word]] = None
    # Operator-corrected canonical text; not overwritten by the engine or the
    # background refinement pass (a locked update wins).
    locked: Optional[bool] = None
    # Operator line-merge: how the next segment joins this one. None = line break;
    # "plain" = merge w/o added punctuation; "comma"/"period" = merge inserting it.
    join_next: Optional[Literal["plain", "comma", "period"]] = None
    # Opt out of automatic repeat-collapse (operator confirmed the repetition is
    # real); render every instance instead of collapsing to one.
    keep_repeats: Optional[bool] = None


def can_replace_segment(
    existing: Optional[CaptionSegment], incoming: CaptionSegment
) -> bool:
    """Lock-aware upsert rule (mirror of TS ``canReplaceSegment``). An operator-
    locked segment is the canonical text: a non-locked update (the background
    refinement pass, an engine re-emit) must NOT overwrite it; a locked update
    always wins."""
    return not (existing is not None and existing.locked and not incoming.locked)


# ---------------------------------------------------------------------------
# Display configuration
# ---------------------------------------------------------------------------


class TransparentBackground(_Model):
    kind: Literal["transparent"] = "transparent"


class SolidBackground(_Model):
    kind: Literal["solid"] = "solid"
    color: str


class ChromaBackground(_Model):
    kind: Literal["chroma"] = "chroma"
    color: str


Background = Annotated[
    Union[TransparentBackground, SolidBackground, ChromaBackground],
    Field(discriminator="kind"),
]


class CaptionRegion(_Model):
    """Operator-placed caption box as a percentage of the output frame (0..100)."""

    x: float
    y: float
    width: float
    height: float


class QrOverlay(_Model):
    """Live-room QR overlay; the display shows it only in chroma-key mode."""

    url: str
    x: float
    y: float
    size: float  # square edge as % of the smaller frame dimension


class DisplayConfig(_Model):
    font_family: str
    font_size: float  # viewport-height units (vh)
    font_weight: int  # CSS font-weight (100–900)
    orientation: Literal["horizontal", "vertical"]  # vertical uses CSS writing-mode
    color: str
    background: Background
    position: Literal["top", "center", "bottom"]
    text_align: Literal["left", "center", "right"]
    max_lines: int
    mode: Literal["rolling", "scroll"]
    show_partial: bool
    uppercase: bool
    # Opaque caption-box fill behind the text; None/transparent = see-through.
    box_color: Optional[str] = None
    # Caption-box corner radius in vh (rounded corners); None/0 = square.
    box_radius: Optional[float] = None
    # Operator-placed caption box (% of frame); None = full-frame + position.
    region: Optional[CaptionRegion] = None
    # Live-room QR overlay; the display shows it only in chroma-key mode.
    qr: Optional[QrOverlay] = None


DEFAULT_DISPLAY_CONFIG = DisplayConfig(
    font_family="'Inter', 'Helvetica Neue', Arial, system-ui, sans-serif",
    font_size=6,
    font_weight=700,
    orientation="horizontal",
    color="#ffffff",
    background=SolidBackground(color="#000000"),
    position="bottom",
    text_align="center",
    max_lines=2,
    mode="rolling",
    show_partial=True,
    uppercase=False,
)


# ---------------------------------------------------------------------------
# Engine status
# ---------------------------------------------------------------------------


class EngineStatus(_Model):
    state: Literal["idle", "loading", "listening", "error"]
    backend: Optional[str] = None
    model: Optional[str] = None
    device: Optional[str] = None
    message: Optional[str] = None


# ---------------------------------------------------------------------------
# Server -> client messages
# ---------------------------------------------------------------------------


class PartialMessage(_Model):
    type: Literal["partial"] = "partial"
    segment: CaptionSegment


class FinalMessage(_Model):
    type: Literal["final"] = "final"
    segment: CaptionSegment


class ClearMessage(_Model):
    type: Literal["clear"] = "clear"


class ConfigMessage(_Model):
    type: Literal["config"] = "config"
    config: DisplayConfig


class StatusMessage(_Model):
    type: Literal["status"] = "status"
    status: EngineStatus


class HistoryMessage(_Model):
    """Replay of finalized segments — for late joiners and audience scrollback."""

    type: Literal["history"] = "history"
    segments: list[CaptionSegment]


ServerMessage = Annotated[
    Union[
        PartialMessage,
        FinalMessage,
        ClearMessage,
        ConfigMessage,
        StatusMessage,
        HistoryMessage,
    ],
    Field(discriminator="type"),
]

ServerMessageAdapter: TypeAdapter[ServerMessage] = TypeAdapter(ServerMessage)


# ---------------------------------------------------------------------------
# Client -> server (control) messages
# ---------------------------------------------------------------------------


class SetConfigMessage(_Model):
    type: Literal["setConfig"] = "setConfig"
    # partial config patch
    config: dict


class SetDictionaryMessage(_Model):
    type: Literal["setDictionary"] = "setDictionary"
    terms: list[str]


class ControlCommand(_Model):
    type: Literal["command"] = "command"
    command: Literal["start", "stop", "clear"]


class RequestHistoryMessage(_Model):
    type: Literal["requestHistory"] = "requestHistory"
    since: Optional[float] = None


class SetModelMessage(_Model):
    type: Literal["setModel"] = "setModel"
    # live model name or HF repo (e.g. "small.en", "large-v3-turbo")
    model: str
    # refinement-pass model; None leaves it unchanged
    refine_model: Optional[str] = None


class EditSegmentMessage(_Model):
    # Operator correction from a control client: the corrected (locked) segment,
    # applied to the canonical log by id (lock-aware upsert) and rebroadcast.
    type: Literal["editSegment"] = "editSegment"
    segment: CaptionSegment


ClientMessage = Annotated[
    Union[
        SetConfigMessage,
        SetDictionaryMessage,
        ControlCommand,
        RequestHistoryMessage,
        SetModelMessage,
        EditSegmentMessage,
    ],
    Field(discriminator="type"),
]

ClientMessageAdapter: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def dump_message(msg: _Model) -> str:
    """Serialize any protocol model to wire JSON (camelCase keys)."""
    return msg.model_dump_json(by_alias=True, exclude_none=True)


def parse_server_message(data: str | bytes | dict) -> ServerMessage:
    if isinstance(data, dict):
        return ServerMessageAdapter.validate_python(data)
    return ServerMessageAdapter.validate_json(data)


def parse_client_message(data: str | bytes | dict) -> ClientMessage:
    if isinstance(data, dict):
        return ClientMessageAdapter.validate_python(data)
    return ClientMessageAdapter.validate_json(data)
