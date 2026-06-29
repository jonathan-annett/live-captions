import { CaptionRoom, handleRoomRequest, type RoomEnv } from "@captions/room";

/**
 * Combined v2 Worker for **v2.caption.guru** (the next-major beta channel).
 *
 * One same-origin Worker serves three things, so the audience layer needs no
 * CORS / Origin handling:
 *   1. `/r/*`   → the CaptionRoom audience layer (Durable Object)
 *   2. `/hf/*`  → Hugging Face model proxy (same as the prod PWA Worker)
 *   3. else     → the built PWA static assets (control / display / viewer)
 *
 * Deliberately separate from the prod Worker (`live-captions` → caption.guru):
 * its own name + DO namespace, per the release-channel policy in DEPLOY.md.
 */

const HF_ORIGIN = "https://huggingface.co";

interface Env extends RoomEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export { CaptionRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. Audience room (same-origin, so no CORS needed).
    const room = await handleRoomRequest(request, env);
    if (room) return room;

    // 2. Same-origin Hugging Face model proxy (immutable, edge-cached).
    if (url.pathname.startsWith("/hf/")) {
      const target = HF_ORIGIN + url.pathname.slice(3) + url.search; // drop "/hf"
      const upstream = await fetch(target, {
        method: "GET",
        redirect: "follow",
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });
      const resp = new Response(upstream.body, upstream);
      resp.headers.set("Access-Control-Allow-Origin", "*");
      resp.headers.delete("set-cookie");
      return resp;
    }

    // 3. Static assets (SPA fallback handled by wrangler asset config).
    return env.ASSETS.fetch(request);
  },
};
