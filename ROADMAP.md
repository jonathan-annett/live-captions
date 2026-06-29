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
   `SRT`/`VTT`/word-JSON.
4. **Archive / replay** — Opus audio + aligned transcript on object storage; historical
   viewer with **tap-a-line-to-hear-it** + word karaoke (live mode stays text-only).

## Later
- **Live translation** — per-language rooms (id scheme reserves `:lang`); on-device or cloud MT.
- **Quality** — hallucination suppression (no-speech/low-confidence gating), Silero VAD, latency tuning.
- **Distribution** — macOS notarization + Windows signing, auto-update.
- **Output reach** — NDI, display themes, RTL / non-Latin fonts.
- **Chroma projection + QR** — chroma-key output with an operator-positioned/sized
  caption box (for lower-thirds keying); the live-room QR overlay is offered only in
  chroma mode and may break out of the caption box (large enough to scan across an
  auditorium); a full-screen QR PNG is always downloadable for slides/other gear.
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
- **Crowdsourced moderation** — trusted viewers designated as moderators; a
  consensus vote (e.g. 3/4 majority) commits a correction to the canonical
  transcript and pushes it to everyone. Generalizes single-operator correction;
  rides the existing upsert-by-id + `locked` backbone (adds a moderator role +
  propose/vote protocol + quorum in the room DO).
