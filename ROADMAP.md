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
- **⭐ NEXT — Unified model manager (both platforms)** — decouple **managing** models
  (install / verify / remove) from **selecting** a running model. This collapses a whole
  class of picker problems (download-during-switch, "loading" states, a dropdown that lies)
  by construction: the **live + refine selection dropdowns only ever contain models that are
  installed AND smoke-tested as spinnable**, so switching is always instant and never fails
  on a download. A fresh install starts with **empty dropdowns**; models appear only after a
  successful install+verify. The list is an **app-maintained registry**, cached + rehydrated
  on app start / page refresh (not runtime-probed).
  - **"Installed" = downloaded AND loaded AND passed a trivial decode** (reuse the warmup —
    1s of zeros, `streaming.py:203`). Only then does a model enter the registry + dropdowns;
    this is the gate that catches "downloaded but won't spin up."
  - **Content-addressed model store (integrity + portability).** Store weights **by hash, not
    by name** — `(name, backend) → manifest {path: sha256} → blobs`, keyed by a merkle-root
    "version hash"; the friendly name is a mutable pointer (`small.en → hash → bits`). **Hash
    only on ingest** (download or import-after-export), never per load: verify each blob's
    SHA-256 against HuggingFace's published **Git-LFS `oid`** (fetch via
    `model_info(files_metadata=True)`; browser side re-hashes with `crypto.subtle.digest`),
    write to a temp path, and **atomically commit under the hash only on match** — corrupt or
    partial bytes never become a committed model. This makes the install gate **three
    orthogonal checks: hash-verified (right bytes) → loads → smoke-decodes (actually works)** —
    hash catches silent corruption that still loads but decodes garbage; smoke-test catches
    right-bytes/wrong-format. An upstream re-upload changes the hash → repoint the name +
    **GC the now-unreferenced blobs**, or keep them **pinned as legacy** for reproducibility
    (an upstream re-upload can't silently change a pinned model's output). Gives free **dedup**
    (identical files — e.g. a shared `tokenizer.json` — hash once) and is the safety layer that
    makes **export/import portability + offline / live-USB model-bundling** trustworthy (verify
    a copied cache before trusting it). HF's own cache is already content-addressed
    (`blobs/<sha>` + `refs/` + `snapshots/`), so this mostly **adds a verify-on-ingest gate + a
    friendly-name registry + a GC/pin policy** on top rather than reinventing the store.
  - **Browser byte-level download resume.** The PWA today resumes only at **file**
    granularity (transformers.js caches completed files in Cache Storage; a file
    interrupted mid-download restarts from byte 0), unlike desktop huggingface_hub's
    true `.incomplete` + HTTP-`Range` resume. Byte-level browser resume needs a
    **service worker intercepting `/hf`** to issue `Range` requests + cache partials,
    plus the `/hf` proxy forwarding `Content-Length`/`Accept-Ranges` and honouring
    `Range` (it currently drops `Content-Length` — same reason there's no download %).
    Matters for big blobs (large-v3-turbo) on flaky venue wifi; small models are fine on
    file-level resume. Lives in this download layer next to verify-on-ingest.
  - **A "Models" area** (Available catalog vs Installed set, with size + Remove) is where ALL
    download progress + failure feedback lives — off the live-captioning path entirely. This
    is where release users get the feedback they currently only see in the terminal.
  - **Same UI on PWA + desktop, different guts** (the codebase's existing pattern — cf. the
    shared `Corrections.svelte`; realizes the [[native-config-mode]] "PWA-identical layout"
    goal). A shared **`ModelsPanel.svelte`** (`packages/display`) + shared types in
    `packages/protocol` (`InstalledModel` / `AvailableModel` / `InstallProgress` / catalog),
    over a common **`ModelManager` interface** with two impls: **PWA** = fetch+cache via the
    `/hf` proxy, smoke-test in the ASR worker, registry in browser storage (reuses the
    existing PWA download-progress UI); **desktop** = HF download + smoke-test via a transient
    engine, disk registry, driven over the control WS (`installModel`/`removeModel`/
    `requestModels`, protocol **v11+** — v10 is now the ASR clip-decode bump). The caching
    mechanism (CTranslate2 / MLX / ONNX) is
    fully abstracted from the user.
  - **Three places the abstraction legitimately leaks — the same UI must handle honestly:**
    (1) **practicality differs** — `small.en` is the sane in-browser ceiling, `large-v3` is
    fine on desktop but impractical in a browser → the catalog carries per-platform metadata
    (`recommended` / `experimental-slow` / `unavailable-here`) so the identical UI shows the
    right options + warnings; (2) **refine is desktop-only today** (the PWA refine path is the
    sherpa-onnx idea) → the shared component degrades gracefully, hiding the refine picker on
    PWA; (3) **custom HF repo can't be format-abstracted** (desktop wants CTranslate2/MLX, PWA
    wants ONNX) → the smoke-test gate catches a mismatch and shows a clear "not in a
    browser-compatible format" message (presets hide format entirely; custom is the one spot
    the user meets it, and only on failure).
  - **Edge cases to design for:** onboarding **empty-state** (fresh install = blank dropdowns
    = "install your first model", one-click *Install small.en*); the **CLI `--model` flag
    auto-installs+verifies** on launch so CLI and registry stay consistent; **"installed" is
    per-backend** (same name, different artifact per engine — MLX vs faster-whisper vs GGML);
    **smoke-testing a big model on constrained HW** (8 GB) may need to run only when idle /
    serialized to avoid OOM; **remove-while-running guard**; **registry reconciliation** on
    start (drop entries whose cache was deleted out from under it). Custom repo becomes an
    *Install* action — which elegantly retires the old "custom repo can't auto-apply" problem.
  - **Umbrella:** this front-runs *Native config screen — model management* and *Model cache:
    persist + portability* below, and is the flagged **next major iteration after v0.2.0-beta**.
- **Live translation → per-language rooms (Workers AI)** — the id scheme already reserves
  `:lang`. Translate **finalized caption text** at the CaptionRoom DO via **Cloudflare
  Workers AI** (m2m100 / an LLM, co-located with the DO → low latency, no egress) and fan
  the result out to `:fr`/`:es`/… rooms. **On-mission for cloud AI:** it operates on the
  *captions* — text that's *already* in the room — so it adds **no** audio-privacy cost
  (unlike running ASR/refine in the cloud, which stays on-device by design). Optional/tiered
  and clearly labelled ("captions sent to Cloudflare for translation"). Translate on finals
  only; the audience viewer / exports honour the same join/render pipeline per language.
- **AI moderator — semantic error flagging (human-in-the-loop, cloud, text-only)** — an LLM
  "set of eyes" subscribed to a room's caption feed that flags **context errors Whisper
  can't**, because Whisper's confidence is *acoustic* while these errors are *semantic* — it
  decodes a real-but-wrong word *confidently* ("atropine"↔"Atrovent", anatomy homophones,
  mangled drug names), so the existing low-confidence highlight never catches them. The two
  signals are **orthogonal**: acoustic uncertainty (Whisper) + semantic implausibility (LLM).
  Design: (1) **advisory only** — it *suggests* into the existing correction UI
  ([[correction-ui-tap-transferable]] `Corrections.svelte`), a human accepts/rejects, or it
  counts as one vote in the trusted-viewer quorum ([[moderator-consensus-correction]]); never
  auto-commits (LLMs hallucinate — critical for medical/legal). (2) **Event profile primes
  it** — reuse the **custom dictionary** (drug/speaker/jargon terms) + a domain hint ("this is
  a cardiology conference; agenda/speakers…") so it applies real anatomy/pharma knowledge.
  (3) **Windowed context** — feed a rolling transcript window (not single segments) so it
  judges plausibility from discourse (ties to the longer-context refinement idea). (4)
  **Text-only, already-cloud** — watches the room feed, so no new audio-privacy surface;
  runs next to the DO via Workers AI, or a stronger model via AI Gateway for hard domain
  reasoning (cost/latency vs quality, tiered). Batched on finals, throttled. A true *agent*
  form (Cloudflare Agents SDK on a DO — persistent per-room memory of accepted corrections /
  speaker style) is the richer v3+ version.
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
- **Audio level / VU meter in both control panels (UX)** — a signal indicator so the
  operator can confirm the mic is actually feeding audio, and see when it's **too quiet**
  (optionally **clipping**), instead of guessing why captions are sparse (usually a wrong
  device / dead loopback / muted input). **Web (PWA): trivial** — the `Captioner`'s
  AudioContext + `pcm-worklet` already run in the *same context* as `Control.svelte`;
  compute per-frame RMS/peak (dBFS), expose a reactive level, render a meter, and tie the
  "too quiet" warning to the VAD's min-RMS gate (level is basically already computed in the
  VAD path). **Desktop: needs a relay** — audio is captured server-side in `LiveStreamer`,
  so the level must reach the `/control` browser panel via a **low-rate (~10–20 Hz) level
  message over the existing `/ws`** (SSE unnecessary — WS is already there). **Design
  caution:** the hub's normal broadcast is teed to the audience room by `room_publisher`,
  so audio-level frames must **NOT** ride that path (pointless cloud bandwidth + reaches
  displays that don't need it) — send them on a **control-only side channel** or a message
  type the publisher filters out. Reuse the RMS the VAD already computes; keep it cheap.
- **Unifying UX audit — consolidate the ad-hoc controls (both platforms)** — the current
  iteration is **deliberately functionality-first** (each new capability lands as its own
  control), which is the right call while features drive the work; but the two panels
  (`Control.svelte` PWA + `ControlPanel.svelte` desktop) are accreting one-off inputs and
  will eventually feel busy. **Task a dedicated agent to audit both surfaces** and propose a
  coherent, simpler information architecture: group + rank controls by frequency of use,
  kill redundancy, **unify labels/patterns across PWA↔desktop**, and — the high-leverage
  part — flag controls that a **direct-manipulation gesture** could replace. **Flagship
  example: drag-to-place on the on-air output** — let the operator move/resize the
  **caption box** and the **QR overlay** directly with the mouse (drag handles on the
  display surface / a live preview), writing back to `DisplayConfig.region` / `qr`. That one
  interaction **collapses the numeric X/Y/W/H + QR X/Y/size inputs** (and their PWA/desktop
  duplicates) into a single gesture — the model case for "make the accreted controls feel
  organic." Deliverable = a **prioritized findings doc + a target IA**, not a big-bang
  rewrite; sequence the simplifications behind ongoing feature work. Relates to the operator-
  editor parity + VU-meter items above and reuses the shared `packages/display` surface.
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
  **→ SCOPED 2026-07-01 (`SPIKE-sherpa-onnx.md`): recommendation GO on a ~4-day POC.**
  The COOP/COEP risk resolves in our favor — sherpa-onnx's offline VAD+ASR WASM build
  is **single-threaded + SIMD, no `-pthread`/SharedArrayBuffer** (verified in
  `build-wasm-simd-vad-asr.sh`), so it coexists with the no-cross-origin-isolation
  setup. Integration is small (protocol already has lock-aware same-id upsert; hook at
  `captioner.ts:finishUtterance()`, mirror `asr.worker.ts`). Refine-model candidate:
  **SenseVoice-Small int8** (~229 MB, ~5.5% WER). Residual risk is single-thread WASM
  **perf on phones** (the POC must measure RTF); fallback = laptop/desktop opt-in `?refine=1`.
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
  **Persist at origin scope** (caption.guru localStorage/IndexedDB) under a single
  global key — NOT per-room — so a viewer's preference follows them across rooms in
  a multi-room venue (same origin ⇒ shared storage; every `/room?<id>` is same-
  origin) and is auto-applied on join. Reuse the existing `cg.*` look-key pattern.
- **Admin: room registry + usage stats** (later; not general-use) — a token-gated
  **admin page** to audit activity and see usage: active rooms, device counts,
  session start/stop times and durations, rooms-created-over-time. Enabler: a
  **registry** the rooms write to, since Durable Objects can't be enumerated (no
  native `list()`; the dashboard only shows aggregate namespace metrics). A single
  directory DO (or KV/D1 index) that each room registers with on `/r/new` and
  updates on presence change; the **stale-room reap alarm removes its entry**, so
  the index stays truthful. Shares the enabler with "Room session management" above
  and would surface the connected-device count (already emitted) historically.
- **Room DO efficiency (LOW priority)** — cost/scale trims for the audience-room
  Durable Object, none needed until thousands of concurrent rooms (see
  `docs/scaling-cost.md` for the full model). (1) write `idleSince` only on the
  active→empty transition, not every 60s alarm tick (rewrites the same value now);
  (2) slower/lazy prune (`PRUNE_INTERVAL_MS` 60s → ~5 min) so `setAlarm` writes less
  often; (3) **throttle the partials relayed to the cloud room** — the on-air local
  display needs every partial, but the audience could get finals + occasional
  partials (cuts the incoming-WS-message meter + bandwidth). NOT a "flag cache DO"
  (it evicts too; `state.storage` is already the durable cache — see the doc).
- **Auth + billing (Clerk on Workers + DO) — the paid-features enabler** — adopt the
  podrecorder.net approach (reference playbook copied verbatim to
  `docs/clerk-integration.md`): the client loads `@clerk/clerk-js` (social sign-in) and
  attaches the Clerk **session JWT** as `Authorization: Bearer …` on gated requests; the
  Worker verifies it with `@clerk/backend` and checks entitlement via `auth.has({ plan })`.
  **No database, no Stripe webhook, no `customer` table** — Clerk Billing (Stripe under the
  hood) carries the entitlement in the verified session. A single **`AUTH_MODE` flag
  (`off` / `prelaunch` / `live`)** phases the launch: `off` = today's free product,
  `prelaunch` = **sign-in alone unlocks every gated feature** (exercise the paid paths with
  zero payments), `live` = the paid plan is the gate. Maps cleanly onto our stack:
  - **Entitlement rides the `CaptionRoom` DO** — the operator authenticates at `/r/new`; an
    entitled operator flips the room DO `entitled=true` and the audience **inherits** it
    (viewers never sign in). Same shape as podrecorder's per-room flag, on top of the existing
    publish-token model.
  - **First gated resources = the cost-incurring cloud endpoints** — Workstream-2 **R2
    archive/replay** (`/api/archive/*`) is the natural first `requirePro` gate, then per-room
    retention beyond the free tier, [[domain-offering]] custom hostnames, and the
    venue/[[geofenced-viewer]] tier.
  - **The free/paid line is already the pivot's architecture:** **on-device (WebGPU) +
    desktop-localhost ASR stay free / self-hosted** (no auth); **cloud room + archive + venue
    features are the paid surface.** The ASR-backend selector and `AUTH_MODE` compose — nobody
    captioning locally ever meets a login.
  - **Two playbook constraints that touch our design now:** (1) **COOP/COEP breaks Clerk's
    OAuth popup** (`same-origin` strips `window.opener`) — this *reinforces* our standing
    "never re-add COOP/COEP" invariant (same-origin `/hf` proxy + single-threaded WebGPU);
    sign-in works precisely **because** we don't set those headers (and the sherpa-onnx spike
    must stay single-threaded for the same reason). (2) **No DO→DO `fetch` inside a
    WebSocket-upgrade handler** ("Network connection lost") — so the room entitlement check
    must run in the **plain Worker request context, before the 101 upgrade** (in the
    `packages/room` router), not inside the DO's WS handler.
  - Business notes: Clerk Billing is **public beta + 0.7%/txn** on top of standard Stripe fees;
    the **publishable key is public** (commit-safe), the **secret key is not** (rides the
    existing gitignored-secrets pattern). Ties to [[release-channels]] (flip `prelaunch → live`
    at the apex cutover).
  - **Desktop download = soft gate + runtime version negotiation (DECIDED 2026-07-02).**
    **Primary rationale is UX coherence, not licensing:** post-pivot the desktop app is a
    **headless ASR backend that is useless without the PWA frontend** — someone who runs the
    bare binary gets a silent localhost server and thinks it's broken. Funneling the download
    **through the PWA** means they arrive already holding the frontend that drives it, which
    reduces the "tried to run the Python app standalone" support burden. (Gating/licensing is
    a *secondary*, revisitable benefit.) A free Clerk sign-in fronts the funnel and the PWA
    serves the **correct-platform artifact**; keep the **public GitHub Releases** (M8 upgrade
    path) and have the PWA only *surface* the link when signed in — near-zero infra, preserves
    the local/offline privacy story. **NOT a hard gate now** (no R2-proxied authenticated
    downloads / private releases); revisit only when licensing/revocation actually needs it.
    Independently, **build runtime version negotiation regardless**: post-pivot the desktop
    reports its version over the **localhost WS** → the PWA compares to the latest and
    prompts/deep-links the right upgrade (the true "right version" fix; pivot-native, ~no new
    infra). Runtime **pro**-gating stays the Clerk session `has({plan})` check — independent
    of how the app was obtained (the free download funnel is about distribution, not pro
    entitlement, which is already handled cloud-side).
- **Distribution** — macOS notarization + Windows signing, auto-update.
- **Output reach** — NDI, display themes, RTL / non-Latin fonts.
- **Captioner → OBS browser link** — a way for the browser-based captioner (PWA) to
  feed captions directly into an **OBS Browser Source**. The catch: OBS embeds its own
  CEF browser, a **separate browser context** from the operator's browser, so
  `BroadcastChannel` (same-origin, same-browser only) can't bridge them — need a real
  transport. Options: **WebRTC data channel** (peer-to-peer, low latency, ideal for a
  local same-machine captioner↔OBS pairing) **with a WebSocket fallback via a Durable
  Object** (the DO also does WebRTC signaling; falls back to relaying when P2P can't
  connect). Note the existing `CaptionRoom` DO already offers a WS publish/subscribe
  path — an OBS source pointed at a room display URL technically works today; this item
  is the lighter/lower-latency **direct pairing** (a "connect to OBS" browser link) that
  favors WebRTC locally and only leans on the cloud DO for signaling/fallback. Reuses
  the shared `packages/display` on-air surface as the OBS-side page.
- **GGML / whisper.cpp desktop backend (LOW PRIORITY)** — a third `ASREngine`
  (alongside faster-whisper/CTranslate2 + MLX) wrapping whisper.cpp/GGML, to reach
  GPUs the current stack can't. **The two structural GPU gaps today:** (1) any Mac
  GPU that isn't Apple Silicon — i.e. **Intel Macs** (AMD Radeon / Intel iGPU, Metal-
  capable but MLX is Apple-Silicon-only and CTranslate2's only GPU path is CUDA), and
  (2) **any non-NVIDIA GPU on Windows/Linux** (AMD, integrated Intel) — CTranslate2 is
  CUDA-only, so those are CPU-bound too. GGML's many backends (Metal / Vulkan / ROCm /
  CUDA) close **both** with one engine; it's **additive only where we're CPU-bound**
  and **redundant on Apple Silicon (MLX) + NVIDIA (CTranslate2)**. The biggest non-
  redundant reach is actually **AMD GPUs on Windows/Linux** (more common than Intel
  Macs), not Intel Macs per se. **Win only matters for HEAVY models** — small.en is
  already fine on CPU; GPU moves large-v3/turbo from "too slow" to "usable." **Cost is
  in packaging, not code:** the `ASREngine` interface fits cleanly (~1–2 days of glue),
  but shipping GPU-enabled native libs is the real work (~4–7 days total) — the binding
  must be **built with the backend enabled** (PyPI wheels are often CPU-only), the
  Metal/Vulkan shaders bundled into the PyInstaller one-folder build, and **real GPU
  engagement verified** (silent CPU fallback is the failure mode); GPU paths are only
  testable on real hardware (headless CI has no GPU). One code backend = one build
  config **per GPU API per OS**, so the tax scales with how many you actually ship.
  Same single-GPU serialization concern as MLX (`_MLX_LOCK`) → refine still stays on
  CPU. **Decide first:** how many users are on AMD-GPU Win/Linux or Intel Macs AND want
  heavy models — if the base is mostly Apple Silicon + NVIDIA this is largely redundant.
  Desktop-native twin of the **sherpa-onnx spike** above (`SPIKE-sherpa-onnx.md`) — both
  add a non-CUDA/non-MLX accelerated engine; also informs the Intel-Mac keep-vs-sunset
  call (`RELEASE-macos-intel-manual.md`).
- **Chroma projection + QR** — chroma-key output with an operator-positioned/sized
  caption box (for lower-thirds keying); the QR may break out of the caption box, large
  enough to scan across an auditorium; a full-screen QR PNG is always downloadable for
  slides/other gear.
- **QR overlay — standalone, fully operator-controlled** — ✅ **DONE (2026-07-01, protocol v8).**
  Supersedes the old "chroma-only, auto-shown" behavior: explicit **on/off toggle** (no longer
  tied to chroma mode), displayable in **any** background mode (solid / transparent / chroma),
  freely **positioned and sized**, with an **editable message** (e.g. "Scan for live captions"),
  plus an **exclusive** toggle that **hides the captions while the QR is shown** (full-attention
  "scan now" moment). `QrOverlay` gained `enabled`/`label`/`exclusive` in lockstep (TS Zod ↔
  pydantic); controls live in both operator panels (`Control.svelte` + `ControlPanel.svelte`);
  the display (`App.svelte`) renders it independent of `background.kind`. Full-screen QR PNG
  still always downloadable, PLUS a **persistent PNG file** the app rewrites on every room
  start — **PWA** via the Chromium File System Access API (handle in IndexedDB,
  `packages/pwa/src/fileHandle.ts`), **desktop** via `--qr-png-path` (segno,
  `desktop/captions_desktop/qr_png.py`) — for an OBS/PowerPoint image source that auto-refreshes.
- **Desktop runtime audience-room controls** — ✅ **DONE (2026-07-01)**, closing the last
  parity-audit gap. New `roomControl` client message (`start`/`stop`/`restart` + QR overrides)
  + a server-side `RoomManager` (`desktop/captions_desktop/rooms.py`) that mints a room, swaps
  the `RoomPublisher`, sets the hub QR config, and writes the PNG at runtime — no longer
  CLI-launch-flags only. Start/Stop/Restart room + QR controls now in the desktop `/control`
  panel. **Absorbed the QR-overlay redesign's protocol + panel work (shipped together).**
- **Native config screen** — GUI for audio device, fonts, theming, **and ASR model**
  (default-model picker + download/manage models) instead of CLI-only flags; PWA-identical
  layout with settings portable PWA↔desktop both ways. (Model *picker* may land with v2;
  download/management is later.) Also a tunable **ASR window size** (latency ↔ context
  trade-off) surfaced as a friendly control.
- **Offline** — optional model-bundled builds for air-gapped venues.
- **Live-boot USB appliance (read-only)** — a bootable Linux image that turns any
  borrowed high-spec PC into a **stateless captioner appliance** without touching its
  hard drive: boot → kiosk-mode caption output on HDMI, **control remotely** via a
  browser (`serve --fullscreen --host 0.0.0.0`), reboot and it's gone. **Pure packaging
  target — the app is unchanged;** it's the Linux headless/kiosk mode delivered as a
  bootable `.iso`. Stack: a **glibc** live distro (Debian `live-build` — NOT musl/Alpine,
  which breaks the CTranslate2 manylinux wheels), squashfs + tmpfs overlay (inherently
  read-only/stateless), a `cage`/openbox kiosk, the **ASR model baked in** (pairs with the
  model-bundled Offline builds above), and a boot screen showing the control URL/QR (reuse
  the QR overlay). **Start CPU-only** (runs on any x86_64, no drivers; a high-spec box has
  the cores for small/medium on CPU); an NVIDIA/CUDA variant is a bigger, hardware-specific
  image. Pitch: no install, no traces, audio never leaves the box.
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
