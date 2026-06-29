/// <reference lib="webworker" />
import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import type { WorkerEvent, WorkerRequest } from "./messages.js";

// Models are fetched from the Hugging Face hub and cached by the browser.
env.allowLocalModels = false;
// Route model downloads through our own origin (/hf/* proxy) instead of
// huggingface.co directly. Same-origin = no CORS, plus edge caching. Both the
// Cloudflare Worker (prod) and the Vite dev server proxy /hf -> huggingface.co.
env.remoteHost = self.location.origin;
env.remotePathTemplate = "hf/{model}/resolve/{revision}/";

// Try WebGPU first (fast), fall back to WASM (compatible). The dtype split keeps
// the encoder accurate while quantizing the decoder for speed/size on WebGPU.
const DEVICE_PLANS: { device: "webgpu" | "wasm"; dtype: unknown }[] = [
  { device: "webgpu", dtype: { encoder_model: "fp16", decoder_model_merged: "q4" } },
  { device: "wasm", dtype: "q8" },
];

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;

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
  let lastErr: unknown;
  for (const plan of DEVICE_PLANS) {
    try {
      post({ type: "loading", message: `Loading ${model} on ${plan.device}…` });
      transcriber = await loadPipeline("automatic-speech-recognition", model, {
        device: plan.device,
        dtype: plan.dtype,
      });
      post({ type: "ready", device: plan.device, model });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  post({ type: "error", message: `Failed to load model: ${String(lastErr)}` });
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "load") {
    await load(msg.model);
    return;
  }
  // transcribe
  if (!transcriber) {
    post({ type: "result", reqId: msg.reqId, text: "" });
    return;
  }
  try {
    const out = await transcriber(msg.samples, {
      // English-only (.en) models need no language/task; harmless if multilingual.
      chunk_length_s: 30,
      return_timestamps: false,
    });
    const text = Array.isArray(out)
      ? out.map((o) => o.text).join(" ")
      : (out.text ?? "");
    post({ type: "result", reqId: msg.reqId, text: text.trim() });
  } catch (err) {
    post({ type: "error", reqId: msg.reqId, message: String(err) });
  }
};
