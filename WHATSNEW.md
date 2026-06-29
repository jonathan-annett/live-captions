# What's New

Notable changes per release. (Format loosely follows Keep a Changelog.)

## Unreleased

**PWA — caption quality**
- **Hallucination suppression.** Whisper used to invent text on silence/non-speech
  (repeated symbols like `>>>>`/`[`, or phantom phrases like "I'm sorry"). Now a
  **no-speech gate** skips silent/near-silent audio before it's ever transcribed,
  a **degenerate-output filter** drops symbol-only junk, and the on-air display
  **never renders blank lines**.
- Removed generation params (`no_repeat_ngram_size` / `repetition_penalty`) that
  were derailing Whisper into single-token output (`"["`, `"W"`) on real speech.

**PWA — model picker**
- Dropped **base.en** (consistently the weakest on WebGPU); kept **tiny.en** +
  **small.en**; added **large-v3-turbo** (best accuracy, pinned to q4f16 ≈ 0.6 GB).
- Each model now shows its **one-time download size** in the picker, and your
  **selected model + microphone are remembered** across reloads.

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
