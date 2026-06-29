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
- **Offline** — optional model-bundled builds for air-gapped venues.
