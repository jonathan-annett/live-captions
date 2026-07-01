# Roadmap

## Shipped — v1 (v0.1.0)
Protocol · on-air display · PWA engine (WebGPU/WASM) · desktop server + faster-whisper ·
Apple-Silicon MLX backend · HDMI/kiosk output · transcript export · custom dictionary ·
per-platform packaging + releases.

## v2 — Audience & streaming layer (in progress)

**Backbone:** one transport-agnostic caption protocol over an **id/time-keyed canonical
log**. Stores + the server log become **upsert-by-id** (so corrections and refinement
replace in place); a `locked` flag protects operator-edited segments. First transport:
**WebSocket + Cloudflare Durable Object** (kept swappable so cache-fronted polling can
slot in behind the same interface).

Tiers, building on that one backbone:
1. **Live** — a `CaptionRoom` Durable Object; the source (PWA *or* desktop) pushes over one
   outbound connection, audience phones subscribe at the edge. Mobile viewer shows the
   **live tail** (near-real-time) + **canonical body**, in-memory only. Operator QR to join.
2. **Canonical** — two-tier **refinement** (a longer-context background pass cleans up the
   long-form text; desktop-first, compute-gated) · **operator correction** (click a word →
   sound-alike picker, suppress/undo, low-confidence highlight) · **display sugar** (color,
   font family/size/weight, orientation, background — live controls).
3. **Post-production** — decoupled **hi-fi capture** (record native rate; 16 kHz tee for ASR)
   + **WhisperX forced alignment** of the canonical text → editor-grade time-aligned
   `SRT`/`VTT`/word-JSON · **VAD-guided loudness leveling** (offline two-pass: reuse the
   silence/segment timeline to normalize each speech chunk to a target loudness — LUFS
   target + true-peak clamp, capped boost — and interpolate the gain in dB across the
   silent gaps so levels never jump; same VAD clock as the captions/word timings).
4. **Archive / replay** — Opus audio (leveled) + aligned transcript on object storage;
   historical viewer with **tap-a-line-to-hear-it** + word karaoke (live mode stays text-only).

## Later
- **Live translation** — per-language rooms (id scheme reserves `:lang`); on-device or cloud MT.
- **Quality** — hallucination suppression (no-speech/low-confidence gating), Silero VAD, latency
  tuning; **speech-gated input gain** (normalize detected-speech to a healthy level *before* the
  model — gated to speech so gaps/noise are never boosted into hallucinations; helps quiet
  utterances + quantized q4/int8 models, which self-normalizing Whisper benefits from only
  modestly), and **high-pass / light denoise** as a cleaner ASR feed.
- **Non-lexical sound tags off the projection** — keep Whisper's bracketed non-speech
  annotations (`[Music]`, `[Applause]`, `[Laughter]`, `(music)`, `♪ … ♪`, `[BLANK_AUDIO]`)
  out of the **on-air / HDMI caption window** so they don't waste screen space, while still
  showing them in the **audience mobile viewer / log** (and exports) as a faithful record.
  Applies to PWA + desktop; because both HDMI outputs share the `packages/display` on-air
  render, it's a single render-surface filter (in `captionStore`, partial + finals), driven
  by a shared detector in `@captions/protocol` — not a source-level drop.
- **Operator editor — full-screen + input-modality parity** — a full-screen/zoom mode for
  the correction editor so the operator can work at a comfortable size on a big screen, and
  first-class support for **keyboard-only, mouse-only, and touch-only** operation (not just
  the current click/tap): focusable segments/words, arrow-key navigation, shortcuts for the
  correction actions (fix / sound-alike pick / suppress / join-boundary / undo), and tap
  targets sized for touch with no hover-only affordances. Shared editor (`Corrections.svelte`),
  so it lands on PWA + desktop together; keeps the click-or-tap, editor-only-colours design
  that must also drop into the future moderator/voting UI. (Sequenced after the rest of the
  parity-audit follow-ups.)
- **Spike: sherpa-onnx as a second in-browser ASR engine** (research) — evaluate
  [sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/) (k2-fsa; Apache-2.0; ONNX
  Runtime **WASM** build for the browser) alongside the current transformers.js
  Whisper. The interesting hypothesis: run **WASM (CPU) refinement concurrently
  with the WebGPU (GPU) real-time pass** — different compute backends, so unlike
  the desktop (one Metal GPU, serialized) they could genuinely overlap, bringing
  **two-tier refinement to the PWA** (today desktop-only). What it might also get
  us: a true **streaming** transducer/zipformer model (lower latency than Whisper's
  chunked decode), **real token/word confidence + alignment** (closing the PWA's
  heuristic-confidence gap that transformers.js can't), and a built-in Silero VAD.
  **Key risk to settle first:** multi-threaded WASM wants `SharedArrayBuffer` →
  COOP/COEP cross-origin isolation, which this project deliberately AVOIDS (Whisper
  loads via the same-origin `/hf` proxy precisely so we never re-add COOP/COEP) —
  so measure single-threaded WASM perf, or find a way to isolate only the worker.
  Also weigh: zipformer-en accuracy/punctuation vs Whisper small.en, model +
  bundle size, and whether GPU+CPU actually run without contending. Protocol is
  unaffected (just another engine behind the same interface).
- **Room session management** — beyond the current "reopen the last stopped room"
  shortcut, a proper registry of the operator's rooms: list recent/suspended
  sessions with their start/stop times, restart any of them (same id + token), and
  end/forget them explicitly. Extends toward **historical sessions** — browse and
  reopen past rooms (ties into archive/replay). The single-last-room reopen +
  "room started at …" indicator already shipped; this is the multi-session UI.
- **Audience-view redaction (operator-controlled, non-destructive)** — trim what
  the audience *sees* without touching the canonical transcript (which stays whole
  for exports/archive). Two capabilities: (1) a retroactive **"mark start here"** —
  set the room's viewer start point after captioning began, so all devices stop
  showing speech from before it (false starts, pre-event chatter); (2) **hide
  sections** from the live/audience view (e.g. a morning-tea announcement that
  isn't part of the formal record). Design: a display-visibility layer applied at
  the Viewer render — a room-level `viewerFloor` timestamp for the start marker,
  plus a per-segment `hidden` flag for redaction (lockstep protocol add). Both ride
  the existing lock-aware upsert, so a re-emit reaches already-connected viewers and
  they re-render without the hidden content; the canonical log is unchanged. Operator
  toggles live in the correction panel. Relates to [[correction-ui-tap-transferable]]
  (editor-only, tap-transferable to a future moderator UI).
- **Per-viewer accessibility on mobile** — let each audience device set its OWN
  text size, text colour, and background (high-contrast / large-text) in the mobile
  Viewer, stored locally on that phone — independent of the operator's pushed
  DisplayConfig (which drives the shared projection). A small settings/gear panel in
  `Viewer.svelte`; purely client-side (no protocol change), so a low-vision viewer
  can crank up size/contrast without affecting anyone else or the on-air output.
- **Distribution** — macOS notarization + Windows signing, auto-update.
- **Output reach** — NDI, display themes, RTL / non-Latin fonts.
- **Chroma projection + QR** — chroma-key output with an operator-positioned/sized
  caption box (for lower-thirds keying); the QR may break out of the caption box, large
  enough to scan across an auditorium; a full-screen QR PNG is always downloadable for
  slides/other gear.
- **QR overlay — standalone, fully operator-controlled** (design revised 2026-07-01,
  supersedes the old "chroma-only, auto-shown" behavior): an explicit **on/off toggle**
  (no longer tied to chroma mode), displayable in **any** background mode (solid /
  transparent / chroma), freely **positioned and sized**, with an **editable message**
  explaining what it is (e.g. "Scan for live captions"), plus an **exclusive** toggle
  that **hides the captions while the QR is shown** (a full-attention "scan now" moment).
  Full-screen QR PNG still always downloadable. Protocol: extend `QrOverlay` (lockstep TS
  Zod ↔ pydantic) with `enabled`, `label`, `exclusive`; expose the controls in both
  operator panels (`Control.svelte` + `ControlPanel.svelte`); the display renders it
  independent of `background.kind`.
- **Native config screen** — GUI for audio device, fonts, theming, **and ASR model**
  (default-model picker + download/manage models) instead of CLI-only flags; PWA-identical
  layout with settings portable PWA↔desktop both ways. (Model *picker* may land with v2;
  download/management is later.) Also a tunable **ASR window size** (latency ↔ context
  trade-off) surfaced as a friendly control.
- **Offline** — optional model-bundled builds for air-gapped venues.
- **Model cache: persist + portability** — request persistent browser storage so the
  (~0.6 GB) cached model isn't evicted; export/import the cached model as one file to move
  it to a new machine without re-downloading. Browser (ONNX) and native (CTranslate2/MLX)
  weights aren't interchangeable, but native↔native (zip the model cache dir) is.
- **Audience Q&A** — app users submit questions anchored to a transcript excerpt;
  the speaker swipes through them on a stage tablet (question + tagged excerpt),
  answers, and can project a question via the overlay. Leverages the canonical
  log + the chroma overlay.
- **Geofenced viewer (access control)** — optional: the audience viewer asks for
  location permission and only streams within ~500 m of the venue, closing the
  stream if the user leaves — deters off-site link sharing for paid-seat or
  confidential events. Needs hysteresis + a grace period (no kicking for a
  bathroom/coffee trip or GPS jitter); client GPS is a deterrent, not airtight;
  location is opt-in, disclosed, ephemeral. Venue/Business tier.
- **Crowdsourced moderation** — trusted viewers designated as moderators; a
  consensus vote (e.g. 3/4 majority) commits a correction to the canonical
  transcript and pushes it to everyone. Generalizes single-operator correction;
  rides the existing upsert-by-id + `locked` backbone (adds a moderator role +
  propose/vote protocol + quorum in the room DO).
