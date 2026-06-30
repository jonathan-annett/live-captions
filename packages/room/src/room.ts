import {
  canReplaceSegment,
  safeParseServerMessage,
  type CaptionSegment,
  type DisplayConfig,
  type EngineStatus,
  type ServerMessage,
} from "@captions/protocol";

/**
 * CaptionRoom — a single live caption room as a Cloudflare Durable Object.
 *
 * One **publisher** (the PWA captioner or desktop hub) holds one outbound
 * WebSocket and pushes the same {@link ServerMessage} stream the display already
 * speaks. Many **subscribers** (audience phones) connect read-only and receive
 * that stream fanned out at the edge, so a subscriber is just a
 * `WebSocketSource` pointed at the subscribe URL.
 *
 * The DO keeps an in-memory **canonical log** of finalized segments, keyed by
 * stable id and **upsert-by-id** (so later refinement/correction replaces a
 * segment in place rather than appending a duplicate). A late joiner is replayed
 * the log as a single `history` message — scrollback is replay, not a new schema.
 *
 * Phase-A defaults (revisitable): rolling **30-minute** retention, **open**
 * subscribe, **token-gated** publish, a **single** source-language stream.
 *
 * Hibernation: sockets are accepted via the hibernatable WebSocket API and
 * tagged `pub`/`sub`, so the DO can evict from memory between messages and the
 * runtime rehydrates it (and the tags) on the next event.
 */

const RETENTION_MS = 30 * 60 * 1000; // Phase-A default: rolling 30 minutes
const PRUNE_INTERVAL_MS = 60 * 1000; // alarm cadence while content is retained

interface Env {
  ROOM: DurableObjectNamespace;
}

interface StoredSegment {
  segment: CaptionSegment;
  /** wall-clock arrival (ms), used only for retention pruning */
  at: number;
}

export class CaptionRoom {
  /** finalized segments, upsert-by-id (insertion order is irrelevant — we sort by start) */
  private readonly log = new Map<string, StoredSegment>();
  private latestConfig: DisplayConfig | null = null;
  private latestStatus: EngineStatus | null = null;
  /** last un-finalized hypothesis, replayed to late joiners as the "live tail" */
  private latestPartial: CaptionSegment | null = null;
  private token: string | null = null;
  private loaded = false;

  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  /** Load the durable bits (publish token) once per rehydration. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.token = (await this.state.storage.get<string>("token")) ?? null;
    this.loaded = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const action = url.pathname.split("/").pop();

    // Internal: the Worker creates the room and hands us its publish token.
    if (action === "init") {
      const token = url.searchParams.get("token");
      if (!token) return jsonResponse({ error: "missing token" }, 400);
      // Idempotent: first writer wins; a repeated init on an existing room is a no-op.
      if (!this.token) {
        this.token = token;
        await this.state.storage.put("token", token);
      }
      return jsonResponse({ ok: true });
    }

    if (action === "publish" || action === "subscribe") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // A room only exists once it has been initialized with a token.
      if (!this.token) return new Response("no such room", { status: 404 });

      const isPub = action === "publish";
      if (isPub && url.searchParams.get("token") !== this.token) {
        return new Response("forbidden", { status: 403 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      // Hibernatable accept + role tag, so we can find subscribers after a wake.
      this.state.acceptWebSocket(server, [isPub ? "pub" : "sub"]);
      if (!isPub) this.sendInitialState(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  // --- hibernatable WebSocket handlers ---------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureLoaded();
    const data = typeof message === "string" ? message : new TextDecoder().decode(message);
    const isPub = this.state.getTags(ws).includes("pub");

    if (isPub) {
      // Publisher feed: validate against the shared protocol, update the
      // canonical log, then forward the validated JSON verbatim to subscribers.
      const msg = safeParseServerMessage(data);
      if (!msg) return;
      this.ingest(msg);
      if (msg.type !== "history") this.broadcast(data);
      return;
    }

    // Subscribers are read-only in Phase A; only history requests are honored.
    const parsed = safeJson(data) as { type?: string; since?: number } | undefined;
    if (parsed?.type === "requestHistory") {
      this.sendHistory(ws, typeof parsed.since === "number" ? parsed.since : undefined);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // already closing
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // already closing
    }
  }

  /** Retention sweep; reschedules itself while any content remains. */
  async alarm(): Promise<void> {
    this.prune();
    if (this.log.size > 0) {
      await this.state.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
  }

  // --- internals -------------------------------------------------------------

  private ingest(msg: ServerMessage): void {
    const now = Date.now();
    switch (msg.type) {
      case "final":
        // upsert-by-id — refinement/correction replaces a segment in place,
        // except an operator-locked segment is never clobbered by a non-locked update.
        if (canReplaceSegment(this.log.get(msg.segment.id)?.segment, msg.segment)) {
          this.log.set(msg.segment.id, { segment: msg.segment, at: now });
        }
        this.latestPartial = null;
        this.prune();
        void this.ensureAlarm();
        break;
      case "partial":
        this.latestPartial = msg.segment;
        break;
      case "clear":
        this.log.clear();
        this.latestPartial = null;
        break;
      case "config":
        this.latestConfig = msg.config;
        break;
      case "status":
        this.latestStatus = msg.status;
        break;
      case "history":
        // A publisher may seed/replace the canonical log (e.g. session resume),
        // but a live operator-locked segment still wins over a non-locked replay.
        for (const seg of msg.segments) {
          if (canReplaceSegment(this.log.get(seg.id)?.segment, seg)) {
            this.log.set(seg.id, { segment: seg, at: now });
          }
        }
        break;
    }
  }

  /** Canonical log in display order (by segment start time). */
  private orderedSegments(since?: number): CaptionSegment[] {
    const segs = [...this.log.values()].map((s) => s.segment);
    segs.sort((a, b) => a.start - b.start);
    return since == null ? segs : segs.filter((s) => s.end >= since);
  }

  /** Replay current room state to a freshly connected subscriber. */
  private sendInitialState(ws: WebSocket): void {
    if (this.latestConfig) send(ws, { type: "config", config: this.latestConfig });
    if (this.latestStatus) send(ws, { type: "status", status: this.latestStatus });
    const segments = this.orderedSegments();
    if (segments.length) send(ws, { type: "history", segments });
    if (this.latestPartial) send(ws, { type: "partial", segment: this.latestPartial });
  }

  private sendHistory(ws: WebSocket, since?: number): void {
    send(ws, { type: "history", segments: this.orderedSegments(since) });
  }

  private broadcast(data: string): void {
    for (const ws of this.state.getWebSockets("sub")) {
      try {
        ws.send(data);
      } catch {
        // socket gone; close handler will reap it
      }
    }
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, s] of this.log) {
      if (s.at < cutoff) this.log.delete(id);
    }
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
