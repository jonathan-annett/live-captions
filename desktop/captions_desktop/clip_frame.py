"""Binary clip-frame codec (browser → server audio side-channel).

The Python mirror of the canonical TypeScript codec in
``packages/pwa/src/engine/localWsBackend.ts`` (``encodeClipFrame`` /
``decodeClipHeader`` / ``decodeClipPcm``). The browser owns capture/VAD/framing
and ships each finished utterance clip as one binary WebSocket frame:

    little-endian, 8-byte header then the mono 16 kHz PCM
      u32 reqId       correlation token (echoed back in `asrResult`)
      u8  flags       bit0 = final (1) vs partial (0)
      u8  format      0 = Float32LE, 1 = Int16LE
      u16 reserved    0
      ... PCM samples

This is deliberately NOT part of the JSON/pydantic protocol (which stays text) —
it's the audio side-channel. Keep it in lockstep with the TS codec; the
cross-language golden test (``tests/test_clip_frame.py``) pins the exact bytes.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

CLIP_HEADER_BYTES = 8
FLAG_FINAL = 0x01
FMT_F32LE = 0
FMT_I16LE = 1

# u32 reqId, u8 flags, u8 format, u16 reserved — all little-endian.
_HEADER = struct.Struct("<IBBH")
_I16_FULLSCALE = 0x8000  # matches the TS dequant (divide by 0x8000)


@dataclass
class ClipHeader:
    req_id: int
    final: bool
    format: int
    sample_count: int


def decode_clip_header(buf: bytes) -> ClipHeader:
    """Parse the fixed 8-byte header. Raises ValueError on a short/garbled frame."""
    if len(buf) < CLIP_HEADER_BYTES:
        raise ValueError(f"clip frame too short: {len(buf)} bytes")
    req_id, flags, fmt, _reserved = _HEADER.unpack_from(buf, 0)
    bytes_per_sample = 2 if fmt == FMT_I16LE else 4
    payload = len(buf) - CLIP_HEADER_BYTES
    return ClipHeader(
        req_id=req_id,
        final=bool(flags & FLAG_FINAL),
        format=fmt,
        sample_count=payload // bytes_per_sample,
    )


def decode_clip_pcm(buf: bytes) -> np.ndarray:
    """Decode the PCM payload to a mono float32 numpy array (the ASR engine's
    input contract). Int16 is dequantized to [-1, 1) exactly as the TS side."""
    header = decode_clip_header(buf)
    payload = buf[CLIP_HEADER_BYTES:]
    if header.format == FMT_I16LE:
        i16 = np.frombuffer(payload, dtype="<i2")
        return (i16.astype(np.float32) / _I16_FULLSCALE).copy()
    # Float32LE — copy so the result owns writable memory (frombuffer is a view).
    return np.frombuffer(payload, dtype="<f4").astype(np.float32).copy()


def encode_clip_frame(
    req_id: int, samples: np.ndarray, *, final: bool, fmt: int = FMT_F32LE
) -> bytes:
    """Encode a clip frame (mainly for tests / symmetry with the TS encoder)."""
    flags = FLAG_FINAL if final else 0
    header = _HEADER.pack(req_id & 0xFFFFFFFF, flags, fmt, 0)
    arr = np.asarray(samples, dtype=np.float32)
    if fmt == FMT_I16LE:
        clipped = np.clip(arr, -1.0, 1.0)
        i16 = np.where(
            clipped < 0, np.round(clipped * _I16_FULLSCALE), np.round(clipped * 0x7FFF)
        ).astype("<i2")
        return header + i16.tobytes()
    return header + arr.astype("<f4").tobytes()
