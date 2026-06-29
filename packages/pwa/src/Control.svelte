<script lang="ts">
  import { onMount } from "svelte";
  import {
    DEFAULT_DISPLAY_CONFIG,
    exportTranscript,
    type Background,
    type DisplayConfig,
    type ExportFormat,
    type ServerMessage,
  } from "@captions/protocol";
  import {
    qrSlidePngBlob,
    qrSvg,
    RoomPublisher,
    roomPublishUrl,
    type ConnectionState,
  } from "@captions/display";
  import { Captioner } from "./engine/captioner.js";
  import { UiStore } from "./uiStore.svelte.js";

  const CHANNEL = "captions";
  const MODELS = [
    { id: "onnx-community/whisper-tiny.en", label: "tiny.en (fastest)" },
    { id: "onnx-community/whisper-base.en", label: "base.en (balanced)" },
    { id: "onnx-community/whisper-small.en", label: "small.en (most accurate)" },
  ];

  const appName = location.hostname.endsWith("caption.guru")
    ? "Caption Guru"
    : "Live Captions";

  const store = new UiStore();
  let mics = $state<MediaDeviceInfo[]>([]);
  let deviceId = $state<string>("");
  let model = $state(MODELS[1]!.id);
  let dictionaryText = $state("");
  let running = $state(false);
  let captioner: Captioner | null = null;

  // --- room publishing ------------------------------------------------------
  // A publish target can come from the page URL (?publish=<url> or
  // ?room=<id>&token=<tok>[&base=]) or from the "Start room" button, which mints
  // a fresh room at `roomBase` (default same-origin). The caption stream is teed
  // to the CaptionRoom whenever a publisher is active.
  const roomBase =
    new URLSearchParams(location.search).get("roomBase") ?? location.origin;
  const publishUrl = resolvePublishUrl();
  let publisher: RoomPublisher | null = null;
  let publishState = $state<ConnectionState | null>(null);
  let room = $state<{ id: string; joinUrl: string } | null>(null);
  let roomError = $state<string | null>(null);

  // The QR/join target is the audience viewer *page* (not the raw ws socket):
  // viewer.html?source=room&room=<id>[&base=<room ws origin>].
  function joinUrlFor(id: string): string {
    const u = new URL("viewer.html", location.href);
    u.searchParams.set("source", "room");
    u.searchParams.set("room", id);
    if (roomBase !== location.origin) u.searchParams.set("base", roomBase);
    return u.href;
  }

  // The control owns the on-air display config (pushed over the channel). The
  // QR overlay only renders on the display in chroma-key mode (by design).
  const configChannel = new BroadcastChannel(CHANNEL);
  let bgKind = $state<Background["kind"]>(DEFAULT_DISPLAY_CONFIG.background.kind);
  let bgColor = $state<string>("#00b140");
  let qr = $state<DisplayConfig["qr"]>(undefined);

  // Derived from its parts (never mutated in place) so updating it can't loop.
  const displayConfig = $derived.by<DisplayConfig>(() => {
    const background: Background =
      bgKind === "transparent" ? { kind: "transparent" } : { kind: bgKind, color: bgColor };
    return { ...DEFAULT_DISPLAY_CONFIG, background, ...(qr ? { qr } : {}) };
  });

  // Push to the on-air display whenever the config changes (write-only side
  // effect — no reactive state is written here, so no update loop).
  $effect(() => {
    configChannel.postMessage({ type: "config", config: $state.snapshot(displayConfig) });
  });

  function resolvePublishUrl(): string | null {
    const params = new URLSearchParams(location.search);
    const direct = params.get("publish");
    if (direct) return direct;
    const r = params.get("room");
    const token = params.get("token");
    if (r && token) return roomPublishUrl(r, token, params.get("base") ?? undefined);
    return null;
  }

  async function startRoom(): Promise<void> {
    roomError = null;
    try {
      const res = await fetch(`${roomBase}/r/new`, { method: "POST" });
      if (!res.ok) throw new Error(`room server returned ${res.status}`);
      const r = await res.json();
      const joinUrl = joinUrlFor(r.id);
      room = { id: r.id, joinUrl };
      publisher?.stop();
      publisher = new RoomPublisher(r.publishUrl, (s) => (publishState = s));
      publisher.start();
      // Advertise the join QR on the display (shown only in chroma mode);
      // the $effect picks this up and pushes the new config.
      qr = { url: joinUrl, x: 72, y: 6, size: 24 };
    } catch (err) {
      roomError = String(err);
    }
  }

  function stopRoom(): void {
    publisher?.stop();
    publisher = null;
    publishState = null;
    qr = undefined;
    room = null;
  }

  async function downloadQrPng(): Promise<void> {
    if (!room) return;
    const blob = await qrSlidePngBlob(room.joinUrl);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "caption-room-qr.png";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Single funnel for the captioner's output: mirror to the UI, and (when
  // publishing) tee to the room.
  function sink(msg: ServerMessage): void {
    store.apply(msg);
    publisher?.publish(msg);
  }

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
    // Legacy/power-user path: a publish target given in the URL starts relaying
    // immediately (independent of the "Start room" button).
    if (publishUrl) {
      publisher = new RoomPublisher(publishUrl, (s) => (publishState = s));
      publisher.start();
    }
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
      onUpdate: sink,
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
    // Stops captioning only; an active room keeps running until "Stop room".
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
    {#if publishUrl || room}
      <span class="pill" class:listening={publishState === "open"}>
        room: {publishState ?? "idle"}
      </span>
    {/if}
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

    <label>
      Display background
      <select bind:value={bgKind}>
        <option value="solid">Solid</option>
        <option value="chroma">Chroma key (green)</option>
        <option value="transparent">Transparent</option>
      </select>
    </label>

    {#if bgKind !== "transparent"}
      <label>
        Background color
        <input type="color" bind:value={bgColor} />
      </label>
    {/if}

    <div class="buttons">
      {#if running}
        <button class="stop" onclick={stop}>Stop</button>
      {:else}
        <button class="start" onclick={start}>Start captioning</button>
      {/if}
      <button onclick={openDisplay}>Open display ↗</button>
    </div>
  </section>

  <section class="room">
    {#if room}
      <div class="room-live">
        <div class="room-info">
          <strong>Live room</strong>
          <a href={room.joinUrl} target="_blank" rel="noreferrer">{room.joinUrl}</a>
          <div class="room-actions">
            <button onclick={downloadQrPng}>Download QR slide (PNG)</button>
            <button class="stop" onclick={stopRoom}>Stop room</button>
          </div>
          {#if bgKind !== "chroma"}
            <p class="room-note">
              The join QR shows on the projection output only in <strong>chroma-key</strong>
              mode. Switch the display background to chroma to overlay it — or hand out
              the PNG slide.
            </p>
          {/if}
        </div>
        <div class="room-qr">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- generated SVG, no user HTML -->
          {@html qrSvg(room.joinUrl)}
        </div>
      </div>
    {:else}
      <button class="start" onclick={startRoom}>Start audience room</button>
      {#if roomError}<span class="room-err">{roomError}</span>{/if}
    {/if}
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

    <details class="dict-help">
      <summary>How the custom dictionary works</summary>
      <div class="dict-help-body">
        <p>
          The speech model sometimes mis-spells unusual words it hasn't heard
          before. After each line is recognized, this dictionary <strong>nudges
          close-but-wrong words back to the spelling you want</strong>. It runs
          on-device, instantly, and is deliberately <em>conservative</em>: only a
          word that's a near-miss for one of your terms is changed, so ordinary
          text is never corrupted. Capitalization is preserved.
        </p>
        <p>List your event's terms separated by commas or new lines. A few rules:</p>
        <ul>
          <li>Each term is a <strong>single word of 4+ letters</strong> (spaces
            split it into separate words; very short acronyms like “AI” or “CPU”
            are skipped).</li>
          <li>Only <strong>near-misses</strong> are fixed (a letter or two off) —
            not a word heard as a completely different word.</li>
        </ul>
        <p class="dict-eg"><strong>Medical conference</strong> —
          <code>ondansetron, metoprolol, echocardiogram, pneumothorax, sepsis</code><br />
          “ondanZetron” or “echo cardiogram”→ corrected to your spelling; a plain
          word like “patient” is left alone.</p>
        <p class="dict-eg"><strong>Tech workshop</strong> —
          <code>Kubernetes, PostgreSQL, nginx, Grafana, OAuth, Kafka</code><br />
          “kubernetis” → “Kubernetes”, “postgres QL” → “PostgreSQL”. Note: an
          acronym heard as a totally different word (e.g. “SQL” → “sequel”) is a
          <em>sound-alike</em>, not a near-miss — that's handled by the operator
          sound-alike correction coming in v2, not this near-miss list.</p>
      </div>
    </details>

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
  .room {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .room-live {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .room-info {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 0;
  }
  .room-info a {
    color: #9fb4d4;
    word-break: break-all;
    font-size: 0.85rem;
  }
  .room-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .room-note {
    font-size: 0.8rem;
    color: #999;
    max-width: 32rem;
  }
  .room-qr {
    width: 9rem;
    height: 9rem;
    background: #fff;
    padding: 0.4rem;
    border-radius: 8px;
    flex: 0 0 auto;
  }
  .room-qr :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .room-err {
    color: #ff8a8a;
    font-size: 0.85rem;
  }
</style>
