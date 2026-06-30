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
function dtypeFor(model: string, device: (typeof DEVICES)[number]): unknown {
  const large = /large|turbo/i.test(model);
  if (device === "wasm") return large ? "q4" : "q8";
  return large ? "q4f16" : { encoder_model: "fp16", decoder_model_merged: "q4" };
}

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
// Multilingual Whisper (e.g. large-v3-turbo) REQUIRES a language; the English-
// only `.en` models must NOT be given one. Set from the model id at load time.
let multilingual = false;
// Verbose [asr] logging, mirrors the page's ?debug (set from the load message).
let debug = false;

// transformers.js's pipeline() overload set is a union too large for tsc to
// represent; call it through a narrowed signature.
const loadPipeline = pipeline as unknown as (
  task: string,
  model: string,
  opts: Record<string, unknown>,
) => Promise<AutomaticSpeechRecognitionPipeline>;

const post = (msg: WorkerEvent, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

async function load(model: string): Promise<void> {
  multilingual = !model.endsWith(".en");
  let lastErr: unknown;
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
      post({ type: "loading", message: `Loading ${model} on ${device}…` });
      transcriber = await loadPipeline("automatic-speech-recognition", model, {
        device,
        dtype: dtypeFor(model, device),
        progress_callback,
      });
      post({ type: "ready", device, model });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  post({ type: "error", message: `Failed to load model: ${String(lastErr)}` });
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
    const out = await transcriber(msg.samples, {
      chunk_length_s: 30,
      // Word-level timestamps cost extra decode work, so the captioner only asks
      // for them on finals — partials (the live bleeding edge) stay cheap.
      return_timestamps: msg.words ? "word" : false,
      // Multilingual models (large-v3-turbo) require a language + task; the
      // `.en` models reject them. (Language selection is a future feature.)
      ...(multilingual ? { language: "en", task: "transcribe" } : {}),
      // NOTE: no_repeat_ngram_size/repetition_penalty were tried here to break
      // repetition loops, but they derail Whisper on real speech (collapsing
      // output to a single token like "[" or "W"). Silence hallucinations are
      // handled instead by the no-speech gate + degenerate filter in captioner.ts.
    });
    const text = Array.isArray(out)
      ? out.map((o) => o.text).join(" ")
      : (out.text ?? "");
    const words = msg.words ? wordsFromChunks(out) : undefined;
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
