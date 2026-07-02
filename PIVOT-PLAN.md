# Unified-Frontend Pivot — Implementation Plan

**Status:** planning (2026-07-02). Decisions locked; not yet started.
**Branch:** `v2-audience-layer`.

## The pivot in one paragraph

Make the **PWA the single frontend** for both web and desktop. **ASR becomes a
pluggable backend**: in-browser WebGPU/transformers.js (cloud, no-install) **or**
a localhost Python server over WebSocket (desktop, heavy models + two-tier
refine). The **browser always owns capture** (getUserMedia → 16 kHz worklet →
VAD → utterance framing) and, later, **archive** (MediaRecorder Opus → R2).
Python collapses to a stateless **"decode this clip + optionally refine it"**
service fed audio over WS. This unifies the two frontends, kills the
native-webview bug class, and makes desktop look exactly like cloud with the ASR
socket pointed at localhost instead of at in-browser WebGPU.

## Locked decisions

1. **Audio transport = Clip-based (Option A).** The browser does VAD +
   utterance framing (identical to WebGPU mode) and sends **complete utterance
   clips** over WS. Python is stateless per clip. Rationale: keeps the browser
   capture pipeline byte-identical across cloud and desktop (the whole point of
   the pivot) and reuses `engine.transcribe` / `RefinementPass` directly.
   Re-sending growing clips for partials is negligible on localhost
   (sub-millisecond; ~64 KB/s float32, half that as Int16).
2. **Build order = Pivot foundation first**, then archive/replay layered on the
   unified frontend.
3. **Native Python capture is retained behind a flag** (headless / hi-fi /
   appliance modes) — the WS-audio path is the new default, not a deletion of
   `sounddevice`. Hi-fi mastering is podcast-studio's niche, not Caption Guru's;
   a lossy browser Opus archive is the right target here.

## Why it won't turn into spaghetti — the seams already exist

- **PWA:** `Captioner` (`packages/pwa/src/engine/captioner.ts`) is already
  ASR-agnostic except three members — worker creation in `start()`,
  `rpc(samples, words)`, and `onWorkerEvent()` — all keyed to the small RPC
  contract in `engine/messages.ts` (`Float32 samples → {text, words}`). Capture
  and output (`emit` → `sink` tee) are already backend-independent.
- **Desktop:** everything downstream of the `_frames` queue
  (`streaming.py:289`) is audio-source-agnostic; engines sit behind the
  `ASREngine` ABC (`engines/base.py`); the server drives a small `Controller`
  protocol (`streaming.py:30-36`). Clip-based mode actually bypasses the
  `_frames`/VAD streaming machinery and calls `engine.transcribe` directly.
- **Protocol:** `CaptionSegment` already carries `start/end` + `words[].start/end`
  in session-relative seconds (`packages/protocol/src/index.ts`) — karaoke-ready.

Net-new infra: **binary WS frames** (all WS traffic is JSON text today) and, for
archive, an **R2 binding + `/api` route** (none exist today).

---

## Workstream 1 — The pivot (foundation first)

### P0 — `AsrBackend` seam (PWA, pure refactor, zero behavior change)

Introduce one interface; extract the current worker behind it. This is the
keystone — every later phase hangs off it.

- New `packages/pwa/src/engine/backend.ts`: `AsrBackend` interface mirroring the
  `messages.ts` contract:
  - `load(model, opts): Promise<void>` (+ progress/loading/ready/error events)
  - `transcribe(samples: Float32Array, opts: {words: boolean}): Promise<{text, words}>`
  - `onStatus(cb)` / `onProgress(cb)` — status + model-load progress
  - `onRefine(cb: (id, {text, words}) => void)` — **new**; async refined result
    for an already-emitted utterance id. WebGPU backend never fires it.
  - `close()`
- `WorkerBackend implements AsrBackend` — wraps today's `new Worker(asr.worker.ts)`
  + `rpc` + `onWorkerEvent` verbatim (moved out of `Captioner`).
- Refactor `Captioner` to take an injected `AsrBackend`; `start()` no longer
  news-up the worker, `rpc()`/`onWorkerEvent()` become backend calls. `Captioner`
  keeps ownership of capture/VAD/framing/emit/tee unchanged.
- **Checkpoint:** WebGPU path identical; PWA/display tests green; smoke on
  cloud PWA. No user-visible change.

### P1 — Backend selection + `LocalWsBackend` (PWA)

- **Setting:** ASR backend = `on-device (WebGPU)` | `local server`. Persist as
  `cg.asrBackend` (localStorage), UI near the model picker in `Control.svelte`.
- `LocalWsBackend implements AsrBackend`:
  - Connects to the localhost WS (reuse the capped-backoff reconnect pattern
    from `packages/display/src/sources/websocket.ts`).
  - `transcribe(clip)` → sends a **binary clip frame** (see wire format below),
    resolves the promise on the correlated result message. Fires `onRefine`
    when Python later returns a refined result for the same id.
  - Model list + status come from Python over the existing JSON control
    messages (`setModel`, `status`, model advertisement).
  - Discovery: probe `ws://127.0.0.1:8765/ws` when `local server` is selected;
    graceful status + fall back to WebGPU if unreachable.
- **Checkpoint:** cloud PWA still defaults to WebGPU; `local server` selectable
  but Python side not built yet (backend reports "unavailable").

### P2 — Python clip-decode service + binary WS ingest

- **Binary WS on the existing `/ws`** (`server.py`): the `reader()` loop switches
  from `receive_text()` to `sock.receive()` and discriminates
  `{"text": ...}` (JSON control/caption) vs `{"bytes": ...}` (audio clip). Audio
  **bypasses** `parse_client_message` (pydantic `extra="forbid"` + JSON is a poor
  fit for PCM). One socket, mixed frames — no second connection.
- **Wire format (binary clip frame):** small fixed header + PCM payload:
  - `u32 utteranceId`, `u8 flags` (bit0 = final vs partial), `u8 format`
    (0 = Float32LE, 1 = Int16LE), `u16 reserved`, then the PCM samples
    (mono, 16 kHz). Result correlation is by `utteranceId`.
  - Keep this **out of the Zod/pydantic protocol** — it's a binary side-channel.
    Only tiny JSON additions (see protocol note) get a `PROTOCOL_VERSION` bump.
- **`ClipDecoder` service** (new; implements the `Controller` protocol beside
  `LiveStreamer`/`MockProducer`, wired in `cli.py`): on a clip →
  `engine.transcribe(samples)` → emit `final`/`partial` correlated by id;
  submit finals to the existing `RefinementPass` → refined result re-sent for the
  same id. It does **not** use `_frames`/VAD/utterance assembly (that's the
  browser's job now). Reuses hub → WS writer path to return results.
  - `set_model` / model advertisement work through existing control messages.
  - `set_device`/sounddevice methods become no-ops in this mode.
- **Checkpoint:** `local server` backend fully functional end-to-end; a browser
  tab on localhost captions through Python (heavy model + refine). BlackHole
  loopback still works as the "mic" via getUserMedia.

### P3 — Desktop shell split (DECIDED 2026-07-02): control in the browser, display native + LAN

Not one shell — **two surfaces with different jobs**:

- **Control = the PWA in a real browser.** It is both the interactive operator
  surface and the surface that *must stay open* (capture — getUserMedia +
  AudioWorklet — lives in the tab). Putting control there gives the operator a
  reason to keep the tab foreground; a headless capture-only tab would get
  closed/ignored and lose the session. Real browser also means blob exports work
  and the WKWebView bug class (blob downloads, click/drag, `private_mode` wipe)
  never applies to the interactive surface. Desktop launches the Python server
  and opens the full PWA preset to `backend = local server`.
- **Display = native fullscreen / webview projector output, LAN-exposed.** Kept
  native because it renders projection/chroma far better than a browser tab.
  Served by the local server bound to the LAN so **venue OBS machines and other
  displays subscribe to the same output surface over the network**. It is
  output-only, so the WKWebView blob-download bug is moot there.
- **How they connect — the display is just another hub subscriber.** Control PWA
  → clips → Python `ClipDecoder` → hub emits finals → hub fans out over WS → the
  native fullscreen window *and* any LAN browser/OBS render the same feed. No new
  mechanism; reuses the existing `packages/display` render surface + hub-subscribe
  path. (Pure-cloud PWA keeps its BroadcastChannel `display.html`; the
  desktop/LAN case uses the hub WS — two delivery paths for one render surface.)
- **Retire only the bespoke desktop `/control` panel** (the `packages/display`
  control surface) in favor of the PWA operator UI — the unification payoff that
  closes the PWA↔desktop parity-drift problem (`AUDIT-pwa-vs-desktop.md`) by
  construction. The `packages/display` **output** surface is retained.
- **Note — background-tab throttling:** browsers throttle background tabs, but
  the AudioWorklet runs on the audio thread so capture keeps going; keeping
  control in the foreground tab (above) is the mitigation. Watch UI timers/render
  under backgrounding.
- Mic selection moves browser-side (getUserMedia device picker + existing VU
  meter). Python `sounddevice` capture is retained behind a flag for
  headless/hi-fi/appliance modes only.

---

## Workstream 2 — Archive / replay (after the pivot foundation)

Layered on the unified browser frontend, so it works for **both** cloud and
desktop with one implementation. **Privacy constraint (hard):** recording is
always tied to a live **room** session AND gated behind an explicit **opt-in
checkbox**. Normal/local transcription is never recorded; no room ⇒ no record
option.

- **Capture:** `MediaRecorder` (Opus) tee off the *same* getUserMedia stream the
  ASR path uses — one source, one clock, so transcript timings and audio align
  for free (the browser realization of P1's "single-stream tee, one clock").
  Fork before/independent of the ASR downsample so the archive gets the good
  48 kHz. Chunked upload during the session.
- **R2 + Worker:** add an `r2_buckets` binding to `wrangler.v2.jsonc` (alongside
  the `ROOM` DO) and `/api/archive/*` routes in `worker/v2.ts` — PUT to store
  (keyed by room/session id), GET to serve **with HTTP Range** for seeking.
  Mirror podcast-studio's token-keyed blob API + short R2 TTL.
- **Transcript artifact:** on Stop, store the finals JSON (from `ViewerLog` /
  the room `history`) alongside the Opus, keyed by the same session id.
- **Replay viewer:** new surface reusing `ViewerLog` + `joinSegments` render.
  Net-new: an `<audio src=R2>` element, click-line → `audio.currentTime =
  seg.start`, and `timeupdate`-driven word karaoke against `words[].start/end`.
  New `ReplaySource` loads the stored transcript (not a live `WebSocketSource`).
- **Precedent to reuse:** `packages/pwa/src/fileHandle.ts` (IDB handle +
  feature-detected FS-Access fallback) if a local copy is also wanted.

Later (deferred, not a blocker): a browser-side **offline re-transcribe** pass
over the archived Opus for sharpened word timings — the browser equivalent of
the deferred desktop WhisperX P2, via WebGPU transformers.js (**not** WASM
SIMD — Caption Guru must not re-add COOP/COEP; the `/hf` proxy path forbids it).

---

## Cross-cutting decisions / notes

- **getUserMedia processing:** capture currently forces `echoCancellation`,
  `noiseSuppression`, `autoGainControl` = **true** (`captioner.ts:122-130`).
  For captioning + archive quality these should be configurable and default to
  off (podcast-studio captures raw). Small change; do it in P0/P1.
- **PROTOCOL_VERSION bump** only for the small JSON control additions
  (backend/refine markers, model advertisement). Audio stays a binary
  side-channel outside the typed protocol. Keep TS Zod ↔ Python pydantic in
  lockstep as always.
- **One socket, discriminated** (text = control/captions, bytes = audio) rather
  than a second WS — simpler lifecycle, one reconnect path.
- **podcast-studio** (`~/podcast-studio`) is validated prior art for the
  capture/fork/R2 plumbing only. Do **not** share its transcription code — it
  uses WASM SIMD + COOP/COEP/SharedArrayBuffer, which this project forbids.
  Different niche (max-quality distributed recording vs low-latency live
  captioning); no product convergence now.

## Sequencing summary

```
P0  AsrBackend seam (PWA refactor, no behavior change)        ← start here
P1  Backend selection + LocalWsBackend (PWA)
P2  Python ClipDecoder + binary WS ingest
P3  Desktop = Python + PWA on localhost; retire /control panel
--- pivot foundation complete ---
W2  Archive/replay (browser Opus → R2 → replay viewer)
```
