<script lang="ts">
  import { onMount } from "svelte";
  import {
    DEFAULT_DISPLAY_CONFIG,
    exportTranscript,
    type Background,
    type CaptionSegment,
    type DisplayConfig,
    type ExportFormat,
  } from "@captions/protocol";
  import { ControlSocket } from "./controlSocket.js";
  import Corrections from "./Corrections.svelte";
  import { ViewerStore } from "./viewerStore.svelte.js";
  import { connectionView } from "./viewerView.js";
  import type { ConnectionState } from "./sources/types.js";

  // Desktop control panel: a thin client over the server's /ws. It mirrors the
  // PWA Control look controls, but instead of a BroadcastChannel it sends
  // `setConfig` / `setDictionary` / `command` to the desktop engine, and renders
  // a live preview from the same socket. The server is the source of truth: on
  // connect we ADOPT its current config (respecting CLI flags), then push changes.

  const FONTS = [
    { label: "Sans (Inter)", value: DEFAULT_DISPLAY_CONFIG.fontFamily },
    { label: "System UI", value: "system-ui, sans-serif" },
    { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
    { label: "Monospace", value: "'SF Mono', Consolas, ui-monospace, monospace" },
  ];
  const LS_LOOK = "cg.look";
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
      /* private mode / disabled */
    }
  };

  const store = new ViewerStore();
  let connection = $state<ConnectionState>("connecting");
  const conn = $derived(connectionView(connection));
  const engineState = $derived(store.status?.state ?? "idle");

  // --- look controls (mirror the PWA) ---------------------------------------
  let bgKind = $state<Background["kind"]>(DEFAULT_DISPLAY_CONFIG.background.kind);
  let bgColor = $state("#00b140");
  let textColor = $state(DEFAULT_DISPLAY_CONFIG.color);
  let fontFamily = $state(DEFAULT_DISPLAY_CONFIG.fontFamily);
  let fontSize = $state(DEFAULT_DISPLAY_CONFIG.fontSize);
  let fontWeight = $state(DEFAULT_DISPLAY_CONFIG.fontWeight);
  let orientation = $state<DisplayConfig["orientation"]>(DEFAULT_DISPLAY_CONFIG.orientation);
  let textAlign = $state<DisplayConfig["textAlign"]>(DEFAULT_DISPLAY_CONFIG.textAlign);
  let uppercase = $state(DEFAULT_DISPLAY_CONFIG.uppercase);
  let showLive = $state(DEFAULT_DISPLAY_CONFIG.showPartial);
  let boxFill = $state(false);
  let boxColor = $state("#000000");
  let boxRadius = $state(0);
  let boxEnabled = $state(false);
  let boxX = $state(6);
  let boxY = $state(68);
  let boxW = $state(88);
  let boxH = $state(26);
  // Auto height: derive the box height from #lines × font size (mirror the PWA),
  // so the operator sizes by lines, not raw %.
  let autoHeight = $state(true);
  let boxLines = $state(2);
  const computedBoxH = $derived(
    Math.min(100, Math.max(5, Math.round(fontSize * (1.3 * boxLines + 0.8)))),
  );
  const effectiveBoxH = $derived(autoHeight ? computedBoxH : boxH);

  let dictionaryText = $state("");

  // --- model picker (desktop hot-swap) --------------------------------------
  // Live model stays fast; refine model can be large (two-tier). A real <select>
  // (not a datalist, which hides options that don't match the typed value) keeps
  // every model visible for BOTH live and refine; "Custom…" allows any HF repo.
  const MODELS = ["tiny.en", "small.en", "medium.en", "large-v3", "large-v3-turbo"];
  const CUSTOM = "__custom";
  const OFF = ""; // refine disabled (live-only)
  const _savedLive = lsGet("cg.model") ?? "small.en";
  const _savedRefine = lsGet("cg.refineModel") ?? "large-v3";
  let liveModel = $state(_savedLive);
  let refineModel = $state(_savedRefine);
  // Track "custom repo" mode per field so a known→custom switch doesn't flicker.
  // Off ("") is a preset choice for refine, not a custom repo.
  let liveCustom = $state(!MODELS.includes(_savedLive));
  let refineCustom = $state(_savedRefine !== OFF && !MODELS.includes(_savedRefine));

  function onModelSelect(which: "live" | "refine", value: string): void {
    const custom = value === CUSTOM;
    if (which === "live") {
      liveCustom = custom;
      if (!custom) liveModel = value;
    } else {
      refineCustom = custom;
      if (!custom) refineModel = value;
    }
  }

  let socket: ControlSocket | null = null;
  let synced = false; // adopted the server's config yet?

  // The partial config patch we push (omit qr/maxLines/etc. so server-set values
  // like the join QR survive the merge; null clears an optional field).
  const configPatch = $derived.by<Partial<DisplayConfig>>(() => {
    const background: Background =
      bgKind === "transparent" ? { kind: "transparent" } : { kind: bgKind, color: bgColor };
    return {
      background,
      color: textColor,
      fontFamily,
      fontSize,
      fontWeight,
      orientation,
      textAlign,
      uppercase,
      showPartial: showLive,
      boxColor: boxFill ? boxColor : (null as unknown as undefined),
      boxRadius: boxFill && boxRadius ? boxRadius : (null as unknown as undefined),
      region: boxEnabled
        ? { x: boxX, y: boxY, width: boxW, height: effectiveBoxH }
        : (null as unknown as undefined),
    };
  });

  function adoptConfig(c: DisplayConfig): void {
    bgKind = c.background.kind;
    if (c.background.kind !== "transparent") bgColor = c.background.color;
    textColor = c.color;
    fontFamily = c.fontFamily;
    fontSize = c.fontSize;
    fontWeight = c.fontWeight;
    orientation = c.orientation;
    textAlign = c.textAlign;
    uppercase = c.uppercase;
    showLive = c.showPartial;
    boxFill = c.boxColor != null;
    if (c.boxColor) boxColor = c.boxColor;
    boxRadius = c.boxRadius ?? 0;
    boxEnabled = c.region != null;
    if (c.region) {
      boxX = c.region.x;
      boxY = c.region.y;
      boxW = c.region.width;
      boxH = c.region.height;
    }
  }

  onMount(() => {
    const wsUrl =
      new URLSearchParams(location.search).get("url") ??
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    socket = new ControlSocket(
      wsUrl,
      (msg) => {
        store.apply(msg);
        // Adopt the server's look once, from its first config snapshot.
        if (msg.type === "config" && !synced) {
          synced = true;
          adoptConfig(msg.config);
        }
      },
      (s) => (connection = s),
    );
    socket.connect();
    return () => socket?.disconnect();
  });

  // Push look changes to the engine (after we've adopted the server's config so
  // we don't clobber CLI flags before the operator touches anything).
  $effect(() => {
    const patch = configPatch;
    if (!synced) return;
    socket?.send({ type: "setConfig", config: patch });
    lsSet(LS_LOOK, JSON.stringify(patch));
  });

  function command(command: "start" | "stop" | "clear"): void {
    socket?.send({ type: "command", command });
  }

  function pushDictionary(): void {
    socket?.send({ type: "setDictionary", terms: dictTerms });
  }

  // Apply dictionary edits live (debounced) while captioning, like the PWA — no
  // need to press a button. The explicit button stays for an immediate apply.
  let dictTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const terms = dictTerms; // reactive dependency
    if (!synced) return;
    if (dictTimer) clearTimeout(dictTimer);
    dictTimer = setTimeout(() => socket?.send({ type: "setDictionary", terms }), 400);
  });

  function download(format: ExportFormat): void {
    const { body, mime, filename } = exportTranscript(store.segments, format);
    const url = URL.createObjectURL(new Blob([body], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function applyModel(): void {
    const model = liveModel.trim();
    if (!model) return;
    const refine = refineModel.trim();
    socket?.send({ type: "setModel", model, refineModel: refine || undefined });
    lsSet("cg.model", model);
    lsSet("cg.refineModel", refine);
  }

  // --- operator corrections -------------------------------------------------
  // Each edit computes a corrected (locked) segment via the shared pure logic and
  // sends it as `editSegment`; the server upserts it into the hub (lock-aware) and
  // rebroadcasts, so it lands on the on-air display + room + this preview.
  const dictTerms = $derived(
    dictionaryText.split(/[\n,]/).map((t) => t.trim()).filter(Boolean),
  );
  let undoStack = $state<CaptionSegment[]>([]);

  function applyCorrection(seg: CaptionSegment): void {
    const prior = store.segments.find((s) => s.id === seg.id);
    if (prior) undoStack = [...undoStack, { ...prior }];
    socket?.send({ type: "editSegment", segment: seg });
  }

  function undoCorrection(): void {
    const prior = undoStack.at(-1);
    if (!prior) return;
    undoStack = undoStack.slice(0, -1);
    // Force the restore to win over the current locked text.
    socket?.send({ type: "editSegment", segment: { ...prior, locked: true } });
  }
</script>

<main>
  <header>
    <h1>Caption Guru — Control</h1>
    <span class="pill" class:on={conn.live}>{conn.label}</span>
    <span class="pill engine {engineState}">{engineState}</span>
  </header>

  <section class="row">
    <button
      class="go"
      onclick={() => command("start")}
      disabled={engineState === "listening" || engineState === "loading"}
    >
      Start
    </button>
    <button onclick={() => command("stop")} disabled={engineState === "idle"}>
      Stop
    </button>
    <button
      onclick={() => command("clear")}
      disabled={!store.segments.length && !store.partial}
    >
      Clear
    </button>
  </section>

  <section class="model">
    <h2>Model</h2>
    <label>
      Live
      <select
        value={liveCustom ? CUSTOM : liveModel}
        onchange={(e) => onModelSelect("live", e.currentTarget.value)}
      >
        {#each MODELS as m (m)}<option value={m}>{m}</option>{/each}
        <option value={CUSTOM}>Custom HF repo…</option>
      </select>
      {#if liveCustom}
        <input bind:value={liveModel} placeholder="org/repo" />
      {/if}
    </label>
    <label>
      Refine
      <select
        value={refineCustom ? CUSTOM : refineModel}
        onchange={(e) => onModelSelect("refine", e.currentTarget.value)}
      >
        <option value={OFF}>Off (live only)</option>
        {#each MODELS as m (m)}<option value={m}>{m}</option>{/each}
        <option value={CUSTOM}>Custom HF repo…</option>
      </select>
      {#if refineCustom}
        <input bind:value={refineModel} placeholder="org/repo" />
      {/if}
    </label>
    <div class="model-apply">
      <button onclick={applyModel} disabled={engineState === "loading"}>
        {engineState === "loading" ? "Loading…" : "Apply model"}
      </button>
      {#if store.status?.model}<span class="current">current: {store.status.model}</span>{/if}
    </div>
    <p class="hint">Bigger models are more accurate but slower. Two-tier: keep Live
      fast (e.g. small.en) and set Refine larger (e.g. large-v3). Refine = <strong>Off</strong>
      for live-only — best on low-memory / single-GPU machines where a refine model
      would contend for the GPU. Any HF repo works.</p>
  </section>

  <section class="look">
    <h2>Look</h2>
    <label>
      Background
      <select bind:value={bgKind}>
        <option value="solid">Solid</option>
        <option value="chroma">Chroma key</option>
        <option value="transparent">Transparent</option>
      </select>
    </label>
    {#if bgKind !== "transparent"}
      <label>
        {bgKind === "chroma" ? "Key colour" : "Background"}
        <input type="color" bind:value={bgColor} />
      </label>
    {/if}
    <label>Text colour <input type="color" bind:value={textColor} /></label>
    <label>
      Font
      <select bind:value={fontFamily}>
        {#each FONTS as f (f.value)}<option value={f.value}>{f.label}</option>{/each}
      </select>
    </label>
    <label>
      Size · {fontSize}vh
      <input type="range" min="2" max="14" step="0.5" bind:value={fontSize} />
    </label>
    <label>
      Weight
      <select bind:value={fontWeight}>
        <option value={400}>Regular</option>
        <option value={500}>Medium</option>
        <option value={600}>Semibold</option>
        <option value={700}>Bold</option>
        <option value={800}>Extra Bold</option>
        <option value={900}>Black</option>
      </select>
    </label>
    <label>
      Justification
      <select bind:value={textAlign}>
        <option value="left">Left</option>
        <option value="center">Center</option>
        <option value="right">Right</option>
      </select>
    </label>
    <label>
      Orientation
      <select bind:value={orientation}>
        <option value="horizontal">Horizontal</option>
        <option value="vertical">Vertical</option>
      </select>
    </label>
    <label class="check"><input type="checkbox" bind:checked={uppercase} /> Uppercase</label>
    <label class="check"><input type="checkbox" bind:checked={showLive} /> Show live text</label>

    <label class="check"><input type="checkbox" bind:checked={boxFill} /> Opaque caption box</label>
    {#if boxFill}
      <label>Box fill <input type="color" bind:value={boxColor} /></label>
      <label>Corner radius · {boxRadius}vh
        <input type="range" min="0" max="6" step="0.5" bind:value={boxRadius} /></label>
    {/if}

    <label class="check"><input type="checkbox" bind:checked={boxEnabled} /> Fixed caption box (region)</label>
    {#if boxEnabled}
      <div class="region">
        <label>X% <input type="number" min="0" max="100" bind:value={boxX} /></label>
        <label>Y% <input type="number" min="0" max="100" bind:value={boxY} /></label>
        <label>W% <input type="number" min="0" max="100" bind:value={boxW} /></label>
        {#if autoHeight}
          <label>Lines <input type="number" min="1" max="6" bind:value={boxLines} /></label>
        {:else}
          <label>H% <input type="number" min="0" max="100" bind:value={boxH} /></label>
        {/if}
      </div>
      <label class="check">
        <input type="checkbox" bind:checked={autoHeight} />
        Auto height (lines × font size{autoHeight ? ` ≈ ${effectiveBoxH}%` : ""})
      </label>
    {/if}
  </section>

  <section class="dict">
    <h2>Dictionary</h2>
    <textarea
      rows="3"
      bind:value={dictionaryText}
      placeholder="Event terms — comma or newline separated (e.g. Kubernetes, PostgreSQL)"
    ></textarea>
    <button onclick={pushDictionary}>Apply now</button>
    <details class="dict-help">
      <summary>How the custom dictionary works</summary>
      <div class="dict-help-body">
        <p>
          After each line is recognized, the dictionary <strong>nudges close-but-wrong
          words back to the spelling you want</strong>. It runs on-device, instantly,
          and applies <strong>live as you type</strong> (the button forces an
          immediate apply). It's deliberately conservative: only a near-miss for one
          of your terms is changed, so ordinary text is never corrupted.
          Capitalization is preserved.
        </p>
        <ul>
          <li>Each term is a <strong>single word of 4+ letters</strong> (very short
            acronyms like “AI”/“CPU” are skipped).</li>
          <li>Only <strong>near-misses</strong> are fixed (a letter or two off) — not
            a word heard as a completely different word.</li>
        </ul>
        <p class="dict-eg">
          e.g. <code>ondansetron, echocardiogram</code> → “ondanZetron” corrected;
          <code>Kubernetes, PostgreSQL</code> → “kubernetis” → “Kubernetes”. A
          sound-alike heard as a different word (“SQL” → “sequel”) isn't a near-miss —
          fix those by clicking the word in <strong>Captions</strong> below.
        </p>
      </div>
    </details>
  </section>

  <section class="export">
    <h2>Export</h2>
    <div class="export-row">
      <span>Transcript</span>
      <button onclick={() => download("txt")} disabled={!store.segments.length}>TXT</button>
      <button onclick={() => download("srt")} disabled={!store.segments.length}>SRT</button>
      <button onclick={() => download("vtt")} disabled={!store.segments.length}>VTT</button>
    </div>
  </section>

  <section class="preview">
    <h2>Captions</h2>
    {#if store.partial && showLive}
      <div class="line partial">{store.partial.text}</div>
    {/if}
    <Corrections
      segments={store.segments}
      dictionary={dictTerms}
      onApply={applyCorrection}
      onUndo={undoCorrection}
      canUndo={undoStack.length > 0}
    />
  </section>
</main>

<style>
  main {
    max-width: 44rem;
    margin: 0 auto;
    padding: 1.5rem 1.25rem 4rem;
    color: #e6e6e6;
    font: 15px/1.4 system-ui, sans-serif;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  h1 {
    font-size: 1.3rem;
    margin: 0;
    flex: 1;
  }
  h2 {
    font-size: 0.95rem;
    color: #aaa;
    margin: 1.2rem 0 0.5rem;
  }
  .pill {
    font-size: 0.75rem;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    background: #222;
    color: #bbb;
    white-space: nowrap;
  }
  .pill.on {
    background: #10391f;
    color: #5fe39b;
  }
  .pill.engine.listening {
    background: #10391f;
    color: #5fe39b;
  }
  .pill.engine.error {
    background: #3a1414;
    color: #e38f8f;
  }
  .row {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  button {
    background: #2a2a2a;
    color: #e6e6e6;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    padding: 0.45rem 0.9rem;
    cursor: pointer;
    font: inherit;
  }
  button:hover {
    background: #333;
  }
  button.go {
    background: #10391f;
    color: #5fe39b;
    border-color: #1d5c34;
  }
  .look,
  .model {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem 1rem;
    align-items: center;
  }
  .look h2,
  .model h2 {
    grid-column: 1 / -1;
  }
  .model-apply {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .model .current {
    font-size: 0.8rem;
    color: #888;
  }
  .model .hint {
    grid-column: 1 / -1;
    font-size: 0.78rem;
    color: #777;
    margin: 0.2rem 0 0;
  }
  .model input {
    background: #1a1a1a;
    color: #e6e6e6;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    padding: 0.3rem 0.4rem;
    font: inherit;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
    color: #ccc;
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }
  select,
  input[type="number"],
  textarea {
    background: #1a1a1a;
    color: #e6e6e6;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    padding: 0.3rem 0.4rem;
    font: inherit;
  }
  .region {
    grid-column: 1 / -1;
    display: flex;
    gap: 0.6rem;
  }
  .region label {
    flex: 1;
  }
  .dict textarea {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 0.5rem;
  }
  .preview {
    margin-top: 1.2rem;
    border-top: 1px solid #2a2a2a;
    padding-top: 0.75rem;
  }
  .preview .line {
    line-height: 1.5;
  }
  .preview .line.partial {
    opacity: 0.6;
  }
  .empty {
    color: #777;
  }
  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .dict-help {
    margin-top: 0.5rem;
    font-size: 0.82rem;
    color: #999;
  }
  .dict-help summary {
    cursor: pointer;
    color: #9fb4d4;
  }
  .dict-help-body {
    margin-top: 0.4rem;
    line-height: 1.5;
  }
  .dict-help code {
    background: #1a1a1a;
    padding: 0 0.2rem;
    border-radius: 3px;
  }
  .export-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: #ccc;
  }
</style>
