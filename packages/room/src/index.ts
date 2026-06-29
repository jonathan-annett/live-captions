import { CaptionRoom } from "./room.js";

/**
 * CaptionRoom audience layer (v2).
 *
 * {@link handleRoomRequest} is the reusable router — it owns the `/r/*` routes
 * and returns `null` for anything else, so it can be composed into a larger
 * Worker (e.g. the same-origin v2 Worker that also serves the PWA + /hf). The
 * default export wraps it as a standalone Worker for isolated dev/testing.
 *
 * Routes:
 *  - `POST /r/new`            → create a room; returns id + publish token + URLs
 *  - `GET  /r/:id/publish`    → WebSocket upgrade for the source (token required)
 *  - `GET  /r/:id/subscribe`  → WebSocket upgrade for audience (open)
 */

export { CaptionRoom };

export interface RoomEnv {
  ROOM: DurableObjectNamespace;
}

// Subscribe is a WebSocket (CORS-exempt); only /r/new is a browser fetch. When
// the room is composed same-origin (v2) these never fire; they matter only if
// the room is deployed standalone and reached cross-origin.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const ROOM_ROUTE = /^\/r\/([A-Za-z0-9_-]+)\/(publish|subscribe)$/;

/**
 * Handle the room's `/r/*` routes. Returns a `Response` for room requests, or
 * `null` if the request isn't a room route (so a host Worker can fall through).
 */
export async function handleRoomRequest(
  request: Request,
  env: RoomEnv,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith("/r/")) return null;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (url.pathname === "/r/new" && request.method === "POST") {
    const id = makeRoomId();
    const token = makeToken();
    const stub = env.ROOM.get(env.ROOM.idFromName(id));
    const init = await stub.fetch(`https://room/init?token=${token}`);
    if (!init.ok) {
      return new Response("room init failed", { status: 502, headers: CORS });
    }
    const body = {
      id,
      publishToken: token,
      publishUrl: wsUrl(url.origin, `/r/${id}/publish?token=${token}`),
      subscribeUrl: wsUrl(url.origin, `/r/${id}/subscribe`),
    };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", ...CORS },
    });
  }

  const match = ROOM_ROUTE.exec(url.pathname);
  if (match) {
    const id = match[1]!;
    const action = match[2]!;
    const stub = env.ROOM.get(env.ROOM.idFromName(id));
    // Forward the upgrade (and ?token=) to the room DO unchanged.
    return stub.fetch(new Request(`https://room/${action}${url.search}`, request));
  }

  return null;
}

export default {
  async fetch(request: Request, env: RoomEnv): Promise<Response> {
    return (
      (await handleRoomRequest(request, env)) ??
      new Response("not found", { status: 404, headers: CORS })
    );
  },
};

// Unambiguous room ids (no 0/1/o/i/l); ~8 chars from the CSPRNG.
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

function makeRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

function makeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function wsUrl(origin: string, path: string): string {
  return origin.replace(/^http/, "ws") + path;
}
