# @captions/room — audience-layer transport (v2 Phase A)

A `CaptionRoom` Cloudflare **Durable Object** + Worker that fans one publisher's
caption stream out to many audience subscribers at the edge.

> **Isolated by design.** This is a *separate* Worker (`caption-room`) from the
> production PWA Worker (`live-captions`, bound to caption.guru). Phase A is
> built and verified here in isolation and is **not** wired into the production
> Worker until the v2 audience layer is ready.

## Protocol

The publisher pushes the same [`ServerMessage`](../protocol/src/index.ts) stream
the display already speaks (`partial` / `final` / `clear` / `config` / `status`
/ `history`). A subscriber therefore *is* a `WebSocketSource` pointed at the
subscribe URL — no new client schema (sets up Phase B).

The DO keeps an in-memory **canonical log** of finalized segments, **upsert-by-id**
(later refinement/correction replaces in place). A late joiner is replayed the
log as one `history` message.

## Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/r/new` | POST | — | Create a room → `{ id, publishToken, publishUrl, subscribeUrl }` |
| `/r/:id/publish` | WS | `?token=` | Source pushes the caption stream |
| `/r/:id/subscribe` | WS | open | Audience receives the stream + history |

## Phase-A defaults (revisitable)

- Retention: rolling **30 minutes**.
- Subscribe **open** (link/QR); publish **token-gated**.
- **Single** source-language stream (the id scheme reserves `:lang` for later
  per-language rooms).

## Develop & verify

```sh
pnpm --filter @captions/room dev       # wrangler dev (local DO)
pnpm --filter @captions/room verify    # publisher + 2 subscribers smoke test
pnpm --filter @captions/room typecheck
```

## TODO — before wiring into the beta channel

- **Validate the `Origin` header** on `subscribe` (and `publish`) against an allowlist.
  Phase A leaves subscribe fully open (publish is token-gated) since it runs in isolation.
  Once the beta PWA at `vN.caption.guru` connects to this Worker it is **cross-origin**, so
  the room must check `Origin` itself (WebSockets aren't CORS-gated). See `DEPLOY.md` →
  "Release channels".
- **Bump to `wrangler@4`** before any real deploy — the local v3 runtime caps the compat
  date (warns on `2026-06-01`, falls back to `2025-07-18`).
