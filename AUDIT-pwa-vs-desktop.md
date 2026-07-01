# Caption Guru — PWA ↔ Desktop Parity Audit

**Date:** 2026-07-01
**Scope:** Full cross-implementation audit of the browser/PWA captioner (TypeScript/Svelte, `packages/`) vs the native desktop captioner (Python, `desktop/captions_desktop/`), which share `packages/protocol`.
**Method:** Four parallel code audits — protocol & shared logic, ASR engine pipeline, audience room/publishing, operator UI — each comparing both directions with `file:line` evidence.

> **How to read this.** Section A is **correctness bugs** — divergences that produce wrong output or lost data today. Section B is **capability gaps** — a feature present on one side and absent on the other, much of it intentional. Section C is what's **at parity**. Section D is a suggested action list.

---

## Resolution status (updated 2026-07-01)

**All of Section A (A1–A7) is now fixed** on `v2-audience-layer`. Typecheck clean; unit tests green (Python 58→70, TS display 24→27). Not yet live-verified end-to-end via a BlackHole session — the room config/re-seed path and the desktop gate/collapse should be exercised in a real session before relying on them.

| Bug | Resolution | Key files |
|---|---|---|
| A1 | Config `$effect` now tees `config` to the `RoomPublisher`, not just the on-air channel | `Control.svelte` |
| A2 | `RoomPublisher` gained a `seed` provider sent on every (re)connect; `Control.svelte` supplies config + full history | `roomPublisher.ts`, `Control.svelte` |
| A3 | Ported `joinSegments` → `render.py`; exports render joined lines | `render.py`, `export.py` |
| A4 | Ported the peak-RMS / min-duration no-speech gate; `_decode` drops silence | `sanitize.py`, `streaming.py` |
| A5 | Desktop no longer collapses at source — emits raw; **all** render surfaces collapse at display time (incl. the live partial), so `keep_repeats` is meaningful and the operator sees the loop | `streaming.py`, `captionStore.svelte.ts`, `Viewer.svelte` |
| A6 | Added Zod-matching numeric bounds to the Python config models | `protocol.py` |
| A7 | `start()` catch now publishes the error `status` to the room | `Control.svelte` |

### Section B — capability gaps: progress

**Desktop-only → ported to PWA:** Uppercase toggle, Clear button, model download retry/backoff. Left desktop-only **by design** (genuine browser/hardware limits): two-tier refinement, real word-probability confidence, runtime model hot-swap, and the larger/custom-repo model options.

**PWA-only → ported to the desktop `/control` panel:** auto-height caption box, transcript export buttons (TXT/SRT/VTT), live-apply dictionary + usage help, state-based Start/Stop/Clear disabling. N/A on desktop by nature: open-display button (native window), in-browser download bar + per-model dtype (server-side only).

**✅ CLOSED (2026-07-01) — the last audit item, shipped with the QR-overlay redesign (protocol v8):**
- **Desktop runtime audience-room controls** — Start/Stop/Restart room, live QR overlay toggle, downloadable QR PNG. No longer CLI-launch-flags only: a new `roomControl` client message (`start`/`stop`/`restart` + QR overrides) drives a server-side `RoomManager` (`desktop/captions_desktop/rooms.py`) that mints a room, swaps the `RoomPublisher`, sets the hub QR config, and writes the QR slide PNG (`--qr-png-path`, segno) at runtime. Controls now live in the desktop `/control` panel (`ControlPanel.svelte`). **All Section-B parity gaps are now closed or intentionally left by-design.**

**Also noted (not a bug):** both sides are effectively English-only — multilingual is a future feature, not drift.

The protocol has since advanced to **v7** (added the `presence` audience device-count message); still lockstep TS ↔ Python. Section C (parity) holds. Section D horizons remain future work. The findings below are preserved as the original audit record.

---

## TL;DR

- **Protocol is in lockstep.** `PROTOCOL_VERSION = 6` on both sides; every message and every `CaptionSegment`/`Word` field matches. No wire-format drift.
- **The operator correction UI is byte-identical** on both sides (same Svelte component), so the hands-on correction experience is at full parity.
- **Four real bugs** cluster in the v2 audience layer and in desktop export/hallucination handling — see Section A. Two of them silently degrade the live audience experience for PWA-hosted rooms.
- **Most capability gaps are by design** (in-browser vs native constraints): refinement, real word confidence, and the rich model picker are desktop-only; the audience *viewer* is browser-only.

---

## A. Correctness bugs / behavioral divergences

Ranked by user impact. These are defects, not design choices.

### A1 — PWA-hosted rooms never send the audience any display config
**Severity: High · Direction: PWA broken, desktop correct**

The PWA pushes display config only to the on-air `BroadcastChannel`, never to the `RoomPublisher` (`packages/pwa/src/Control.svelte:224-228`, `:259-261`). The Durable Object's `latestConfig` therefore stays `null`, and `sendInitialState` sends no `config` to subscribers (`packages/room/src/index.ts` → `room.ts:206`). Result: colors, font, caption box, and chroma settings the operator chose are **ignored by every audience viewer** on a PWA-hosted room. The desktop publisher *does* tee config (via `hub.set_config`), so desktop-hosted rooms are styled correctly.

This directly undercuts the v2 "display look controls reach the audience" feature for the PWA path.

### A2 — PWA "Start room" mid-session loses the prior transcript; no re-seed after DO state loss
**Severity: High · Direction: PWA broken, desktop correct**

`RoomPublisher` on (re)connect only flushes its offline queue of messages produced *while it was down* (`packages/pwa/src/roomPublisher.ts:52-65`). It never replays `store.finals` or config. Consequences:
1. Pressing **Start room** after captioning has begun publishes only *new* finals — audience history starts mid-talk.
2. The DO's log is an in-memory `Map` (only the publish token is persisted); if it's lost or hibernated-empty, the PWA cannot restore it.

The desktop re-seeds fully on every (re)connect via `snapshot_for_new_client()` (`room_publisher.py:66-68`, `hub.py:131-136`) = config + full history, ingested lock-aware by the DO without rebroadcast.

### A3 — Desktop exports ignore `join_next`, so desktop SRT/VTT/TXT diverge from the PWA
**Severity: Medium · Direction: desktop broken, PWA correct**

Python has no port of `joinSegments`. `export.py:11-23` iterates raw per-segment, emitting every segment as its own line / SRT block / VTT cue regardless of merge state. The TS exports run through `joinSegments` (`packages/protocol/src/export.ts:10-25`), honoring `joinNext` (context-aware punctuation), `keepRepeats`, and render-time repetition collapse. For any transcript where a segment has `joinNext` set, the two implementations produce **different line counts, SRT indices, and cue timings**. `join_next` is stored and rebroadcast on the desktop but never rendered by any Python path.

### A4 — Desktop has no pre-decode no-speech gate → more silence hallucinations
**Severity: Medium · Direction: desktop weaker, PWA stronger**

The PWA gates every decode on peak-RMS + minimum duration before running Whisper (`packages/pwa/src/engine/sanitize.ts:26-84`; thresholds `MIN_PEAK_RMS=0.012`, `MIN_SPEECH_MS=250`; tunable via `?minrms` / `?minms`). This is its primary defense against phantom captions ("Thank you", "warning") on silence. The desktop has **no equivalent** — `streaming.py:325-341` decodes every VAD-endpointed utterance and relies solely on energy-VAD endpointing plus post-decode `is_degenerate` / `collapse_repeats`. On quiet input the desktop is more prone to phantom finals.

### A5 — Repetition collapse runs at different stages; `keep_repeats` is inert on desktop
**Severity: Low–Medium · Direction: asymmetric**

The collapse algorithm is a faithful shared port (`packages/protocol/src/index.ts:144-212` ↔ `desktop/captions_desktop/sanitize.py:35-73`), but it runs at different points:
- **Desktop collapses at the source** before emit (`streaming.py:341`), so history, room relay, export, and word arrays are all clean. But because the stored text is already collapsed, `keep_repeats` cannot restore a genuine repeat — the field is relayed but **never consulted by any Python render/export path**.
- **PWA collapses at render time** only (`index.ts:234-235`, honoring `keepRepeats`). The stored/published segment retains the raw loop text and word timings; the user sees it collapsed because all PWA surfaces render through `joinSegments`.

Net effects: PWA persists raw loop data (word timings included); desktop cannot honor `keep_repeats`.

### A6 — Desktop `setConfig.config` is an unvalidated dict
**Severity: Low · Direction: desktop weaker**

`protocol.py:229` types the payload as a raw `dict` with no `extra=forbid` and no numeric bounds. The TS side validates via `DisplayConfigSchema.partial()` and enforces ranges (`fontSize` positive, `fontWeight` 100–900, region/QR 0–100 — `index.ts:311-334`). Malformed or out-of-range config the PWA rejects, the desktop silently accepts.

### A7 — PWA error status is never teed to the room
**Severity: Low · Direction: PWA gap**

The PWA catch path applies errors locally via `store.apply(...)` rather than the room `sink` (`Control.svelte:435-438`), so an error `status` never reaches audience subscribers.

---

## B. Capability gaps (feature parity)

### Desktop-only — PWA lacks (mostly by design)
| Capability | Evidence | Note |
|---|---|---|
| Two-tier background refinement (same-id lock-aware upsert) | `refine.py`, `hub.py:94-100` | Hardware/roadmap-gated; no browser analog |
| Real `word.probability` confidence on every segment | `faster_whisper.py:108`, `mlx.py:130` | PWA uses a speaking-rate *heuristic*, finals-only, that can degrade to no word data when an ONNX export lacks alignment heads (`asr.worker.ts:170`) |
| Rich model picker: medium.en / large-v3 / custom HF repo, separate refine picker + Refine=Off, runtime hot-swap | `ControlPanel.svelte:74,241-259`, `streaming.py:157-181` | PWA has a curated 3-model list, large-v3-turbo gated behind `?experimental=1` |
| Download retry / resume / backoff | `engines/base.py:20-47` | PWA load just errors on failure |
| Uppercase toggle | `ControlPanel.svelte:327` | UI |
| Explicit Clear button | `ControlPanel.svelte:230` | UI |

### PWA-only — desktop lacks
| Capability | Evidence | Note |
|---|---|---|
| **Runtime audience-room management** — Start/Stop room, live QR overlay toggle, downloadable full-screen QR PNG | `Control.svelte:248-284,631-656` | **Biggest desktop-operator gap.** On desktop these exist only as launch-time CLI flags (`--start-room`, `--viewer-base`, `--caption-region`); the `/control` panel exposes none |
| Auto-height caption box (lines × font size) | `Control.svelte:588-596` | Desktop panel only has raw height % (`ControlPanel.svelte:343`) |
| Transcript export buttons (TXT/SRT/VTT) | `Control.svelte:726-731` | Not in the desktop panel |
| Open-display button | `Control.svelte:627` | Desktop display is the native output window |
| In-browser model download progress bar | `Control.svelte:343-393` | Native downloads are server-side |
| Dictionary: live-apply on keystroke + usage explainer | `Control.svelte:329-331,693-724` | Desktop requires an "Apply" button, no help text |
| State-based disabling of Start/Stop | `Control.svelte:622-626` | Desktop Start/Stop/Clear are always enabled |
| Per-model dtype + WebGPU→wasm fallback | `asr.worker.ts:24-28` | No meaning server-side |

### Important reconciliation — operator corrections are NOT a gap
The Python *package* has no correction/suggestion logic, but the desktop **operator UI is the same Svelte panel**, and its `Corrections.svelte` is **byte-for-byte identical** to the PWA's, importing the shared `suggest.ts` / `correct.ts`. So the hands-on correction experience — Double-Metaphone sound-alike picker, free-typed override, suppress, one-step undo, low-confidence highlight, join-boundary toggle, repetition delete/keep-all — is at **full parity**. The only genuine Python-side gap is *headless/programmatic* correction: the Python backend can apply an `editSegment` it receives but cannot originate one.

---

## C. At parity / equivalent

- **Protocol:** `PROTOCOL_VERSION = 6` both sides; all `CaptionSegment`/`Word` fields and all client/server messages match. No `extra=forbid` violations.
- **Operator correction UI:** identical component (see reconciliation above).
- **Energy VAD:** `vad.ts` ↔ `vad.py` are a faithful port — identical constants (noise floor init 0.005, margin 2.5, startMs 120, endMs 600) and identical endpointing behavior.
- **Degenerate/symbol-spam filter:** `sanitize.ts` `isDegenerate` ↔ `sanitize.py` `is_degenerate` — identical 6-char / 0.4-ratio thresholds.
- **Core look controls:** background/chroma/text colors, font family/size/weight/justification, orientation, box fill, rounded corners, region X/Y/W/H, show-live toggle — present on both panels.
- **Export formats:** both produce TXT/SRT/VTT (neither produces word-level JSON export). *Content* diverges per A3.
- **Multilingual:** both effectively English-only. Desktop has `language` plumbed to the engine (`engines/__init__.py:37-41`) but unexposed by CLI/panel; PWA hardcodes `en` in the worker with no plumbing.

---

## D. Suggested actions

**Fix (real bugs):**
1. **A1 — PWA config-to-room.** Tee display config to the `RoomPublisher`, not just the `BroadcastChannel`. Highest impact: it silently breaks audience styling for PWA rooms today.
2. **A2 — PWA room re-seed.** On Start room / reconnect, replay `store.finals` + config so late audiences and post-hibernation DOs get full history.
3. **A3 — Desktop `join_next` in exports.** Port `joinSegments` to Python (or route exports through it) so desktop SRT/VTT/TXT match the PWA. Exports are a stated v2 deliverable.
4. **A4 — Desktop no-speech gate.** Port the peak-RMS / min-duration gate from `sanitize.ts` to the Python decode path; directly extends the hallucination-suppression work already done.

**Consider (parity, not by-design):**
5. **Desktop room controls in `/control`** (Section B) — Start/Stop room, QR overlay, QR PNG — closes the biggest desktop-operator hole and removes reliance on launch-time CLI flags.
6. **A5/A6** — decide whether desktop should honor `keep_repeats` at render (requires moving collapse to render time) and add `extra=forbid` + range validation to the Python config model.

**Leave as-is (intentional):** two-tier refinement, real word confidence, the rich model picker, and the browser-only audience viewer reflect genuine native-vs-browser constraints, not accidental drift.

---

*Generated from a four-agent parallel code audit. Every claim is backed by a `file:line` citation in the sections above.*
