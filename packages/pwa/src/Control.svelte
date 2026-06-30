<script lang="ts">
  import { onMount } from "svelte";
  import { exportTranscript, type ExportFormat } from "@captions/protocol";
  import { Captioner } from "./engine/captioner.js";
  import { UiStore } from "./uiStore.svelte.js";

  const CHANNEL = "captions";
  // `size` is the approximate one-time download (cached after first use), shown
  // in the picker so the cost is clear before choosing. Large models are gated
  // behind ?experimental=1 — they transcribe correctly but are far too slow for
  // real-time on a typical in-browser WebGPU; they want a strong GPU.
  const EXPERIMENTAL = new URLSearchParams(location.search).has("experimental");
  const MODELS: { id: string; label: string; size: string; experimental?: boolean }[] = [
    { id: "onnx-community/whisper-tiny.en", label: "tiny.en — fastest", size: "~100 MB" },
    { id: "onnx-community/whisper-small.en", label: "small.en — accurate", size: "~300 MB" },
    {
      id: "onnx-community/whisper-large-v3-turbo",
      label: "large-v3-turbo — experimental",
      size: "~0.6 GB · strong GPU",
      experimental: true,
    },
  ];
  const availableModels = MODELS.filter((m) => !m.experimental || EXPERIMENTAL);

  const appName = location.hostname.endsWith("caption.guru")
    ? "Caption Guru"
    : "Live Captions";

  // Persist the operator's model + mic choices so a reload doesn't snap back to
  // the default (which was skewing tests when it landed on a weaker model).
  const LS_MODEL = "cg.model";
  const LS_DEVICE = "cg.deviceId";
  const lsGet = (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const lsSet = (k: string, v: string): void => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode / storage disabled */
    }
  };

  const store = new UiStore();
  let mics = $state<MediaDeviceInfo[]>([]);
  const storedModel = lsGet(LS_MODEL);
  let deviceId = $state<string>(lsGet(LS_DEVICE) ?? "");
  // Restore the saved model only if it's currently available (experimental
  // models are hidden unless ?experimental=1); else default to small.en.
  let model = $state(
    availableModels.some((m) => m.id === storedModel)
      ? storedModel!
      : (availableModels[1] ?? availableModels[0]!).id,
  );
  const selectedModel = $derived(MODELS.find((m) => m.id === model));
  let dictionaryText = $state("");
  let running = $state(false);
  let captioner: Captioner | null = null;

  $effect(() => lsSet(LS_MODEL, model));
  $effect(() => lsSet(LS_DEVICE, deviceId));

  function dictionaryTerms(): string[] {
    return dictionaryText
      .split(/[\n,]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // Apply dictionary edits live while captioning.
  $effect(() => {
    captioner?.setDictionary(dictionaryTerms());
  });

  function download(format: ExportFormat) {
    const { body, mime, filename } = exportTranscript(store.finals, format);
    const url = URL.createObjectURL(new Blob([body], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- model download progress ---
  let modelDl = $state<{ loaded: number; total: number; startedAt: number } | null>(
    null,
  );
  let nowTick = $state(0);

  function onModelProgress(p: { loaded: number; total: number }) {
    modelDl = modelDl
      ? { ...modelDl, loaded: p.loaded, total: p.total }
      : { loaded: p.loaded, total: p.total, startedAt: performance.now() };
  }

  // Clear the bar once the model is ready (or we stop / error out).
  $effect(() => {
    if (store.status.state !== "loading") modelDl = null;
  });

  // Tick so elapsed/ETA update smoothly between progress events.
  $effect(() => {
    if (!modelDl) return;
    const id = setInterval(() => (nowTick = performance.now()), 250);
    return () => clearInterval(id);
  });

  const dlInfo = $derived.by(() => {
    if (!modelDl) return null;
    void nowTick; // reactive dependency for the ticking clock
    const { loaded, total, startedAt } = modelDl;
    const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
    const elapsedMs = performance.now() - startedAt;
    const rate = elapsedMs > 0 ? loaded / (elapsedMs / 1000) : 0;
    const etaMs = rate > 0 && total > loaded ? ((total - loaded) / rate) * 1000 : 0;
    return { pct, loaded, total, elapsedMs, etaMs };
  });

  function fmtBytes(n: number): string {
    if (!n) return "0 MB";
    const mb = n / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
  }
  function fmtTime(ms: number): string {
    if (!isFinite(ms) || ms < 0) return "—";
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function cancelDownload() {
    captioner?.stop();
    captioner = null;
    running = false;
    modelDl = null;
  }

  onMount(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      mics = devices.filter((d) => d.kind === "audioinput");
      // If the saved mic is gone (and the list has real ids), fall back to
      // default so start() can't fail on an exact-device constraint.
      if (deviceId && mics.length && mics.every((m) => m.deviceId) &&
          !mics.some((m) => m.deviceId === deviceId)) {
        deviceId = "";
      }
    } catch {
      /* labels populate after first permission grant */
    }
  });

  async function start() {
    captioner = new Captioner({
      model,
      channel: CHANNEL,
      deviceId: deviceId || undefined,
      dictionary: dictionaryTerms(),
      onUpdate: store.apply,
      onProgress: onModelProgress,
    });
    running = true;
    try {
      await captioner.start();
      // Refresh device labels now that permission is granted.
      mics = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "audioinput",
      );
    } catch (err) {
      running = false;
      store.apply({
        type: "status",
        status: { state: "error", message: String(err) },
      });
    }
  }

  function stop() {
    captioner?.stop();
    captioner = null;
    running = false;
  }

  function openDisplay() {
    window.open(
      `./display.html?source=broadcast&channel=${CHANNEL}`,
      "captions-display",
    );
  }

  const statusLabel = $derived(
    store.status.state === "listening"
      ? `listening · ${store.status.device ?? ""} · ${store.status.model?.split("/").pop() ?? ""}`
      : (store.status.message ?? store.status.state),
  );
</script>

<main>
  <header>
    <h1>{appName}</h1>
    <span class="pill {store.status.state}">{statusLabel}</span>
  </header>

  <section class="controls">
    <label>
      Microphone
      <select bind:value={deviceId} disabled={running}>
        <option value="">Default</option>
        {#each mics as mic (mic.deviceId)}
          <option value={mic.deviceId}>
            {mic.label || `Microphone ${mic.deviceId.slice(0, 6)}`}
          </option>
        {/each}
      </select>
    </label>

    <label>
      Model
      <select bind:value={model} disabled={running}>
        {#each availableModels as m (m.id)}
          <option value={m.id}>{m.label} · {m.size}</option>
        {/each}
      </select>
      {#if selectedModel}
        <small class="hint-inline">
          {selectedModel.size} download, once — then cached on this device.
        </small>
      {/if}
    </label>

    <div class="buttons">
      {#if running}
        <button class="stop" onclick={stop}>Stop</button>
      {:else}
        <button class="start" onclick={start}>Start captioning</button>
      {/if}
      <button onclick={openDisplay}>Open display ↗</button>
    </div>
  </section>

  {#if dlInfo}
    <section class="download">
      <div class="dlhead">
        <strong>Downloading speech model…</strong>
        <button class="cancel" onclick={cancelDownload}>Cancel</button>
      </div>
      <div class="bar"><div class="fill" style:width="{dlInfo.pct}%"></div></div>
      <div class="dlmeta">
        <span>{dlInfo.pct.toFixed(0)}%</span>
        <span>{fmtBytes(dlInfo.loaded)} / {fmtBytes(dlInfo.total)}</span>
        <span>elapsed {fmtTime(dlInfo.elapsedMs)}</span>
        <span>ETA {fmtTime(dlInfo.etaMs)}</span>
      </div>
      <p class="dlexplain">
        The “model” is the neural network that turns speech into text. It’s large
        (tens of MB) because it packs the patterns of spoken language learned from
        thousands of hours of audio. This download happens <strong>only once</strong> —
        it’s cached in your browser, so future sessions start instantly. Nothing is
        uploaded; the model runs entirely on your device.
      </p>
    </section>
  {/if}

  <section class="extras">
    <label class="dict">
      Custom dictionary
      <textarea
        bind:value={dictionaryText}
        rows="2"
        placeholder="Names, jargon, acronyms — comma or newline separated"
      ></textarea>
    </label>

    <div class="export">
      <span>Export</span>
      <button onclick={() => download("txt")} disabled={!store.finals.length}>TXT</button>
      <button onclick={() => download("srt")} disabled={!store.finals.length}>SRT</button>
      <button onclick={() => download("vtt")} disabled={!store.finals.length}>VTT</button>
    </div>
  </section>

  <p class="hint">
    First start downloads the model (cached after). Audio is processed on this
    device and never uploaded. Open the display, then send it to your switcher
    over HDMI or as a browser source.
  </p>

  <section class="preview">
    {#each store.finals.slice(-6) as seg (seg.id)}
      <div class="line">{seg.text}</div>
    {/each}
    {#if store.partial}
      <div class="line partial">{store.partial.text}</div>
    {/if}
  </section>
</main>

<style>
  main {
    max-width: 46rem;
    margin: 0 auto;
    padding: 2rem 1.5rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  h1 {
    font-size: 1.6rem;
    margin: 0;
    flex: 1;
  }
  .pill {
    font-size: 0.8rem;
    padding: 0.25rem 0.7rem;
    border-radius: 999px;
    background: #222;
    color: #bbb;
    white-space: nowrap;
  }
  .pill.listening {
    background: #10391f;
    color: #5fe39b;
  }
  .pill.loading {
    background: #3a2f10;
    color: #e3c45f;
  }
  .pill.error {
    background: #3a1414;
    color: #ff8a8a;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: flex-end;
    margin: 1.5rem 0 0.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
    color: #aaa;
  }
  select {
    background: #161616;
    color: #eee;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0.5rem;
    min-width: 12rem;
  }
  .buttons {
    display: flex;
    gap: 0.6rem;
  }
  button {
    border: 0;
    border-radius: 6px;
    padding: 0.6rem 1rem;
    font-size: 0.9rem;
    cursor: pointer;
    background: #2a2a2a;
    color: #eee;
  }
  button.start {
    background: #1f6feb;
    color: white;
  }
  button.stop {
    background: #b42318;
    color: white;
  }
  .hint {
    font-size: 0.8rem;
    color: #777;
    margin: 1rem 0;
  }
  .hint-inline {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.75rem;
    color: #888;
  }
  .download {
    margin: 1rem 0;
    padding: 1rem 1.2rem;
    background: #0e1726;
    border: 1px solid #1f3350;
    border-radius: 8px;
  }
  .dlhead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.6rem;
  }
  .cancel {
    background: #2a2a2a;
    color: #ddd;
    padding: 0.35rem 0.8rem;
  }
  .bar {
    height: 10px;
    background: #1b2740;
    border-radius: 999px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: linear-gradient(90deg, #1f6feb, #5f91ff);
    transition: width 0.2s ease;
  }
  .dlmeta {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: #9fb4d4;
    font-variant-numeric: tabular-nums;
  }
  .dlexplain {
    font-size: 0.8rem;
    color: #8aa0c0;
    line-height: 1.5;
    margin: 0.8rem 0 0;
  }
  .extras {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem;
    align-items: flex-end;
    margin: 0.5rem 0 1rem;
  }
  .dict {
    flex: 1;
    min-width: 16rem;
  }
  textarea {
    background: #161616;
    color: #eee;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0.5rem;
    width: 100%;
    font-family: inherit;
    resize: vertical;
  }
  .export {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: #aaa;
  }
  .export button {
    padding: 0.45rem 0.7rem;
  }
  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .preview {
    margin-top: 1rem;
    padding: 1rem;
    background: #0e0e0e;
    border: 1px solid #222;
    border-radius: 8px;
    min-height: 8rem;
  }
  .line {
    font-size: 1.1rem;
    line-height: 1.5;
  }
  .line.partial {
    opacity: 0.55;
  }
</style>
