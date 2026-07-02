"""Cross-language guard for the binary clip-frame codec.

The GOLDEN fixture below is the exact byte output of the canonical TS encoder
(`encodeClipFrame` in packages/pwa/src/engine/localWsBackend.ts). The matching
TS test (`localWsBackend.test.ts`) asserts the encoder produces these same bytes,
so the wire format is pinned from both ends: if either side drifts, one of the two
tests breaks.
"""

import numpy as np

from captions_desktop.clip_frame import (
    FLAG_FINAL,
    FMT_F32LE,
    FMT_I16LE,
    decode_clip_header,
    decode_clip_pcm,
    encode_clip_frame,
)

# encodeClipFrame(7, {final: true}, Float32Array([0, 1, -1])) — F32LE, samples 0/1/-1.
GOLDEN_F32 = bytes(
    [
        0x07, 0x00, 0x00, 0x00,  # reqId = 7 (u32 LE)
        0x01,                    # flags = final
        0x00,                    # format = Float32LE
        0x00, 0x00,              # reserved
        0x00, 0x00, 0x00, 0x00,  # 0.0f
        0x00, 0x00, 0x80, 0x3F,  # 1.0f
        0x00, 0x00, 0x80, 0xBF,  # -1.0f
    ]
)


def test_decode_golden_f32_frame_from_ts():
    header = decode_clip_header(GOLDEN_F32)
    assert header.req_id == 7
    assert header.final is True
    assert header.format == FMT_F32LE
    assert header.sample_count == 3
    samples = decode_clip_pcm(GOLDEN_F32)
    assert samples.dtype == np.float32
    np.testing.assert_allclose(samples, [0.0, 1.0, -1.0])


def test_encode_matches_golden_f32():
    frame = encode_clip_frame(7, np.array([0.0, 1.0, -1.0], dtype=np.float32), final=True)
    assert frame == GOLDEN_F32


def test_partial_flag_and_roundtrip_f32():
    frame = encode_clip_frame(42, np.array([0.25, -0.5], dtype=np.float32), final=False)
    header = decode_clip_header(frame)
    assert header.req_id == 42 and header.final is False and header.format == FMT_F32LE
    np.testing.assert_allclose(decode_clip_pcm(frame), [0.25, -0.5])


def test_int16_roundtrip_dequant_matches_ts():
    # Int16 encodes -1 -> -0x8000, +1 -> +0x7fff, then decode divides by 0x8000.
    src = np.array([0.0, 1.0, -1.0, 0.5], dtype=np.float32)
    frame = encode_clip_frame(3, src, final=True, fmt=FMT_I16LE)
    header = decode_clip_header(frame)
    assert header.format == FMT_I16LE and header.sample_count == 4
    out = decode_clip_pcm(frame)
    # +1.0 dequantizes to 0x7fff/0x8000 (just under 1.0); the rest are exact-ish.
    np.testing.assert_allclose(out, [0.0, 0x7FFF / 0x8000, -1.0, 0.5], atol=1e-4)


def test_short_frame_raises():
    import pytest

    with pytest.raises(ValueError):
        decode_clip_header(b"\x00\x01\x02")


# Guard the header layout constant so a drift is caught explicitly.
def test_flag_and_format_constants():
    assert FLAG_FINAL == 0x01 and FMT_F32LE == 0 and FMT_I16LE == 1
