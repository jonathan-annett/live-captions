# What's New

Notable changes per release. (Format loosely follows Keep a Changelog.)

## v0.2.0-beta — 2026-07-01

Large catch-up release — the desktop app gains an operator control panel, an
audience layer, two-tier refinement, and a lot of ASR-quality + stability work.
Tagged `-beta` because it's a big jump landing ahead of the web cutover. Protocol
bumped to **v9**. (Renamed from "live-captions" → **Caption Guru**.)

Desktop artifacts: **Windows x64, Linux x64, macOS Apple Silicon** via CI; **macOS
Intel** built manually (see `RELEASE-macos-intel-manual.md`) while `macos-13`
runners are deprecated.

### New — Operator control panel (`/control`)
- Full operator UI served by the desktop server: **look** controls (background
  solid/chroma/transparent, caption box position/size/fill/radius, font family/
  size/weight/orientation/justification, uppercase), **model picker** with live
  **hot-swap** of the live + refine models, **custom dictionary** (live-apply +
  help), **Start/Stop/Clear**, and **operator corrections** (click-to-fix,
  Double-Metaphone sound-alike picker, merge/join, repetition collapse).
- **Microphone picker + live hot-swap** — switch the input device mid-session
  without reloading the model; `--list-devices` CLI flag to list inputs.

### New — Audience layer (v2)
- **Live audience rooms** — mint a room, audience joins via a **short URL / QR**;
  mobile **viewer** with history + scrollback; **connected-device count**.
- **Runtime room controls** in the panel (Start/Stop/Restart) and a **Copy OBS
  link** button (on-air display as an OBS Browser Source).
- **Session recovery** — an operator page refresh recovers the room + transcript
  + mic; **restart-last-room** reopens the previous room.

### New — Projection / output
- **Standalone QR overlay** — operator-toggled, any background mode, positionable/
  sizable, **editable label**, **exclusive** mode (hides captions for a "scan now"
  moment). Full-screen QR PNG download + a **persistent QR PNG** rewritten on every
  room start (`--qr-png-path`, segno) for an auto-refreshing OBS/PowerPoint source.
- **Fixed caption box** (position/size/fill/rounded corners) for lower-thirds keying.

### New — ASR quality
- **Two-tier refinement** — a background pass re-decodes each finalized utterance
  at higher quality on its own engine/thread and upserts it in place (lock-aware).
- **Word-level timing + confidence** from both engines; **locked** segments +
  lock-aware upsert everywhere; **repeated-loop collapse**; **line-merge** control;
  warmup + silence catch-up; hallucination hygiene.

### Fixed
- **MLX/Metal crash** under concurrent decodes — serialized with a process lock.
- **large-v3-turbo** resolves to its real MLX repo (no `-mlx` suffix).
- **Robust model downloads** — explicit resume + retry on flaky links.
- **Double-start guard** on the streamer; server **starts idle by default**
  (`--autostart` for turnkey); surfaces a failed refine-model load instead of
  swallowing it.

### Changed
- Default `serve` = `small.en` live + `large-v3` refine (use `--no-refine` /
  Refine = Off on low-memory / single-GPU machines).

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
