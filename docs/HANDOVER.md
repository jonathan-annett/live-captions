# live-captions — Handover

_Last updated: 2026-06-29._

Open-source, on-device live caption generator for live events. Two clients (PWA
+ desktop) feed a fullscreen display into a vision switcher. v1 is complete; this
doc is the primer for picking up **v2 (the audience/streaming layer)**.

Repo: https://github.com/jonathan-annett/live-captions (public)
Live PWA: https://live-captions.jonathan-max-annett.workers.dev

---

## 1. Status

**v1 complete (M1–M8), all on `main`:**
- **M1** shared protocol (`@captions/protocol`, Zod) + Python pydantic mirror.
- **M2** shared display surface (`@captions/display`, Svelte).
- **M3** PWA engine (transformers.js WebGPU/WASM) — **live, verified on Apple Silicon**.
- **M4** desktop server (FastAPI + faster-whisper) — multi-client `/ws`, rolling log, `/history`.
- **M5** pywebview fullscreen HDMI output + monitor select + Chrome-kiosk fallback.
- **M6** transcript export (txt/SRT/VTT) + custom dictionary.
- **M7** Apple-Silicon **MLX** backend — **verified running on the Mac GPU**.
- **M8** PyInstaller packaging + per-platform GitHub Release pipeline.

**In flight:** release `v0.1.0` — Windows / Linux / macOS-arm64 built green; macOS-Intel
was queued on a scarce runner. The Release publishes once all four legs finish.

---

## 2. Test checklist (do this first, tomorrow)

Download the release zips from the v0.1.0 run / Release page and test:
- [ ] **macOS Apple Silicon** (your MacBook) — should auto-select MLX (GPU).
- [ ] **macOS Intel** — faster-whisper CPU; try `--model tiny.en`/`base.en`.
- [ ] **Windows (low-spec laptop)** — `live-captions.exe serve --model tiny.en`; watch real-time factor. Needs Edge WebView2 (preinstalled Win10/11) else falls back to Chrome kiosk.
- [ ] **macOS Gatekeeper:** unsigned → right-click Open, or `xattr -dr com.apple.quarantine live-captions/`.
- [ ] If the native window misbehaves anywhere: `serve --no-open` then open `http://127.0.0.1:8765/?source=ws`.
- [ ] **PWA** on each machine's browser (WebGPU on desktop Chrome/Edge).

Report back: latency (speech→caption), accuracy, hallucinations on silence, and how the low-spec Windows box copes. That drives the first quality-tuning pass.

---

## 3. Run / build / env reference

**Toolchain quirks (important):**
- Node 24 local; **pnpm via corepack** → invoke as `corepack pnpm …`.
- System Python is **3.14** (no faster-whisper/MLX wheels). The desktop venv is
  **Python 3.12 via `uv`** at `desktop/.venv`, installed with
  `[server,audio,asr,mlx,desktop,package]`. MLX `base.en` model already cached.

**Common commands:**
```bash
# JS
corepack pnpm install
corepack pnpm --filter @captions/pwa dev          # PWA dev (control + display)
corepack pnpm --filter @captions/display build     # build frontend (desktop serves this)
corepack pnpm --filter @captions/protocol test     # vitest

# Desktop (from desktop/, venv active)
source desktop/.venv/bin/activate
captions serve                 # live; auto MLX on Apple Silicon
captions serve --demo --windowed   # scripted captions, no mic/ASR
desktop/.venv/bin/python -m pytest desktop -q      # 29 tests

# Package a desktop bundle locally
corepack pnpm --filter @captions/display build
python desktop/packaging/build.py                  # -> desktop/dist/live-captions-<target>.zip

# Release: push a tag -> CI builds all 4 platforms
git tag vX.Y.Z && git push origin vX.Y.Z
```

**Cloudflare:** PWA deploys as a **Worker with static assets** (`wrangler.jsonc`,
`packages/pwa/worker/index.js`). Auto-deploys on push to `main`.

---

## 4. Repo map

```
packages/
  protocol/   Zod caption protocol (+ export.ts). Mirrored in desktop/protocol.py — KEEP IN LOCKSTEP.
  display/    Svelte on-air renderer; exports App as a lib (reused by PWA). CaptionSource adapters.
  pwa/        control + display pages; transformers.js worker; Cloudflare worker (/hf proxy + assets).
desktop/captions_desktop/
  server.py   FastAPI: /ws, /history, /export, serves frontend
  hub.py      CaptionHub: rolling log + multi-client fan-out (thread-safe submit)
  streaming.py LiveStreamer (sounddevice+VAD+engine) + MockProducer
  engines/    ASREngine ABC + faster_whisper.py + mlx.py + create_engine factory
  window.py   pywebview fullscreen + Chrome-kiosk fallback
  cli.py      `captions serve` (flags: --engine/--model/--monitor/--background/--dictionary/--demo/--no-open)
  packaging/  captions.spec, entry.py, build.py
.github/workflows/release.yml   per-platform matrix -> GitHub Release
```

---

## 5. Architecture invariants (don't break these)

1. **Audio never leaves the device.** On-device ASR is the core promise; only caption *text* ever goes to a server (and only in the opt-in audience/cloud paths).
2. **Transport-agnostic protocol.** One JSON message set (`@captions/protocol`) over BroadcastChannel (PWA) or WebSocket (desktop). TS (Zod) and Python (pydantic) mirrors must stay in sync.
3. **Shared display.** `@captions/display` `App` is reused by PWA + desktop; don't fork the renderer.
4. **Pluggable engine + source.** `ASREngine` (faster-whisper/MLX) behind `create_engine`; `CaptionSource` adapters decouple transport from UI. v2 adds new ones, doesn't rewrite.
5. **Segments are id + time keyed.** This is the backbone for scrollback, correction, and refinement (see v2). Stores currently *append*; v2 makes them **upsert by id**.
6. **PWA model loading goes through the same-origin `/hf` proxy** (Worker). Do NOT re-add COOP/COEP without first self-hosting models same-origin (it breaks HF fetches).

---

## 6. v2 design — the audience / streaming layer

**Decision:** build the **WS + Durable Object** transport first (per operator
request), keeping transport strictly separable from UI so polling can slot in
later behind the same `CaptionSource`.

### Backbone changes
- **Upsert-by-id** in all stores + the DO log (corrections & refinement replace in place).
- **`locked` flag** on segments — operator edits are protected from the refinement pass.
- **Canonical log = refined + corrected; live tail = provisional.** Refinement replaces by *time range* (sidesteps re-segmentation/id mismatch). Viewer renders canonical body + live tail.

### Four tiers (one canonical backbone)
1. **Live** — publisher (PWA *or* desktop) opens ONE outbound WS to a `CaptionRoom` Durable Object; audience phones connect to the DO (edge holds the 5000, laptop holds 1). Hibernation API for cheap idle sockets; history-on-connect; publish requires a token, subscribe is read-only. Mobile viewer shows the **live tail in near-real-time**.
2. **Canonical** — (a) **two-tier refinement**: a background pass over a longer context window (bigger model, `condition_on_previous_text=True`) produces cleaner long-form text; desktop-first, gated on compute (off on low-spec CPU). (b) **operator correction**: click a word → popover of **sound-alike alternatives** (Double Metaphone over a frequency wordlist + near-miss edit distance + custom dict + curated homophones), number-key pick, suppress/undo, low-confidence highlighting. (c) **display sugar**: live controls for color / font family+size / weight / orientation (portrait) / background.
3. **Post-production** — **decoupled hi-fi capture**: record at the device's native rate (e.g. 48k FLAC) for download, with a **16 kHz mono tee** for ASR (Whisper is 16k-only; higher rates give no recognition gain and break numpy input if not resampled). Then **WhisperX/wav2vec forced alignment** of canonical text → editor-grade time-aligned SRT/VTT/word-JSON. Optional offline re-transcribe with the biggest model, merged with `locked` corrections.
4. **Archive / replay (v2.x)** — Opus derivative + aligned transcript on **R2**; viewer "historical mode" with **tap-a-line-to-hear-it** + word karaoke. **Live mode = text-only (no playback)** so a roomful of phones can't blast audio. Publishing a recording is an explicit opt-in (consent/retention) — distinct from the live privacy guarantee.

### Mobile viewer
Live tail + canonical body; **in-memory only** (no localStorage/IndexedDB/SW data caching — refresh = re-fetch history snapshot). Transport via `CaptionSource` (WS first). Room id from URL; operator hits a key → fullscreen QR of the subscribe URL.

### Scale notes
- WS+DO chosen for low latency + future interactivity; **cache-fronted polling** remains the cheap fallback transport (same `CaptionSource` seam).
- **Per-language rooms** for translation (id scheme reserves `:lang`); a fan-out tree of DOs if one popular language exceeds a single DO; enforce the viewer cap (e.g. 5000) at the DO.

### Build phases
- **A.** `CaptionRoom` DO + Worker routes (`/r/new`, `/r/:id/publish`, `/r/:id/subscribe`), hibernation, history-on-connect, wrangler DO binding. _Build in isolation; nothing ships to the live PWA until ready._
- **B.** client `RoomSource` (reuses `WebSocketSource`) + uncapped in-memory `ViewerStore`; upsert-by-id.
- **C.** mobile viewer UI (scrollback, jump-to-live, status).
- **D.** publisher integration (PWA captioner + desktop hub).
- **E.** operator "Start room" + fullscreen QR.
- Then: refinement, correction + sound-alike, display sugar, post-production alignment, archive/replay.

---

## 7. Business / freemium direction

Open-core-by-hosting: **clients + server are open source and self-hostable;
monetize the managed hosting** and what costs real money (storage/retention,
scale, cloud compute) or carries operational value (custom domain, branding,
support). On-device stays free and private.

- **Community (free):** PWA + desktop (all on-device), self-host, capped hosted room (~25–50 viewers, ~15-min scrollback, no persistent archive).
- **Pro (sub or per-event):** ~500 viewers, full scrollback, persistent archives + replay (30–90d retention), custom domain, basic translation.
- **Venue/Business:** 5000+, multiple rooms, long/unlimited retention, white-label, SSO/teams, support/SLA.
- **Pricing shape:** offer **per-event/credits alongside subscriptions** — live events are episodic.
- **Cost anchors:** R2 storage (archives/audio; egress free), DO scale, cloud MT if hosted. Tier on storage/scale/compute.
- **Licensing:** clients fully OSS; hosted-server component fully OSS (+ trademark) or source-available if rehosting becomes a threat.

Domain name: being finalized (TBD).

---

## 8. Open decisions to confirm before Phase A

- **Room retention:** rolling ~30 min vs full-session at the edge?
- **Subscribe auth:** open link/QR vs lightweight read-token?
- **v2 scope:** single source-language stream first (recommended), per-language later?
- **Translation generation:** on-device MT (privacy-consistent) vs cloud MT? target languages?
- **Server licensing:** fully OSS vs source-available?

## 9. First task tomorrow
Confirm §8, then start **Phase A** (the `CaptionRoom` DO) in isolation — verify with a script (one publisher WS, two subscriber WSs, history on late join) before touching the clients.
