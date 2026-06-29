# captions-desktop

Desktop build of [live-captions](../README.md): a Python app that captures audio,
runs on-device ASR (faster-whisper / WhisperX, with an Apple-Silicon GPU backend),
serves the shared web display + control UI over a local server, and shows the
caption surface fullscreen via `pywebview` (HDMI output) with a Chrome-kiosk CLI
fallback.

Audio never leaves the machine.

## Install (dev)

> **Python version:** the real ASR backend (`faster-whisper`/CTranslate2) needs
> **Python 3.11 or 3.12** — there are no wheels for 3.14 yet. The server itself
> (and the `--demo` mode) runs on any 3.11+. Create the venv with a supported
> interpreter, e.g. via [uv](https://docs.astral.sh/uv/): `uv venv --python 3.12`.

```bash
cd desktop
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[server,audio,asr,desktop,dev]"
```

Extras: `server` (FastAPI + numpy), `audio` (sounddevice/PortAudio mic capture),
`asr` (faster-whisper), `desktop` (pywebview), `dev` (pytest + httpx). For just
the server + tests (no PortAudio / CTranslate2): `pip install -e ".[server,dev]"`.

The server serves the built shared frontend, so build it once from the repo root:

```bash
pnpm --filter @captions/display build
```

## Run

```bash
captions serve                       # live: mic -> faster-whisper -> captions
captions serve --model small.en      # pick a model (tiny/base/small .en)
captions serve --demo                # scripted captions, no mic/ASR (great for testing)
```

Then open the printed **display** URL (`http://127.0.0.1:8765/?source=ws`) — that's
the on-air surface to send to your switcher (HDMI fullscreen + Chrome-kiosk come in M5).
History/scrollback substrate is at `/history`; captions stream over `/ws`.
