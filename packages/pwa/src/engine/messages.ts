// RPC message shapes between the captioner (main thread) and the ASR worker.
import type { Word } from "@captions/protocol";

export interface LoadRequest {
  type: "load";
  model: string;
  /** verbose [asr] logging in the worker (mirrors the page's ?debug) */
  debug?: boolean;
}

export interface TranscribeRequest {
  type: "transcribe";
  reqId: string;
  samples: Float32Array; // 16 kHz mono
  /** request word-level timing/confidence (finals only — adds decode cost) */
  words?: boolean;
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

export interface ProgressEvent {
  type: "progress";
  loaded: number; // aggregate bytes downloaded
  total: number; // aggregate bytes expected
}

export interface ResultEvent {
  type: "result";
  reqId: string;
  text: string;
  /** word-level timing + (approximate) confidence, when requested for a final */
  words?: Word[];
}

export interface ErrorEvent {
  type: "error";
  message: string;
  reqId?: string;
}

export type WorkerEvent =
  | ReadyEvent
  | LoadingEvent
  | ProgressEvent
  | ResultEvent
  | ErrorEvent;
