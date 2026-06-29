import captions_desktop.engines as engines
from captions_desktop.engines import create_engine
from captions_desktop.engines.faster_whisper import FasterWhisperEngine
from captions_desktop.engines.mlx import MLXWhisperEngine, _resolve_repo


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
