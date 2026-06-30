import pytest

import captions_desktop.engines as engines
from captions_desktop.engines import create_engine
from captions_desktop.engines.base import download_with_retry
from captions_desktop.engines.faster_whisper import FasterWhisperEngine
from captions_desktop.engines.mlx import MLXWhisperEngine, _resolve_repo


def test_download_with_retry_recovers_after_transient_failures():
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("dropped")
        return "weights"

    # base_delay=0 keeps the test instant; resume is huggingface_hub's job.
    assert download_with_retry(flaky, "test-model", attempts=5, base_delay=0) == "weights"
    assert calls["n"] == 3


def test_download_with_retry_reraises_after_exhausting_attempts():
    def always_fails():
        raise ConnectionError("offline")

    with pytest.raises(ConnectionError, match="offline"):
        download_with_retry(always_fails, "test-model", attempts=3, base_delay=0)


def test_explicit_faster_whisper():
    assert isinstance(create_engine("faster-whisper", model="base.en"), FasterWhisperEngine)


def test_explicit_mlx():
    assert isinstance(create_engine("mlx", model="base.en"), MLXWhisperEngine)


def test_auto_non_apple_uses_faster_whisper(monkeypatch):
    monkeypatch.setattr(engines, "is_apple_silicon", lambda: False)
    assert isinstance(create_engine("auto", model="base.en"), FasterWhisperEngine)


def test_auto_apple_with_mlx_uses_mlx(monkeypatch):
    monkeypatch.setattr(engines, "is_apple_silicon", lambda: True)
    monkeypatch.setattr(engines, "mlx_available", lambda: True)
    assert isinstance(create_engine("auto", model="base.en"), MLXWhisperEngine)


def test_resolve_repo():
    assert _resolve_repo("base.en") == "mlx-community/whisper-base.en-mlx"
    assert _resolve_repo("large-v3") == "mlx-community/whisper-large-v3-mlx"
    # turbo's repo has no `-mlx` suffix — must use the override, not the convention.
    assert _resolve_repo("large-v3-turbo") == "mlx-community/whisper-large-v3-turbo"
    # full repo ids pass through untouched.
    assert (
        _resolve_repo("mlx-community/whisper-large-v3-turbo")
        == "mlx-community/whisper-large-v3-turbo"
    )


def test_mlx_load_graceful_without_dep():
    # mlx-whisper isn't installed in CI/this env: load returns an error status,
    # not an exception.
    status = MLXWhisperEngine(model="base.en").load()
    assert status.backend == "mlx-whisper"
    assert status.state in ("error", "listening")
