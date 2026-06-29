<script lang="ts">
  import { onMount } from "svelte";
  import { exportTranscript, type ExportFormat } from "@captions/protocol";
  import { Captioner } from "./engine/captioner.js";
  import { UiStore } from "./uiStore.svelte.js";

  const CHANNEL = "captions";
  const MODELS = [
    { id: "onnx-community/whisper-tiny.en", label: "tiny.en (fastest)" },
    { id: "onnx-community/whisper-base.en", label: "base.en (balanced)" },
    { id: "onnx-community/whisper-small.en", label: "small.en (most accurate)" },
  ];

  const store = new UiStore();
  let mics = $state<MediaDeviceInfo[]>([]);
  let deviceId = $state<string>("");
  let model = $state(MODELS[1]!.id);
  let dictionaryText = $state("");
  let running = $state(false);
  let captioner: Captioner | null = null;

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

  onMount(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      mics = devices.filter((d) => d.kind === "audioinput");
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
    <h1>Live Captions</h1>
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
        {#each MODELS as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
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
