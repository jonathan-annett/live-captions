/// <reference lib="webworker" />
import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import type { Word } from "@captions/protocol";
import type { WorkerEvent, WorkerRequest } from "./messages.js";

// Models are fetched from the Hugging Face hub and cached by the browser.
env.allowLocalModels = false;
// Route model downloads through our own origin (/hf/* proxy) instead of
// huggingface.co directly. Same-origin = no CORS, plus edge caching. Both the
// Cloudflare Worker (prod) and the Vite dev server proxy /hf -> huggingface.co.
env.remoteHost = self.location.origin;
env.remotePathTemplate = "hf/{model}/resolve/{revision}/";

// Try WebGPU first (fast), fall back to WASM (compatible).
const DEVICES = ["webgpu", "wasm"] as const;

// Per-model precision. Large/turbo models are pinned to q4f16 on WebGPU to keep
// the download ~0.5–0.7 GB (fp16 weights would be ~1.5 GB); the small models
// keep the accurate-encoder / quantized-decoder split.
function dtypeFor(
  model: string,
  device: (typeof DEVICES)[number],
  f16: boolean,
): unknown {
  const large = /large|turbo/i.test(model);
  if (device === "wasm") return large ? "q4" : "q8";
  // WebGPU: the accurate-encoder path uses fp16, which needs the `shader-f16`
  // WebGPU feature. Many Intel/AMD/older GPUs don't expose it — without this
  // guard the fp16 load throws and we SILENTLY drop to WASM (≈10× slower). When
  // f16 is unavailable, use an int-quantized dtype so we STAY on the GPU.
  if (!f16) return large ? "q4" : "q8";
  return large ? "q4f16" : { encoder_model: "fp16", decoder_model_merged: "q4" };
}

// One-time probe: does this browser's WebGPU adapter support `shader-f16`?
let f16Supported: boolean | null = null;
async function webgpuHasF16(): Promise<boolean> {
  if (f16Supported !== null) return f16Supported;
  try {
    const gpu = (
      navigator as unknown as {
        gpu?: { requestAdapter(): Promise<{ features: ReadonlySet<string> } | null> };
      }
    ).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    f16Supported = !!adapter && adapter.features.has("shader-f16");
  } catch {
    f16Supported = false;
  }
  return f16Supported;
}

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
// Multilingual Whisper (e.g. large-v3-turbo) REQUIRES a language; the English-
// only `.en` models must NOT be given one. Set from the model id at load time.
let multilingual = false;
// Verbose [asr] logging, mirrors the page's ?debug (set from the load message).
let debug = false;
// Not every ONNX Whisper export ships alignment heads, so `return_timestamps:
// "word"` can throw. We try once; if it fails we stop asking (text-only finals)
// rather than dropping every final on the floor. Desktop carries real word
// confidence regardless.
let wordTimestampsOk = true;

// transformers.js's pipeline() overload set is a union too large for tsc to
// represent; call it through a narrowed signature.
const loadPipeline = pipeline as unknown as (
  task: string,
  model: string,
  opts: Record<string, unknown>,
) => Promise<AutomaticSpeechRecognitionPipeline>;

const post = (msg: WorkerEvent, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One full load attempt: try each device in turn; return on the first that
 *  loads, throw the last error if none do. */
async function loadOnce(model: string): Promise<void> {
  let lastErr: unknown;
  const f16 = await webgpuHasF16();
  for (const device of DEVICES) {
    // Aggregate per-file download progress into a single loaded/total.
    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (p: {
      status: string;
      file?: string;
      loaded?: number;
      total?: number;
    }) => {
      if (!p.file || typeof p.total !== "number") return;
      const loaded = p.status === "done" ? p.total : (p.loaded ?? 0);
      files.set(p.file, { loaded, total: p.total });
      let l = 0;
      let t = 0;
      for (const v of files.values()) {
        l += v.loaded;
        t += v.total;
      }
      post({ type: "progress", loaded: l, total: t });
    };
    try {
      const note = device === "webgpu" ? (f16 ? " (fp16)" : " (int8 — no shader-f16)") : "";
      post({ type: "loading", message: `Loading ${model} on ${device}${note}…` });
      transcriber = await loadPipeline("automatic-speech-recognition", model, {
        device,
        dtype: dtypeFor(model, device, f16),
        progress_callback,
      });
      post({ type: "ready", device, model });
      return;
    } catch (err) {
      lastErr = err;
      // Don't swallow it: a silent webgpu→wasm fallback is a ~10× slowdown.
      console.warn(`[asr] load on ${device} failed, trying next device:`, err);
    }
  }
  throw lastErr;
}

// Retry the whole load with capped exponential backoff — venue wifi is flaky and
// a model is tens of MB. transformers.js caches fetched files in browser Cache
// Storage, so a retry effectively resumes: already-downloaded files load from
// cache, only the interrupted fetch repeats. A retry only fires when EVERY device
// failed the round (an unsupported device just falls through fast, as before).
const LOAD_ATTEMPTS = 4;
const LOAD_BASE_DELAY_MS = 1000;
const LOAD_MAX_DELAY_MS = 15_000;

async function load(model: string): Promise<void> {
  multilingual = !model.endsWith(".en");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
    try {
      await loadOnce(model);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < LOAD_ATTEMPTS) {
        const delay = Math.min(
          LOAD_BASE_DELAY_MS * 2 ** (attempt - 1),
          LOAD_MAX_DELAY_MS,
        );
        post({
          type: "loading",
          message: `Load failed — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${LOAD_ATTEMPTS})…`,
        });
        await sleep(delay);
      }
    }
  }
  post({
    type: "error",
    message: `Failed to load model after ${LOAD_ATTEMPTS} attempts: ${String(lastErr)}`,
  });
}

/** transformers.js chunk shape when `return_timestamps: "word"`. */
interface WordChunk {
  text: string;
  timestamp: [number, number | null];
}

/**
 * Build word-level segments from a transformers.js `return_timestamps:"word"`
 * result. transformers.js (unlike faster-whisper) does not expose a decoder
 * probability, so `confidence` is an **approximation** from speaking-rate
 * plausibility: a word whose audio duration is wildly off the expected length
 * for its characters is more likely a mishearing. Desktop carries the real
 * `word.probability`; this is the browser's best available proxy.
 */
function wordsFromChunks(out: unknown): Word[] | undefined {
  const chunks = (out as { chunks?: WordChunk[] } | null)?.chunks;
  if (!Array.isArray(chunks)) return undefined;
  const words: Word[] = [];
  for (const c of chunks) {
    const text = (c.text ?? "").trim();
    if (!text) continue;
    const start = c.timestamp?.[0] ?? 0;
    const end = c.timestamp?.[1] ?? start;
    words.push({ text, start, end, confidence: approxConfidence(text, end - start) });
  }
  return words.length ? words : undefined;
}

/** Speaking-rate plausibility → pseudo-confidence in [0,1]. Pure heuristic. */
function approxConfidence(text: string, durSec: number): number {
  const chars = text.replace(/[^A-Za-z']/g, "").length;
  if (chars === 0 || durSec <= 0) return 0.5;
  // Conversational speech runs ~12–18 characters/second. Inside that band reads
  // as confident; far outside (rushed/smeared) decays toward 0.4.
  const cps = chars / durSec;
  const dev = cps < 12 ? (12 - cps) / 12 : cps > 18 ? (cps - 18) / 18 : 0;
  return Math.max(0.4, Math.min(1, 1 - dev));
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "load") {
    debug = msg.debug ?? false;
    await load(msg.model);
    return;
  }
  // transcribe
  if (!transcriber) {
    // Model not ready yet (large models take a while to compile for WebGPU);
    // clips during this window return empty — log it so the silence is clear.
    if (debug) console.log("[asr] skip — model still loading/compiling");
    post({ type: "result", reqId: msg.reqId, text: "" });
    return;
  }
  try {
    const t0 = performance.now();
    // Common decode options. Multilingual models (large-v3-turbo) require a
    // language + task; the `.en` models reject them. (Language is a future feature.)
    // NOTE: no_repeat_ngram_size/repetition_penalty were tried to break repetition
    // loops, but they derail Whisper on real speech (collapsing output to a single
    // token). Silence hallucinations are handled by the no-speech gate + degenerate
    // filter in captioner.ts instead.
    const base: Record<string, unknown> = {
      chunk_length_s: 30,
      ...(multilingual ? { language: "en", task: "transcribe" } : {}),
    };

    let out: unknown;
    let words: Word[] | undefined;
    // Word-level timestamps cost extra decode work, so the captioner only asks
    // for them on finals — and only while the model is known to support them.
    if (msg.words && wordTimestampsOk) {
      try {
        out = await transcriber(msg.samples, { ...base, return_timestamps: "word" });
        words = wordsFromChunks(out);
      } catch (werr) {
        // This export can't do word timestamps — don't ask again, and re-decode
        // plainly below so the final still produces text.
        wordTimestampsOk = false;
        out = undefined;
        if (debug) console.warn("[asr] word timestamps unsupported, text-only:", werr);
      }
    }
    if (out === undefined) {
      out = await transcriber(msg.samples, { ...base, return_timestamps: false });
    }
    const text = Array.isArray(out)
      ? out.map((o) => (o as { text: string }).text).join(" ")
      : ((out as { text?: string }).text ?? "");
    // Decode output + inference time, under ?debug (helps diagnose models like turbo).
    if (debug) {
      console.log(
        `[asr] decoded ${JSON.stringify(text.trim())} in ${Math.round(performance.now() - t0)}ms` +
          (words ? ` (${words.length} words)` : ""),
      );
    }
    post({ type: "result", reqId: msg.reqId, text: text.trim(), words });
  } catch (err) {
    // Transcribe failures were silent (turned into empty captions). Surface them.
    console.error("[asr] transcribe failed:", err);
    post({ type: "error", reqId: msg.reqId, message: String(err) });
  }
};
