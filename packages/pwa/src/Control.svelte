<script lang="ts">
  import { onMount } from "svelte";
  import {
    DEFAULT_DISPLAY_CONFIG,
    exportTranscript,
    type Background,
    type CaptionSegment,
    type DisplayConfig,
    type ExportFormat,
    type ServerMessage,
  } from "@captions/protocol";
  import {
    qrSlidePngBlob,
    qrSvg,
    RoomPublisher,
    roomPublishUrl,
    RoomSource,
    type ConnectionState,
  } from "@captions/display";
  import { Captioner } from "./engine/captioner.js";
  import Corrections from "./Corrections.svelte";
  import { UiStore } from "./uiStore.svelte.js";
  import {
    clearLastRoom,
    clearSession,
    loadLastRoom,
    loadSession,
    saveLastRoom,
    saveSession,
    type LastRoom,
    type PersistedSession,
  } from "./session.js";

  const CHANNEL = "captions";
  // `size` is the approximate one-time download (cached after first use), shown
  // in the picker so the cost is clear before choosing. Large models are gated
  // behind ?experimental=1 — they can stall on in-browser WebGPU (q4f16 decode)
  // and really want a strong GPU.
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
  const selectedModel = $derived(MODELS.find((m) => m.id === model));

  const appName = location.hostname.endsWith("caption.guru")
    ? "Caption Guru"
    : "Live Captions";

  // Persist the operator's model + mic choices so a reload doesn't snap back to
  // the default (base.en, the weakest model) — that was skewing test results.
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
  let dictionaryText = $state("");
  let running = $state(false);
  let captioner: Captioner | null = null;

  // Save selections as they change.
  $effect(() => lsSet(LS_MODEL, model));
  $effect(() => lsSet(LS_DEVICE, deviceId));

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
  // Session recovery: while transcribing with a room open we persist enough to
  // rebuild the session after a refresh. `recovering` (set on load from a fresh
  // record) drives the full-screen resume mask; the room + transcript are
  // restored immediately, and a gesture re-arms the mic (browser autoplay rule).
  let recovering = $state<PersistedSession | null>(null);
  let publishToken: string | null = null; // remembered for the persist record
  let resuming = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionStartedAt = 0;
  // When the active room was created (for the "started at …" indicator), and the
  // most recently stopped room (offer to reopen the same id/token).
  let roomStartedAt = $state(0);
  let lastRoom = $state<LastRoom | null>(loadLastRoom());
  // Audience devices currently connected to the room (from the DO's `presence`).
  let deviceCount = $state<number | null>(null);

  // The QR/join target is the short audience page /room?<id>. When the room's
  // WebSocket lives on a different origin than this page, fall back to the
  // explicit /room?room=<id>&base=<origin> form so the viewer knows where to connect.
  function joinUrlFor(id: string): string {
    const u = new URL("room", location.href);
    if (roomBase === location.origin) {
      u.search = id; // → /room?<id>
    } else {
      u.searchParams.set("room", id);
      u.searchParams.set("base", roomBase);
    }
    return u.href;
  }

  // The control owns the on-air display config (pushed over the channel). The
  // QR overlay only renders on the display in chroma-key mode (by design).
  const configChannel = new BroadcastChannel(CHANNEL);

  // On-air look (persisted to localStorage). Three colours: chroma key (bgColor),
  // optional opaque caption-box fill (boxColor), and text (textColor); plus font,
  // size and justification.
  const FONTS = [
    { label: "Sans (Inter)", value: DEFAULT_DISPLAY_CONFIG.fontFamily },
    { label: "System UI", value: "system-ui, sans-serif" },
    { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
    { label: "Monospace", value: "'SF Mono', Consolas, ui-monospace, monospace" },
  ];
  const LS_LOOK = "cg.look";
  const savedLook: Record<string, unknown> = (() => {
    try {
      return JSON.parse(lsGet(LS_LOOK) ?? "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const lookStr = (k: string, d: string) =>
    typeof savedLook[k] === "string" ? (savedLook[k] as string) : d;
  const lookNum = (k: string, d: number) =>
    typeof savedLook[k] === "number" ? (savedLook[k] as number) : d;

  let bgKind = $state<Background["kind"]>(
    (savedLook.bgKind as Background["kind"]) ?? DEFAULT_DISPLAY_CONFIG.background.kind,
  );
  let bgColor = $state<string>(lookStr("bgColor", "#00b140"));
  let textColor = $state<string>(lookStr("textColor", DEFAULT_DISPLAY_CONFIG.color));
  let fontFamily = $state<string>(lookStr("fontFamily", DEFAULT_DISPLAY_CONFIG.fontFamily));
  let fontSize = $state<number>(lookNum("fontSize", DEFAULT_DISPLAY_CONFIG.fontSize));
  let fontWeight = $state<number>(lookNum("fontWeight", DEFAULT_DISPLAY_CONFIG.fontWeight));
  let orientation = $state<DisplayConfig["orientation"]>(
    (savedLook.orientation as DisplayConfig["orientation"]) ?? DEFAULT_DISPLAY_CONFIG.orientation,
  );
  let textAlign = $state<DisplayConfig["textAlign"]>(
    (savedLook.textAlign as DisplayConfig["textAlign"]) ?? DEFAULT_DISPLAY_CONFIG.textAlign,
  );
  let boxFill = $state<boolean>(savedLook.boxFill === true);
  let boxColor = $state<string>(lookStr("boxColor", "#000000"));
  let boxRadius = $state<number>(lookNum("boxRadius", 0));
  // Fixed caption box (region, % of frame). When on, the display renders a deeper
  // window clipped to this box, scrolling older text off the top.
  let boxEnabled = $state<boolean>(savedLook.boxEnabled === true);
  let boxX = $state<number>(lookNum("boxX", 6));
  let boxY = $state<number>(lookNum("boxY", 68));
  let boxW = $state<number>(lookNum("boxW", 88));
  let boxH = $state<number>(lookNum("boxH", 26));
  // Auto height: derive the box height from #lines × font size (line-height 1.25
  // on the display + a little padding), so the operator sizes by lines, not %.
  let autoHeight = $state<boolean>(savedLook.autoHeight !== false);
  let boxLines = $state<number>(lookNum("boxLines", 2));
  const computedBoxH = $derived(
    Math.min(100, Math.max(5, Math.round(fontSize * (1.3 * boxLines + 0.8)))),
  );
  const effectiveBoxH = $derived(autoHeight ? computedBoxH : boxH);
  // Show the live (un-finalized) "bleeding edge" hypothesis. Off = lower latency
  // captions but fewer mid-utterance errors on screen.
  let showLive = $state<boolean>(savedLook.showLive !== false);
  let uppercase = $state<boolean>(savedLook.uppercase === true);
  let qr = $state<DisplayConfig["qr"]>(undefined);

  // Derived from its parts (never mutated in place) so updating it can't loop.
  const displayConfig = $derived.by<DisplayConfig>(() => {
    const background: Background =
      bgKind === "transparent" ? { kind: "transparent" } : { kind: bgKind, color: bgColor };
    return {
      ...DEFAULT_DISPLAY_CONFIG,
      background,
      color: textColor,
      fontFamily,
      fontSize,
      fontWeight,
      orientation,
      textAlign,
      showPartial: showLive,
      uppercase,
      ...(boxFill ? { boxColor, ...(boxRadius ? { boxRadius } : {}) } : {}),
      ...(boxEnabled
        ? { region: { x: boxX, y: boxY, width: boxW, height: effectiveBoxH } }
        : {}),
      ...(qr ? { qr } : {}),
    };
  });

  // Persist the look (qr is room-driven, not part of the saved look).
  $effect(() => {
    lsSet(
      LS_LOOK,
      JSON.stringify({
        bgKind,
        bgColor,
        textColor,
        fontFamily,
        fontSize,
        fontWeight,
        orientation,
        textAlign,
        boxFill,
        boxColor,
        boxRadius,
        boxEnabled,
        boxX,
        boxY,
        boxW,
        boxH,
        autoHeight,
        boxLines,
        showLive,
        uppercase,
      }),
    );
  });

  // Push to the on-air display AND the audience room whenever the config changes
  // (write-only side effect — no reactive state is written here, so no update
  // loop). Teeing to the room keeps the DO's latestConfig current so audience
  // late-joiners get the operator's look, not defaults.
  $effect(() => {
    const msg: ServerMessage = {
      type: "config",
      config: $state.snapshot(displayConfig),
    };
    configChannel.postMessage(msg);
    publisher?.publish(msg);
  });

  // Snapshot the room should be (re)seeded with on each (re)connect: current
  // config + the full transcript so far. Covers starting a room mid-session and
  // restoring the DO log after hibernation (the DO ingests history lock-aware).
  function roomSnapshot(): ServerMessage[] {
    return [
      { type: "config", config: $state.snapshot(displayConfig) },
      { type: "history", segments: $state.snapshot(store.finals) },
    ];
  }

  // A display that connects later asks for the current config (BroadcastChannel
  // doesn't replay); reply so it doesn't stay on defaults (e.g. miss chroma).
  configChannel.onmessage = (ev) => {
    if ((ev.data as { type?: string } | null)?.type === "requestConfig") {
      configChannel.postMessage({ type: "config", config: $state.snapshot(displayConfig) });
    }
  };

  function resolvePublishUrl(): string | null {
    const params = new URLSearchParams(location.search);
    const direct = params.get("publish");
    if (direct) return direct;
    const r = params.get("room");
    const token = params.get("token");
    if (r && token) return roomPublishUrl(r, token, params.get("base") ?? undefined);
    return null;
  }

  // All publisher sockets share the same wiring: connection state, re-seed on
  // (re)connect, and inbound room messages (currently the presence count).
  function onRoomMessage(msg: ServerMessage): void {
    if (msg.type === "presence") deviceCount = msg.count;
  }
  function newPublisher(url: string): RoomPublisher {
    return new RoomPublisher(url, {
      onState: (s) => (publishState = s),
      seed: roomSnapshot,
      onMessage: onRoomMessage,
    });
  }

  async function startRoom(): Promise<void> {
    roomError = null;
    try {
      const res = await fetch(`${roomBase}/r/new`, { method: "POST" });
      if (!res.ok) throw new Error(`room server returned ${res.status}`);
      const r = await res.json();
      const joinUrl = joinUrlFor(r.id);
      room = { id: r.id, joinUrl };
      publishToken = r.publishToken;
      sessionStartedAt = Date.now();
      roomStartedAt = Date.now();
      // A freshly minted room supersedes any remembered stopped room.
      lastRoom = null;
      clearLastRoom();
      publisher?.stop();
      publisher = newPublisher(r.publishUrl);
      publisher.start();
      // Advertise the join QR on the display (shown only in chroma mode);
      // the $effect picks this up and pushes the new config.
      qr = { url: joinUrl, x: 72, y: 6, size: 24 };
    } catch (err) {
      roomError = String(err);
    }
  }

  function stopRoom(): void {
    // Remember the room so it can be reopened — its DO keeps the token (and, for
    // 30 min, the transcript), so restarting reconnects the same audience link.
    if (room && publishToken) {
      const remembered: LastRoom = {
        roomId: room.id,
        publishToken,
        roomBase,
        joinUrl: room.joinUrl,
        startedAt: roomStartedAt || Date.now(),
        stoppedAt: Date.now(),
      };
      saveLastRoom(remembered);
      lastRoom = remembered;
    }
    publisher?.stop();
    publisher = null;
    publishState = null;
    publishToken = null;
    deviceCount = null;
    qr = undefined;
    room = null;
    clearSession();
  }

  // Reopen the most recently stopped room (same id + token). Audience devices
  // that kept the link/QR reconnect; late joiners get whatever history the DO
  // still retains. If captioning is live, output tees to it immediately.
  function restartRoom(): void {
    const last = lastRoom;
    if (!last) return;
    roomError = null;
    room = { id: last.roomId, joinUrl: last.joinUrl };
    publishToken = last.publishToken;
    roomStartedAt = last.startedAt;
    sessionStartedAt = last.startedAt;
    qr = { url: last.joinUrl, x: 72, y: 6, size: 24 };
    publisher?.stop();
    publisher = newPublisher(
      roomPublishUrl(last.roomId, last.publishToken, last.roomBase),
    );
    publisher.start();
    lastRoom = null;
    clearLastRoom();
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

  // --- session recovery -----------------------------------------------------
  // Persist a recovery record while transcribing with a room open; debounced so
  // a burst of finals doesn't thrash localStorage. Cleared the moment the
  // session isn't live (explicit Stop / Stop room), so a clean stop never offers
  // recovery.
  $effect(() => {
    const live = running && !!room && !!publishToken;
    const count = store.finals.length; // reactive dep: re-run as transcript grows
    void count;
    if (!live) {
      // Cancel a pending save, but DON'T clear the record here. Clearing is
      // explicit (Stop / Stop room). A reactive clear would wipe the record on
      // the initial mount — before onMount's loadSession() can read it — and
      // again in the pre-resume state, so the mask would never appear.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      return;
    }
    if (saveTimer) return; // a write is already scheduled
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (running && room && publishToken) {
        saveSession({
          roomId: room.id,
          publishToken,
          roomBase,
          joinUrl: room.joinUrl,
          model,
          deviceId,
          startedAt: sessionStartedAt || Date.now(),
          updatedAt: Date.now(),
          finals: $state.snapshot(store.finals),
        });
      }
    }, 1500);
  });

  // Warn before leaving while live — an accidental tab close/refresh drops the
  // mic (recovery re-arms it, but the heads-up avoids surprise).
  $effect(() => {
    if (!running) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  });

  // While the resume mask is up, any gesture attempts to re-arm the mic. We
  // listen broadly (a passive mousemove resumes audio where the browser allows);
  // resumeGesture() verifies the context actually started and only drops the
  // mask then, so a discrete click/keypress remains the guaranteed fallback.
  $effect(() => {
    if (!recovering) return;
    const events = [
      "pointermove",
      "mousemove",
      "pointerdown",
      "click",
      "keydown",
      "touchstart",
    ];
    const handler = (ev: Event): void => {
      // Gestures over the card are for its own buttons (so "Start fresh" stays
      // reachable — otherwise a mousemove toward it would auto-resume first).
      // Anywhere else, any gesture resumes.
      const t = ev.target as Element | null;
      if (t?.closest?.(".resume-card")) return;
      void resumeGesture();
    };
    for (const e of events) window.addEventListener(e, handler, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, handler);
    };
  });

  // Rebuild a live session from a persisted record: restore engine choice +
  // transcript, reconnect the same room (audience never dropped — the DO kept
  // the log + token), pull the DO's canonical history to reconcile, then raise
  // the resume mask.
  function recoverSession(saved: PersistedSession): void {
    // Raise the mask first — the room reconnect below is best-effort and must
    // never suppress the resume prompt if it throws.
    recovering = saved;
    model = saved.model;
    deviceId = saved.deviceId;
    sessionStartedAt = saved.startedAt;
    roomStartedAt = saved.startedAt;
    publishToken = saved.publishToken;
    for (const seg of saved.finals) store.apply({ type: "final", segment: seg });
    room = { id: saved.roomId, joinUrl: saved.joinUrl };
    qr = { url: saved.joinUrl, x: 72, y: 6, size: 24 };
    try {
      publisher = newPublisher(
        roomPublishUrl(saved.roomId, saved.publishToken, saved.roomBase),
      );
      publisher.start();
      reconcileFromRoom(saved.roomId, saved.roomBase);
    } catch (err) {
      roomError = String(err);
    }
  }

  // One-shot subscriber to pull the room's canonical history (covers a transcript
  // that outgrew localStorage or a cross-device recovery); upsert-by-id merges it
  // with the locally-restored finals. Closes on first history or after a timeout.
  function reconcileFromRoom(roomId: string, base: string): void {
    let src: RoomSource | null = RoomSource.forRoom(roomId, base);
    let closed = false;
    const done = (): void => {
      if (closed) return;
      closed = true;
      src?.disconnect();
      src = null;
    };
    src.connect((msg) => {
      if (msg.type === "history") {
        for (const seg of msg.segments) store.apply({ type: "final", segment: seg });
        done();
      }
    });
    setTimeout(done, 5000);
  }

  // A recovery gesture: build the capture pipeline (once) and resume the audio
  // context. A passive gesture may not satisfy autoplay policy — resume() returns
  // false — so we keep the mask until a gesture actually starts the context.
  async function resumeGesture(): Promise<void> {
    if (!recovering || resuming) return;
    resuming = true;
    try {
      if (!captioner || !running) {
        captioner = null;
        await start();
      }
      const ok = (await captioner?.resume()) ?? false;
      if (ok) recovering = null;
    } finally {
      resuming = false;
    }
  }

  // Decline recovery: drop the record, disconnect the reconnected room, and clear
  // the restored transcript for a clean slate.
  function dismissRecovery(): void {
    recovering = null;
    clearSession();
    stopRoom();
    store.apply({ type: "clear" });
  }

  // Single funnel for the captioner's output: mirror to the UI, and (when
  // publishing) tee to the room.
  function sink(msg: ServerMessage): void {
    store.apply(msg);
    publisher?.publish(msg);
  }

  // --- operator correction --------------------------------------------------
  // A corrected (locked) final fans out exactly like a captioner emit: operator
  // preview, the on-air display (the "captions" BroadcastChannel = configChannel),
  // and the audience room. Lock-aware upsert means it replaces in place and isn't
  // clobbered by the engine. Pre-edit segment states are kept for one-step undo.
  let undoStack = $state<CaptionSegment[]>([]);

  function emitFinal(segment: CaptionSegment): void {
    const msg: ServerMessage = { type: "final", segment };
    store.apply(msg);
    configChannel.postMessage(msg);
    publisher?.publish(msg);
  }

  function applyCorrection(seg: CaptionSegment): void {
    const prior = store.finals.find((s) => s.id === seg.id);
    if (prior) undoStack = [...undoStack, $state.snapshot(prior)];
    emitFinal(seg);
  }

  // Wipe the transcript everywhere — operator preview, on-air display, and the
  // audience room — via the shared clear message (all stores + the DO handle it).
  function clearAll(): void {
    const msg: ServerMessage = { type: "clear" };
    store.apply(msg);
    configChannel.postMessage(msg);
    publisher?.publish(msg);
    undoStack = [];
  }

  function undoCorrection(): void {
    const prior = undoStack.at(-1);
    if (!prior) return;
    undoStack = undoStack.slice(0, -1);
    // Force the restore to win over the current locked text.
    emitFinal({ ...prior, locked: true });
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
    // Recover a live session after a refresh (room + transcript now, mic on the
    // first gesture). Takes precedence over the legacy URL-publish path.
    const saved = loadSession();
    if (saved) {
      recoverSession(saved);
    } else if (publishUrl) {
      // Legacy/power-user path: a publish target given in the URL starts relaying
      // immediately (independent of the "Start room" button).
      publisher = newPublisher(publishUrl);
      publisher.start();
    }
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
      const msg: ServerMessage = {
        type: "status",
        status: { state: "error", message: String(err) },
      };
      store.apply(msg);
      publisher?.publish(msg);
    }
  }

  function stop() {
    // Stops captioning only; an active room keeps running until "Stop room".
    captioner?.stop();
    captioner = null;
    running = false;
    // A deliberate stop ends the recoverable session (a refresh shouldn't
    // resurrect it); an active room stays up until "Stop room".
    clearSession();
  }

  function openDisplay() {
    window.open(
      `./display.html?source=broadcast&channel=${CHANNEL}`,
      "captions-display",
    );
  }

  // --- build stamp ----------------------------------------------------------
  // Baked in at build time (vite `define`), shown in the header so a refresh
  // confirms which deploy is live. `buildClock` ticks so the relative age stays
  // current without a reload.
  const buildTime = __BUILD_TIME__;
  const buildAt = new Date(buildTime);
  let buildClock = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (buildClock = Date.now()), 30_000);
    return () => clearInterval(id);
  });
  function fmtAge(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  const buildLabel = $derived(
    `built ${buildAt.toLocaleTimeString()} · ${fmtAge(buildClock - buildTime)}`,
  );

  const statusLabel = $derived(
    store.status.state === "listening"
      ? `listening · ${store.status.device ?? ""} · ${store.status.model?.split("/").pop() ?? ""}`
      : (store.status.message ?? store.status.state),
  );
</script>

{#if recovering}
  <div class="resume-mask">
    <div class="resume-card">
      <h2>Recovering your session…</h2>
      <p>
        Your audience room and transcript are back — the audience never lost
        connection. Move the mouse, click, or press any key to re-enable the
        microphone and continue captioning.
      </p>
      <div class="resume-actions">
        <button class="start" onclick={() => void resumeGesture()}>
          Resume captioning
        </button>
        <button onclick={dismissRecovery}>Start fresh</button>
      </div>
    </div>
  </div>
{/if}

<main>
  <header>
    <h1>{appName}</h1>
    <span class="pill build" title="Build baked in at deploy — {buildAt.toLocaleString()}">
      {buildLabel}
    </span>
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
        {bgKind === "chroma" ? "Chroma key color" : "Background color"}
        <input type="color" bind:value={bgColor} />
      </label>
    {/if}

    <label>
      Text color
      <input type="color" bind:value={textColor} />
    </label>

    <label>
      Font
      <select bind:value={fontFamily}>
        {#each FONTS as f (f.value)}
          <option value={f.value}>{f.label}</option>
        {/each}
      </select>
    </label>

    <label>
      Text size · {fontSize}vh
      <input type="range" min="2" max="14" step="0.5" bind:value={fontSize} />
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
      Orientation
      <select bind:value={orientation}>
        <option value="horizontal">Horizontal</option>
        <option value="vertical">Vertical</option>
      </select>
    </label>

    <label class="check">
      <input type="checkbox" bind:checked={showLive} />
      Show live text (off = a bit slower, fewer errors)
    </label>

    <label class="check">
      <input type="checkbox" bind:checked={uppercase} />
      Uppercase
    </label>

    <label class="check">
      <input type="checkbox" bind:checked={boxEnabled} />
      Fixed caption box (clips + scrolls within a set size)
    </label>

    {#if boxEnabled}
      <label>
        Box left · {boxX}%
        <input type="range" min="0" max="90" step="1" bind:value={boxX} />
      </label>
      <label>
        Box top · {boxY}%
        <input type="range" min="0" max="95" step="1" bind:value={boxY} />
      </label>
      <label>
        Box width · {boxW}%
        <input type="range" min="20" max="100" step="1" bind:value={boxW} />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={autoHeight} />
        Auto height (from lines × font size)
      </label>
      {#if autoHeight}
        <label>
          Lines · {boxLines} (height ≈ {effectiveBoxH}%)
          <input type="range" min="1" max="6" step="1" bind:value={boxLines} />
        </label>
      {:else}
        <label>
          Box height · {boxH}%
          <input type="range" min="10" max="100" step="1" bind:value={boxH} />
        </label>
      {/if}
    {/if}

    <label class="check">
      <input type="checkbox" bind:checked={boxFill} />
      Opaque caption box
    </label>

    {#if boxFill}
      <label>
        Box color
        <input type="color" bind:value={boxColor} />
      </label>
      <label>
        Corner radius · {boxRadius}vh
        <input type="range" min="0" max="6" step="0.5" bind:value={boxRadius} />
      </label>
    {/if}

    <div class="buttons">
      {#if running}
        <button class="stop" onclick={stop}>Stop</button>
      {:else}
        <button class="start" onclick={start}>Start captioning</button>
      {/if}
      <button onclick={openDisplay}>Open display ↗</button>
      <button
        onclick={clearAll}
        disabled={!store.finals.length && !store.partial}
      >
        Clear
      </button>
    </div>
  </section>

  <section class="room">
    {#if room}
      <div class="room-live">
        <div class="room-info">
          <strong>Live room</strong>
          {#if roomStartedAt}
            <span class="room-started">
              started {new Date(roomStartedAt).toLocaleTimeString()} · {fmtAge(
                buildClock - roomStartedAt,
              )}
            </span>
          {/if}
          {#if deviceCount !== null}
            <span class="room-devices">
              {deviceCount} device{deviceCount === 1 ? "" : "s"} connected
            </span>
          {/if}
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
      <div class="room-idle">
        <button class="start" onclick={startRoom}>Start audience room</button>
        {#if lastRoom}
          <button onclick={restartRoom} title="Reopen the same room — audience who kept the link rejoin">
            Restart last room · started {new Date(
              lastRoom.startedAt,
            ).toLocaleTimeString()}
          </button>
        {/if}
      </div>
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
          <em>sound-alike</em>, not a near-miss — fix those live by clicking the
          word in <strong>Corrections</strong> below (sound-alike picker), which
          also ranks against this dictionary.</p>
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
    {#if store.partial}
      <div class="line partial">{store.partial.text}</div>
    {/if}
    <Corrections
      segments={store.finals}
      dictionary={dictionaryTerms()}
      onApply={applyCorrection}
      onUndo={undoCorrection}
      canUndo={undoStack.length > 0}
    />
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
  .pill.build {
    background: #14181f;
    color: #7f8ca0;
    font-variant-numeric: tabular-nums;
    cursor: default;
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
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
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
  .room-started {
    font-size: 0.8rem;
    color: #8a97a8;
    font-variant-numeric: tabular-nums;
  }
  .room-devices {
    font-size: 0.85rem;
    color: #5fe39b;
    font-variant-numeric: tabular-nums;
  }
  .room-idle {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .room-err {
    color: #ff8a8a;
    font-size: 0.85rem;
  }
  .resume-mask {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    background: rgba(6, 8, 12, 0.92);
    backdrop-filter: blur(3px);
  }
  .resume-card {
    max-width: 30rem;
    text-align: center;
    background: #12161d;
    border: 1px solid #263041;
    border-radius: 12px;
    padding: 2rem;
  }
  .resume-card h2 {
    margin: 0 0 0.75rem;
    font-size: 1.3rem;
  }
  .resume-card p {
    color: #9fb0c4;
    line-height: 1.5;
    margin: 0 0 1.25rem;
  }
  .resume-actions {
    display: flex;
    gap: 0.6rem;
    justify-content: center;
  }
</style>
