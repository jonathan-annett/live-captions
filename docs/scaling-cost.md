# Scaling & cost model — the audience room (Cloudflare Durable Objects)

How the v2 audience layer bills and scales on Cloudflare, and where the levers
are. Written after a dev-session incident where the free-tier daily cap was hit.

> **Verify the numbers.** Cloudflare's included quantities and per-unit rates
> drift. Treat the figures here as the *model* + rough magnitudes; confirm exact
> limits on the current [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
> / [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
> pricing pages before banking on them.

## The room DO uses the SQLite backend → billing is ROWS, not "requests"

`wrangler.v2.jsonc` declares `new_sqlite_classes: ["CaptionRoom"]`, so the room
DO bills on the **SQLite storage** model:

| Meter | What it counts |
|---|---|
| **Rows written** | each `state.storage.put(...)` / SQL write |
| **Rows read** | each `state.storage.get(...)` / SQL read |
| **Duration** | wall-clock time the DO is *active* in memory (128 MB) — hibernation makes idle ~free |
| **Requests** | incoming HTTP requests + **incoming WebSocket messages** + alarms *to* the DO |
| **Workers requests** | separate meter — HTTP hits to the Worker (assets, `/r/new`, `/hf`) |

The generic error we hit — *"Exceeded allowed volume of requests in Durable
Objects free tier"* — is shown for hitting the free **daily** allowance
(rows/requests/duration); the wording says "requests" regardless of sub-meter.

## What drives each meter here (from the code)

- **Captions cost ~zero rows written.** The canonical log is **in-memory**
  (`this.log`, a `Map` in `packages/room/src/room.ts`) — segments are *not*
  persisted per message. `partial`/`final`/`clear` all mutate the Map only. So
  message throughput (partials ~1.4/s + finals) does **not** touch the rows meter.
  Trade-off: the log is **lost if the DO evicts** — accepted (best-effort 30-min
  history; an active room stays warm in memory).
- **Rows written come from housekeeping**, only via `state.storage.put`:
  - `put("token")` — **once** per room.
  - The **alarm loop**: while a room has content, the alarm fires every
    `PRUNE_INTERVAL_MS = 60s` and does `put("idleSince", 0)` + `setAlarm(...)` →
    **~1–2 writes/min per *active* room**. (It rewrites `idleSince=0` even when
    unchanged — see levers.) Empty rooms slow to `IDLE_CHECK_MS = 60 min`; reaped
    after `CLEANUP_IDLE_MS = 24h` idle via `deleteAll()`.
- **Rows read** ≈ history reads on join (`getAlarm`/`get("idleSince")` in alarms
  + late-joiner history), bounded by `RETENTION_MS = 30 min` of retained segments.
- **Requests (incoming WS messages)** ≈ every message the publisher relays to the
  room + each subscriber connect + alarms. This is where a chatty protocol costs.
- **Duration** — hibernation keeps idle rooms ~free; you pay only the brief active
  window per message. Fan-out to more subscribers adds a little per message.

## Audience is cheap — cost tracks *caption throughput*, not viewer count

The DO **broadcasting** a caption to N subscribers is **not** billed per subscriber
— it's one incoming publish message handled once, then sent to all sockets. So:

- A room with 10,000 viewers costs ~the same (requests/rows) as one with 10, for
  the ongoing stream. Each viewer is ~1 connect (+ maybe 1 history read) for the
  whole session, then just receives.
- The meters scale with **how much the publisher sends** and **housekeeping**, not
  audience size. Rows-read is the only one that grows with audience (joins ×
  segments read), and it's bounded by the 30-min retention window.

## Free vs Workers Paid

| | Workers **Free** | Workers **Paid ($5/mo)** |
|---|---|---|
| Worker requests | 100k / **day** | ~10M / month, **no daily cap** |
| DO rows written | ~100k / **day** | ~50M / month |
| DO rows read | ~5M / **day** | ~50M / month |
| DO storage / object | — | ~1 GB |

The critical win of Paid is **no daily cap** — the exact wedge we hit (daily
exhaustion, no reset for hours) can't recur. Overage is trivial (rows-written
~$0.01/M, rows-read ~$0.001/M). At ~120 writes/hr per active room, 50M writes/mo
≈ **~400,000 room-hours/month** included — you are nowhere near it in real use.

## What actually burned the free tier that day

Not real usage — dev noise, now largely fixed:
- the **QR-echo loop** flooding the DO with config relays (incoming-message meter),
- **reconnect churn** from the on-air render lag (re-subscribe traffic),
- many **test rooms** each alarm-looping (`idleSince` writes) + repeated `serve`
  restarts.

Real captioning is a small fraction of that per event-hour.

## Optimization levers (LOW priority — huge headroom already)

Do these only if you ever run thousands of concurrent rooms:

1. **Trim `idleSince` writes** — write it only on the **active→empty transition**
   (start the countdown once), not every 60s tick. Drops a busy room's
   steady-state writes to ~zero. `token`'s single write is irrelevant.
2. **Slow / lazy prune** — raise `PRUNE_INTERVAL_MS` (60s → ~5 min) or prune on
   access, so `setAlarm` fires (and writes) far less often.
3. **Throttle partials relayed to the *cloud* room** — the on-air *local* display
   needs every partial for smoothness, but the cloud **audience** could get finals
   + occasional partials. Cuts the incoming-message (requests) meter and bandwidth
   substantially. Highest-leverage if the requests meter ever matters.

## Why NOT a central "flag cache" Durable Object

Tempting idea: one DO holds all rooms' flags in a Map; rooms recover from it after
eviction. It doesn't work as a cost fix:

- **A cache DO is itself a DO** — its in-memory Map is *also* wiped on eviction, so
  to answer reliably it must persist to *its* storage → the same writes, relocated.
- "Hold state in memory, recover after eviction" is **exactly what `state.storage`
  already is** — the platform's durable cache. A cache DO is a worse reimplementation
  (evicts on a schedule you don't control; adds a cross-DO hop + latency + a hit on
  the requests meter on every room wake; single-point-of-contention at ~1k req/s).
- It *could* **batch** many rooms' writes into one flush (a real but small saving) —
  not worth the complexity given the headroom.

Flags stay in `state.storage` **because they must survive eviction**: `token` (a
reconnecting publisher must still validate) and `idleSince` (the reaper fires after
long idle, i.e. after the DO has definitely evicted). The log is a Map precisely
because it's OK to lose. The right lever is **write-frequency, not location**.

Where a central DO *is* worth building: the **admin room registry** (enumerate live
rooms + usage stats) — a *feature* (Cloudflare can't list DOs natively), not a cost
optimization. See `ROADMAP.md`.

## TL;DR

- Backend is SQLite → **rows read/written** are the meters (plus requests/duration).
- **Captions = in-memory = ~free on rows.** Rows-written is just the per-room
  housekeeping timer; rows-read is bounded by 30-min retention.
- **Audience scales cheaply** — broadcasts aren't billed per viewer.
- **Workers Paid removes the daily cap**; monthly headroom is ~400k room-hours.
- Levers exist (trim `idleSince`, slow prune, throttle cloud partials) but aren't
  needed at this scale. A "flag cache DO" is not the answer — storage already is.
