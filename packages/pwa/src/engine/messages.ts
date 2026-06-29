// RPC message shapes between the captioner (main thread) and the ASR worker.

export interface LoadRequest {
  type: "load";
  model: string;
}

export interface TranscribeRequest {
  type: "transcribe";
  reqId: string;
  samples: Float32Array; // 16 kHz mono
}

export type WorkerRequest = LoadRequest | TranscribeRequest;

export interface ReadyEvent {
  type: "ready";
  device: string; // "webgpu" | "wasm"
  model: string;
}

export interface LoadingEvent {
  type: "loading";
  message: string;
}

export interface ResultEvent {
  type: "result";
  reqId: string;
  text: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  reqId?: string;
}

export type WorkerEvent = ReadyEvent | LoadingEvent | ResultEvent | ErrorEvent;
