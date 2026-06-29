// Library entry: lets other apps (the PWA) reuse the exact on-air display.
export { default as App } from "./App.svelte";
export { default as Viewer } from "./Viewer.svelte";
export { CaptionStore } from "./captionStore.svelte.js";
export { ViewerLog } from "./viewerLog.js";
export { ViewerStore } from "./viewerStore.svelte.js";
export { qrSvg } from "./qr.js";
export { qrSlidePngBlob } from "./qrPng.js";
export * from "./sources/index.js";
