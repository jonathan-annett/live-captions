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

On Apple Silicon, add the GPU backend (`faster-whisper` is CPU-only on macOS):

```bash
pip install -e ".[server,audio,asr,mlx,desktop,dev]"
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
captions serve --engine mlx          # force the Apple-Silicon GPU backend
captions serve --engine faster-whisper --device cuda
captions serve --demo                # scripted captions, no mic/ASR (great for testing)
```

`--engine auto` (default) uses **MLX** (Apple GPU) on Apple Silicon when
installed, otherwise **faster-whisper** (CPU, or CUDA on NVIDIA). `--model`
accepts a short name (`base.en`) or a full HF repo; for MLX the short name maps
to `mlx-community/whisper-<model>-mlx`.

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

## Packaging / releases

Bundled with PyInstaller into a one-folder app, zipped per platform. `torch` is
excluded (mlx-whisper declares it but doesn't use it for transcription), saving
~2 GB per build.

Build locally:

```bash
pnpm --filter @captions/display build          # from repo root: build the frontend
cd desktop
uv pip install -e ".[server,audio,asr,mlx,desktop,package]"
python packaging/build.py                       # -> dist/live-captions-<target>.zip
```

Cut a release: push a tag and CI builds + attaches the per-platform zips to a
GitHub Release (`.github/workflows/release.yml`, matrix: Windows x64, macOS
Intel, macOS Apple Silicon, Linux x64):

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Per platform: macOS arm64 includes the **MLX** GPU backend; Intel mac / Windows
use faster-whisper; the Linux artifact is server + browser/kiosk (no native
window). All include the bundled frontend.

> **macOS Gatekeeper:** the bundles are unsigned, so first launch is blocked.
> Right-click → Open, or run `xattr -dr com.apple.quarantine live-captions/`.
> Code signing/notarization is a future addition.
