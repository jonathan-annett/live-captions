# captions-desktop

Desktop build of [live-captions](../README.md): a Python app that captures audio,
runs on-device ASR (faster-whisper / WhisperX, with an Apple-Silicon GPU backend),
serves the shared web display + control UI over a local server, and shows the
caption surface fullscreen via `pywebview` (HDMI output) with a Chrome-kiosk CLI
fallback.

Audio never leaves the machine.

## Install (dev)

```bash
cd desktop
python -m venv .venv && source .venv/bin/activate
pip install -e ".[server,asr,desktop,dev]"
```

For just the protocol + tests (no torch/CTranslate2):

```bash
pip install -e ".[dev]"
```

## Run

```bash
captions serve            # start server + open fullscreen display
captions serve --kiosk    # fallback: launch Chrome in kiosk mode
```
