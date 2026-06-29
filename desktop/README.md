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
captions serve                       # live captions + fullscreen display window
captions serve --model small.en      # pick a model (tiny/base/small .en)
captions serve --demo                # scripted captions, no mic/ASR (great for testing)
```

By default `serve` opens the display **fullscreen via pywebview** (the HDMI output
to feed your switcher). Display options:

```bash
captions serve --list-monitors                 # list monitors, then exit
captions serve --monitor 1                      # put the fullscreen output on monitor 1 (HDMI)
captions serve --background chroma              # green key bg (default #00b140)
captions serve --background chroma --bg-color "#00ff00"
captions serve --background transparent         # transparent (browser-source style)
captions serve --kiosk                          # use Chrome kiosk instead of pywebview
captions serve --windowed                       # don't go fullscreen
captions serve --no-open                         # server only; open the URL yourself
```

The window just renders the page; the background (solid/chroma/transparent) is
painted from config, so HDMI capture vs keying is a flag, not a rebuild. The same
page is also a LAN **browser source**: `http://<host>:8765/?source=ws`. Captions
stream over `/ws`; the history/scrollback substrate is at `/history`.

> pywebview is needed for the fullscreen window (`pip install -e ".[desktop]"`).
> Without it, `serve` automatically falls back to Chrome kiosk.
