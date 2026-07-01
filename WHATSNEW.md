# What's New

Notable changes per release. (Format loosely follows Keep a Changelog.)

## Unreleased — v2 beta (v2.caption.guru)

**Audience room — QR overlay redesign** (protocol v8)
- QR overlay is now a **standalone, operator-toggled** element: explicit on/off, works in **any** background mode (solid / transparent / chroma — no longer chroma-only), freely positioned/sized, with an **editable label** and an **exclusive** mode that hides captions for a full-attention "scan now" moment.
- **Persistent QR PNG**, rewritten on every room start: PWA via the Chromium **File System Access API** (handle stored in IndexedDB); desktop via **`--qr-png-path`** (segno) — point OBS/PowerPoint at the file and it auto-refreshes. Full-screen PNG download still available everywhere.
- **Desktop runtime room controls** — Start/Stop/Restart room + QR controls now in the desktop `/control` panel via a new `roomControl` message (was CLI-launch-flags only). Closes the last PWA↔desktop parity-audit gap.

## v0.1.0 — 2026-06-29

First public release.

**PWA** (live at https://caption.guru)
- On-device live captions in the browser — transformers.js, **WebGPU** with WASM fallback.
- Operator control page (mic + model selection) and a fullscreen on-air display.
- Model-download progress UI (percent / bytes / elapsed / ETA / cancel) with a one-time-download explainer.
- Same-origin model proxy (`/hf`) so model loading never hits cross-origin CORS.

**Desktop** (Windows / Linux / macOS)
- Python app: FastAPI server + **faster-whisper** (CPU/CUDA), with an **MLX** GPU backend auto-selected on Apple Silicon.
- Fullscreen HDMI output via pywebview (monitor selection) + Chrome-kiosk fallback.
- Backgrounds: solid / chroma-key / transparent. Live captions stream over `/ws`; `/history` substrate.

**Shared**
- Caption protocol (TS + Python), reusable on-air display surface.
- Transcript export: `txt` / `SRT` / `VTT`.
- Custom dictionary (faster-whisper hotwords; PWA fuzzy correction).

**Packaging**
- PyInstaller bundles, per-platform GitHub Release zips. Models download on first run (kept out of the bundle).
- Artifacts: Windows x64, Linux x64, macOS Apple Silicon. _macOS Intel ships separately as `v0.1.0-intel` (scarce Intel runners)._

[Releases](https://github.com/jonathan-annett/caption-guru/releases)
