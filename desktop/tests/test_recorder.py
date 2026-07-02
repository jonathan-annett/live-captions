"""Post-production P1 (hi-fi capture) — recorder + session-bundle tests.

These exercise the recorder + the LiveStreamer session lifecycle WITHOUT opening a
real mic (no sounddevice InputStream): the session helpers are driven directly.
Skips cleanly if the recording deps aren't installed.
"""

import json

import numpy as np
import pytest

sf = pytest.importorskip("soundfile")
soxr = pytest.importorskip("soxr")

from captions_desktop.hub import CaptionHub  # noqa: E402
from captions_desktop.protocol import CaptionSegment  # noqa: E402
from captions_desktop.recorder import SessionRecorder  # noqa: E402
from captions_desktop.streaming import LiveStreamer  # noqa: E402


def _streamer(record_dir):
    # The engine is never touched by the session helpers, so a placeholder is fine.
    return LiveStreamer(CaptionHub(), engine=None, sample_rate=16000, record_dir=str(record_dir))


# --- SessionRecorder --------------------------------------------------------

def test_recorder_writes_native_flac(tmp_path):
    rec = SessionRecorder(tmp_path, 48000)
    rec.start()
    block = np.zeros(1024, dtype=np.float32)
    for _ in range(10):
        rec.submit(block)
    rec.stop()

    f = tmp_path / "audio.flac"
    assert f.exists()
    data, sr = sf.read(str(f))
    assert sr == 48000
    assert len(data) == 10 * 1024
    assert rec.frames_written == 10 * 1024
    assert rec.dropped == 0
    assert rec.parts == [{"file": "audio.flac", "captureRate": 48000}]


def test_recorder_roll_opens_new_part_at_new_rate(tmp_path):
    rec = SessionRecorder(tmp_path, 48000)
    rec.start()
    rec.submit(np.zeros(480, dtype=np.float32))
    rec.roll(44100)  # e.g. a device swap changed the native rate
    rec.submit(np.zeros(441, dtype=np.float32))
    rec.stop()

    assert (tmp_path / "audio.flac").exists()
    assert (tmp_path / "audio.001.flac").exists()
    assert rec.parts == [
        {"file": "audio.flac", "captureRate": 48000},
        {"file": "audio.001.flac", "captureRate": 44100},
    ]
    _, sr0 = sf.read(str(tmp_path / "audio.flac"))
    _, sr1 = sf.read(str(tmp_path / "audio.001.flac"))
    assert (sr0, sr1) == (48000, 44100)


# --- native → 16 kHz downsample tee ----------------------------------------

def test_downsample_native_to_16k_length_and_dtype():
    native = np.sin(2 * np.pi * 440 * np.arange(48000) / 48000).astype(np.float32)
    asr = soxr.resample(native, 48000, 16000).astype(np.float32)
    assert asr.dtype == np.float32
    assert abs(len(asr) - 16000) <= 2  # 1s @ 48k → ~1s @ 16k


# --- session lifecycle on LiveStreamer -------------------------------------

def test_session_begin_mints_a_bundle(tmp_path):
    s = _streamer(tmp_path)
    s._begin_or_resume_session()  # native-rate probe returns None headless → 16k
    try:
        assert s._recorder is not None
        assert s._session_dir is not None
        assert s._session_dir.parent == tmp_path
        assert (s._session_dir / "audio.flac").exists()
    finally:
        s._recorder.stop()


def test_operator_stop_writes_segments_and_manifest(tmp_path):
    s = _streamer(tmp_path)
    s.hub.submit = s.hub._dispatch  # synchronous dispatch (no event loop in tests)
    s._begin_or_resume_session()
    s.hub.emit_final(CaptionSegment(id="a", text="hello world", start=0.0, end=1.0))
    bundle = s._session_dir

    s._end_session()

    segs = json.loads((bundle / "segments.json").read_text())["segments"]
    assert segs[0]["text"] == "hello world"
    meta = json.loads((bundle / "session.json").read_text())
    assert meta["asrRate"] == 16000
    assert meta["parts"][0]["file"] == "audio.flac"
    assert "clockNote" in meta and "startedAt" in meta and "stoppedAt" in meta
    assert s._recorder is None  # session closed


def test_internal_restart_keeps_one_session(tmp_path):
    s = _streamer(tmp_path)
    s._begin_or_resume_session()  # fresh operator start
    rec1, dir1 = s._recorder, s._session_dir

    s._internal_restart = True  # a model/device hot-swap
    s._begin_or_resume_session()  # must RESUME, not mint a new session
    try:
        assert s._recorder is rec1
        assert s._session_dir is dir1
        assert len(list(tmp_path.iterdir())) == 1  # not fragmented into parts
    finally:
        rec1.stop()


def test_missing_deps_disable_recording_gracefully(tmp_path, monkeypatch):
    # Simulate soundfile unavailable: recorder.start() raises → recording disabled,
    # but the streamer keeps going (live captions unaffected).
    s = _streamer(tmp_path)

    def _boom(self):
        raise RuntimeError("no soundfile")

    monkeypatch.setattr(SessionRecorder, "start", _boom)
    s._begin_or_resume_session()
    assert s._recorder is None
    assert s._session_dir is None
