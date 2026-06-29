# live-captions

Open-source, **on-device** live caption generator for live events. Audio never leaves the machine.

Ships in two forms:

- **PWA** — runs entirely in the browser using Whisper via WebGPU (WASM fallback). Zero install.
- **Desktop** — Python + WhisperX/faster-whisper (Windows/macOS), bundled fullscreen via `pywebview`, with a Chrome-kiosk CLI fallback.

The on-air surface is a **fullscreen web page** designed to feed a vision switcher over **HDMI** (primary), or as a transparent **LAN browser source** for OBS/vMix.

## Repository layout

```
packages/
  protocol/   # shared caption protocol (TS types + runtime validation)
  display/    # fullscreen caption renderer (shared by PWA + desktop)
  control/    # operator/settings UI
  pwa/        # browser-only build (transformers.js, WebGPU/WASM)
desktop/      # Python app (FastAPI + faster-whisper, pywebview)
```

The **display surface and caption protocol are shared**; only the ASR engine and transport differ between builds.

## Status

Early development. See [the build plan](#roadmap) below.

## Roadmap

- **M1** Monorepo skeleton + shared caption protocol ✅
- **M2** Shared display surface ✅
- **M3** PWA in-browser engine (transformers.js WebGPU/WASM) ✅
- **M4** Desktop server + faster-whisper streaming ✅
- **M5** pywebview fullscreen HDMI output + CLI kiosk ✅
- **M6** Transcript export + custom dictionary ✅ — **v1 feature-complete**
- **M7** Apple-Silicon GPU backend (MLX-Whisper) ✅
- **M8** Packaging — PyInstaller bundles + per-platform GitHub Release zips (PWA already deployed) ✅

### Planned / future

- Live translation, speaker diarization, NDI output.
- **Audience scrollback** — mobile-friendly read-only view to scroll back over the last ~30 minutes (joins over LAN via URL/QR). The caption protocol is an append-only timestamped log so this lands without rework.

## Development

Requires Node 20+, [pnpm](https://pnpm.io) 9+, and (for the desktop build) Python 3.11+.

```bash
pnpm install
pnpm build
```

## License

MIT © Jonathan Annett
