# SPIKE: sherpa-onnx as a second in-browser ASR engine (WASM refinement pass)

**Status:** research / scoping only — no code changed.
**Date:** 2026-07-01
**Backlog source:** `ROADMAP.md` (Later § "Spike: sherpa-onnx as a second in-browser ASR engine")

## Goal

Evaluate [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (k2-fsa; Apache-2.0;
ONNX Runtime WASM build) as a **second, CPU/WASM ASR engine** that runs the
**two-tier refinement pass concurrently** with the existing WebGPU
transformers.js live pass. Thesis: because live runs on WebGPU and refine runs on
WASM/CPU threads, refine does not starve live — sidestepping the desktop MLX
single-GPU contention problem. Success would bring two-tier refinement (today
desktop-only, `refine.py`) to the PWA.

---

## 1. What sherpa-onnx offers in-browser

sherpa-onnx is a mature, actively maintained (latest release ~1.13.x as of
mid-2026), Apache-2.0 next-gen-Kaldi runtime over onnxruntime. It ships a
**first-class, maintained WebAssembly build** with a JS API, published on npm as
[`sherpa-onnx`](https://www.npmjs.com/package/sherpa-onnx) and with browser demos
hosted as Hugging Face Spaces. Browser deployment is an explicitly supported,
documented path — not a community afterthought.
Sources: [GitHub k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx),
[DeepWiki: WebAssembly Support](https://deepwiki.com/k2-fsa/sherpa-onnx/3.8-webassembly-support),
[DeepWiki: WebAssembly Deployment](https://deepwiki.com/k2-fsa/sherpa-onnx/6.3-webassembly-deployment).

**ASR models available in the WASM build** (from the repo's live Spaces / build
scripts):

| Model family | Mode | Notes |
|---|---|---|
| **Whisper** (tiny/base) | offline (VAD+ASR) | same family we already run; small sizes only are practical in WASM |
| **SenseVoice-Small** | offline | non-autoregressive, multilingual (50+ langs), ~229 MB int8; strong accuracy |
| **Moonshine** (tiny/base) | offline | English, designed for edge/live, fast |
| **Zipformer transducer** | streaming | real-time; the classic k2 model |
| **Paraformer** | streaming/offline | mainly CN/EN |
| **FireRedASR, GTCRN (enhancement)** | offline | recently added JS/WASM APIs |

There are separate build scripts per task, e.g.
[`build-wasm-simd-vad-asr.sh`](https://github.com/k2-fsa/sherpa-onnx/blob/master/build-wasm-simd-vad-asr.sh)
(offline VAD+ASR, the relevant one for a refinement pass) and streaming variants.

**Streaming vs offline:** for a **refinement pass on already-finalized
utterances**, we want the **offline (non-streaming) VAD+ASR** build — feed it a
whole finalized clip, get back one transcript. That maps cleanly onto the
existing "re-transcribe a final" model. Streaming (Zipformer) is not what this
spike needs.

**Model-size reality for the browser:** WASM inference is memory-heavy. Even
Whisper-base is ~140 MB compressed and 400 MB+ resident during inference
([Vibed Lab devlog](https://vibed-lab.com/blog/devlog-whisper-browser-wasm-experiment)).
SenseVoice-Small int8 is ~229 MB on disk
([sherpa SenseVoice pretrained](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)).
That is a second multi-hundred-MB download on top of the live model, and a second
resident model in RAM — a real cost to weigh for a phones-and-laptops audience.

---

## 2. Concurrency thesis + the COOP/COEP crux (the decisive question)

**The constraint.** This project deliberately does **not** set COOP/COEP headers.
Whisper models are loaded via a same-origin `/hf/*` proxy (Cloudflare Worker in
prod, Vite proxy in dev) precisely so we never need cross-origin isolation.
`DEPLOY.md:10-11` is explicit: *"do not re-add COOP/COEP"*. Re-adding them would
break the loading of any cross-origin embed and is the thing the whole `/hf`
proxy exists to avoid.

**Why that matters for WASM.** Multi-threaded WASM needs `SharedArrayBuffer`,
which browsers gate behind cross-origin isolation (COOP `same-origin` + COEP
`require-corp`). Firefox and Safari 15.2+ enforce this just like Chromium.
Sources: [web.dev COOP/COEP](https://web.dev/articles/coop-coep),
[LogRocket: SharedArrayBuffer + cross-origin isolation](https://blog.logrocket.com/understanding-sharedarraybuffer-and-cross-origin-isolation/).
So **if** sherpa-onnx's WASM ASR build required threads, this spike would be
dead on arrival under our no-COOP/COEP rule.

**The good news — it doesn't.** The offline VAD+ASR build script
[`build-wasm-simd-vad-asr.sh`](https://github.com/k2-fsa/sherpa-onnx/blob/master/build-wasm-simd-vad-asr.sh)
contains **no `-pthread` / `USE_PTHREADS` / `PROXY_TO_PTHREAD`** Emscripten flags.
It is a **single-threaded, SIMD** build. sherpa-onnx documents its WASM/Node path
as a single-threaded wrapper for exactly this browser-consistency reason.
Source: build-script inspection above; [DeepWiki WebAssembly & Node API](https://deepwiki.com/k2-fsa/sherpa-onnx/4.8-webassembly-and-node.js-api).

**Consequence — the thesis holds, with a nuance:**

- A single-threaded, SIMD-only WASM engine needs **no SharedArrayBuffer, no
  COOP/COEP**. It is compatible with our constraint. ✅ This is the single most
  important finding of the spike.
- Run it in its own **Web Worker**. It executes on a **CPU core** via WASM;
  the live pass executes on the **GPU** via WebGPU/transformers.js. Different
  compute units → genuine parallelism, which is the whole point.
- **Nuance (not a blocker):** single-threaded means the refine engine uses **one
  CPU core**, not many. It won't be as fast as a threaded native build, but it
  also won't fight the live pass for the GPU. It will lightly compete with the
  main thread / other workers for CPU, but a dedicated worker keeps the UI
  responsive. The ROADMAP already flagged this: *"measure single-threaded WASM
  perf."*
- SIMD is broadly available (Chrome/Edge/Firefox/Safari 16.4+), so the SIMD
  build is safe for the target audience; keep a non-SIMD fallback in mind for
  ancient devices.

**Verdict on the crux:** the COOP/COEP risk that could have killed this is
**avoidable** — use the single-threaded SIMD offline build, no headers required.
The residual question is *perf*, not *feasibility*. That flips the spike from
"can we even?" to "is it fast/good enough?", which a POC can answer directly.

---

## 3. Integration points in this repo

The existing engine is small and clean, and the protocol already anticipates a
refinement pass. Concrete files:

- **`packages/pwa/src/engine/asr.worker.ts`** — the transformers.js worker.
  Model for a *parallel* worker: a new `refine.worker.ts` would mirror this
  shape (load → transcribe RPC → post result) but wrap the sherpa-onnx WASM
  module instead of `pipeline()`.
- **`packages/pwa/src/engine/messages.ts`** — the worker RPC contract
  (`LoadRequest` / `TranscribeRequest` with `samples: Float32Array` 16 kHz mono;
  `ResultEvent` with `text` + optional `words`). A refine worker can reuse this
  interface almost verbatim. The `samples` are already exactly what sherpa-onnx
  wants (16 kHz mono float PCM).
- **`packages/pwa/src/engine/captioner.ts`** — the orchestrator. Key hooks:
  - `finishUtterance()` (lines ~232-262) is where a **final** is produced and
    emitted. This is the exact spot to *also* enqueue the finalized
    `snap.samples` + `snap.meta.id` to the refine worker.
  - `rpc()` (lines ~324-332) and `pending`/`onWorkerEvent` show the RPC pattern
    to copy for a second worker (`this.refineWorker`, `this.refinePending`).
  - `emit()` (line ~370) publishes a `ServerMessage` to the display over the
    BroadcastChannel and mirrors to the UI. A refined result re-emits a
    `{ type: "final", segment: { ...same id..., text: refined } }`.
- **`packages/protocol/src/index.ts`** — the protocol is **already built for
  this**:
  - `CaptionSegment.locked` (lines 65-67): comment literally says the segment is
    *"Not overwritten by the engine (live re-emit) or the background refinement
    pass; a locked update wins."*
  - `canReplaceSegment(existing, incoming)` (lines 83-88): the lock-aware
    upsert-by-id rule shared by every store. A refine result with the **same id**
    and no `locked` flag will replace the live final **unless** the operator has
    locked it — exactly the desired behavior. **No protocol changes needed.**
- **`packages/protocol/src/correct.ts`** — operator corrections set `locked:
  true`; the refine pass must emit **non-locked** finals so it never stomps an
  operator correction. `canReplaceSegment` enforces this for free.
- **Desktop reference:** `refine.py` + `hub.py:94-100` (per the audit,
  `AUDIT-pwa-vs-desktop.md:105`) is the existing two-tier design to mirror —
  same-id, lock-aware upsert. The PWA version reuses the identical contract.

**Routing summary:** live final emitted (id X) → same samples enqueued to refine
worker → refine worker returns better text for id X → captioner re-emits
`final{id:X, text:refined, locked:absent}` → every upsert-by-id store replaces X
via `canReplaceSegment`, unless the operator locked X first. Clean, and the
backbone already exists.

**One integration wrinkle to resolve in the POC:** how sherpa-onnx WASM loads its
model. The stock demos **preload the model into the Emscripten virtual FS** (a
`.data` file / `--preload-file`), i.e. baked at build time. For our flow we want
to **fetch the model at runtime through the same-origin `/hf`-style proxy** (to
keep the no-CORS, edge-cached story consistent) and mount it into the WASM FS
(`Module.FS_createDataFile` / fetch → `writeFile`). This is a known,
well-trodden pattern but is the main bit of glue code to prove out. The Worker
would need its own proxied model path (mirror `env.remoteHost`/`/hf` approach in
`asr.worker.ts:15-16`).

---

## 4. Model quality / latency expectations

**Quality.** Candidate refine models and rough English WER (standard benchmarks;
directional, not our audio):

- Whisper-large-v3-turbo ≈ **5.1% WER**
- SenseVoice-Small ≈ **5.5% WER**
- Moonshine ≈ **7.8% WER** (but strong at tiny sizes, edge-optimized)

Sources: [SenseVoice vs Whisper turbo comparison](https://www.aitoolnet.com/compare/sensevoice-vs-whisper-largev3turbo),
[Moonshine vs Whisper 2026](https://modelslab.com/blog/audio-generation/moonshine-vs-whisper-asr-real-time-speech-2026),
[FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice).

Important caveat: our **live** pass is small.en (default) or large-v3-turbo
(gated `?experimental=1`). A WASM refine model that is only ~small.en-quality
buys little. **SenseVoice-Small is the most interesting refine candidate**:
near-turbo accuracy, non-autoregressive (fast), multilingual (opens a future
language feature), ~229 MB int8. Whisper-base-in-WASM would be a downgrade vs our
live small.en and is **not** worth it — refine must clearly beat live to justify
a second engine.

**Latency.** SenseVoice-Small is non-autoregressive and quoted at ~70 ms to
process 10 s of audio *natively* — ~15× faster than Whisper-Large
([FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice)). Native
numbers do **not** transfer to single-threaded WASM: expect a large slowdown
(rough order: single-thread WASM+SIMD is commonly ~3-10× slower than a native
multi-thread build, model-dependent). But since refine is **background, on
finalized utterances, not on the live critical path**, an RTF well above 1.0 is
still useful as long as it keeps up with speaking cadence over a session. **This
is the #1 number the POC must produce**: measured RTF of SenseVoice-Small (and
Moonshine) single-thread WASM+SIMD on a mid-range laptop and a phone.

---

## 5. Effort + risk — phased spike plan

**Phase 0 — desk check (½ day).** Done here. Conclusion: single-threaded SIMD
build ⇒ no COOP/COEP conflict. Proceed.

**Phase 1 — standalone POC, one clip (1-2 days).** Outside the app: load the
sherpa-onnx WASM offline VAD+ASR module (SenseVoice-Small int8) in a bare Web
Worker on a plain page **with no COOP/COEP headers**, fetch the model at runtime
(not baked-in), transcribe one recorded 10-30 s clip, print text + wall-clock.
- **Gate G1:** Does it load + transcribe correctly with **no cross-origin
  isolation**? (If it silently needs SAB → hard stop, re-evaluate.)
- **Gate G2:** Measured **RTF** on laptop + phone. Target: comfortably < ~0.5-1.0
  RTF so it keeps up. Record accuracy vs our small.en on the same clip.

**Phase 2 — concurrency proof (1-2 days).** Run the WASM refine worker **at the
same time** as the live WebGPU transformers.js pass on one page. Confirm: live
latency/throughput does **not** regress while refine grinds; UI stays responsive.
- **Gate G3:** No measurable starvation of the live pass; main thread not janked.

**Phase 3 — wire into captioner behind a flag (2-4 days).** Add
`refine.worker.ts` reusing the `messages.ts` contract; enqueue finals from
`finishUtterance()`; re-emit same-id non-locked finals through `emit()`; rely on
`canReplaceSegment`. Gate behind `?refine=1`. Route the model through a
`/hf`-style same-origin proxy. Verify operator locks survive (refine never
overwrites a `locked` segment).
- **Gate G4:** End-to-end: live captions, then visibly-improved refined finals
  land by id, operator corrections stick.

**Phase 4 — decide (½ day).** Quality win real? Perf acceptable on target
hardware? Second-download cost justified? Ship-flag / iterate / shelve.

**Rough total to a decision:** ~1-1.5 weeks of focused work; Phases 0-2 (~4 days)
answer the make-or-break questions before touching app code.

**Top risks (ranked):**
1. ~~COOP/COEP / threads conflict~~ — **largely retired** by Phase 0: the offline
   ASR build is single-threaded SIMD, no SAB. (Residual: confirm empirically in
   Phase 1 that *our chosen* model/build genuinely runs without SAB.)
2. **Single-thread WASM too slow** — SenseVoice/Moonshine RTF on phones may not
   keep up. This is now the primary kill risk. → Phase 1 G2.
3. **Second model download + RAM** — another ~230 MB download and ~400 MB+
   resident on top of the live model; rough on phones/venue wifi. → weigh in
   Phase 4; consider refine as a laptop/desktop-only opt-in.
4. **Quality not a clear win** — if WASM-refine ≈ live small.en, no point. Pick a
   model that clearly beats live (SenseVoice-Small), not Whisper-base. → G2.
5. **Model-loading glue** — runtime fetch-into-WASM-FS via the proxy vs
   baked-in `.data`. Solvable but is the real engineering in Phase 1/3.
6. **Word-level timing/confidence** — sherpa-onnx offline output may not give the
   same word structure our `Word[]` expects; refine may be text-only (acceptable;
   `asr.worker.ts` already degrades to text-only finals).

---

## 6. Recommendation

**Go — run the POC (Phases 0-2).** The one risk that could have killed this
cheaply and permanently (COOP/COEP vs our deliberate no-cross-origin-isolation
architecture) is **resolved in our favor**: the sherpa-onnx offline VAD+ASR WASM
build is single-threaded + SIMD and needs **no SharedArrayBuffer**, so it coexists
with the `/hf`-proxy / no-COOP/COEP design and can run in a Worker on the CPU
while WebGPU drives the live pass. The concurrency thesis is architecturally
sound. The protocol backbone (`locked` + `canReplaceSegment`, same-id upsert) is
already in place, so integration is small and low-risk. sherpa-onnx is mature,
Apache-2.0, browser-supported, and offers a genuinely-better-than-small.en refine
candidate in SenseVoice-Small.

**But do not skip the POC** — commit only to Phases 0-2 first. The open questions
that must be answered before any app wiring:

1. **RTF of single-thread WASM+SIMD SenseVoice-Small on real target hardware
   (mid laptop + phone)** — the make-or-break number.
2. **Confirmed no-SAB operation** of the chosen model/build under a page with no
   COOP/COEP.
3. **Measured non-interference** with the live WebGPU pass under concurrent load.
4. **Quality delta** vs our live small.en on representative talk audio — must be a
   clear win.
5. **Second-download / RAM cost** acceptable for the audience, or scope refine to
   laptop/desktop as an opt-in.

If G2 (perf) fails on phones but passes on laptops, the fallback is still valuable:
ship PWA refinement as a **desktop/laptop opt-in** (`?refine=1`), closing the
biggest remaining PWA-vs-desktop capability gap without the MLX GPU-contention
problem.

---

## TL;DR

sherpa-onnx has a maintained, browser-supported **single-threaded SIMD WASM**
offline ASR build (SenseVoice-Small, Whisper-tiny/base, Moonshine, Zipformer)
that needs **no SharedArrayBuffer and no COOP/COEP** — so it is compatible with
this project's deliberate no-cross-origin-isolation `/hf`-proxy design, which was
the risk most likely to kill the idea. Running it in a Web Worker on the **CPU**
alongside the **WebGPU** live pass is architecturally sound, and the protocol
already supports same-id, lock-aware refinement (`canReplaceSegment` + `locked`).
The remaining unknown is **not feasibility but speed/quality**: single-thread
WASM will be much slower than native, so the POC must measure RTF and accuracy of
SenseVoice-Small on real phones/laptops. **Recommendation: GO on a ~4-day POC
(Phases 0-2)** to settle perf, no-SAB operation, and non-interference before
wiring a `refine.worker.ts` into `captioner.ts:finishUtterance()`. Fallback if
phones are too slow: ship it as a laptop/desktop opt-in.
