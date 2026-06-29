import { CaptionRoom } from "./room.js";

/**
 * Worker entry for the isolated CaptionRoom audience layer (v2 Phase A).
 *
 * Routes:
 *  - `POST /r/new`            → create a room; returns id + publish token + URLs
 *  - `GET  /r/:id/publish`    → WebSocket upgrade for the source (token required)
 *  - `GET  /r/:id/subscribe`  → WebSocket upgrade for audience (open)
 *
 * The room id is used directly as the Durable Object name, so any colo can route
 * to the same room instance. The publish token gates write access; subscribe is
 * open (link/QR) per the Phase-A defaults.
 */

export { CaptionRoom };

interface Env {
  ROOM: DurableObjectNamespace;
}

// Subscribe is a WebSocket (CORS-exempt); only /r/new is a browser fetch, so we
// keep CORS permissive for it — room URLs are unguessable bearer capabilities.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const ROOM_ROUTE = /^\/r\/([A-Za-z0-9_-]+)\/(publish|subscribe)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

    return new Response("not found", { status: 404, headers: CORS });
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
