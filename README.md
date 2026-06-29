# Caption Guru

Open-source, **on-device** live caption generator for live events. Audio never leaves the machine.

Ships in two forms:

- **PWA** — runs entirely in the browser using Whisper via WebGPU (WASM fallback). Zero install.
- **Desktop** — Python + WhisperX/faster-whisper (Windows/macOS), bundled fullscreen via `pywebview`, with a Chrome-kiosk CLI fallback.

The on-air surface is a **fullscreen web page** designed to feed a vision switcher over **HDMI** (primary), or as a transparent **LAN browser source** for OBS/vMix.

## Repository layout

```
packages/
  protocol/   # shared caption protocol (TS types + runtime validation)
  display/    # fullscreen caption renderer + audience viewer (shared by PWA + desktop)
  pwa/        # browser-only build (transformers.js, WebGPU/WASM) + operator control
  room/       # v2 audience-layer transport (CaptionRoom Durable Object) — isolated
desktop/      # Python app (FastAPI + faster-whisper, pywebview)
```

The **display surface and caption protocol are shared**; only the ASR engine and transport differ between builds.

## Status

**v1 shipped** as v0.1.0 — the PWA is live at [caption.guru](https://caption.guru) and the
desktop app ships as per-platform release zips. **v2**, the audience / streaming layer (live
rooms, mobile scrollback viewer, operator QR), is in progress.

See **[ROADMAP.md](ROADMAP.md)** for the plan and **[WHATSNEW.md](WHATSNEW.md)** for shipped changes.

## Development

Requires Node 20+, [pnpm](https://pnpm.io) 9+, and (for the desktop build) Python 3.11+.

```bash
pnpm install
pnpm build
```

## License

MIT © Jonathan Annett
