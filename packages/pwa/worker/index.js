// Cloudflare Worker for the PWA: serves the static assets and proxies Hugging
// Face model files through this same origin under /hf/*.
//
// Why: fetching Whisper models cross-origin from huggingface.co is unreliable in
// the browser (LFS weights redirect to CDN hosts that don't return CORS headers,
// and cross-origin isolation makes it worse). Proxying makes every model request
// same-origin — no CORS at all — and Cloudflare caches the (immutable, per-
// revision) files at the edge. transformers.js is pointed here via env.remoteHost.

const HF_ORIGIN = "https://huggingface.co";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/hf/")) {
      const target = HF_ORIGIN + url.pathname.slice(3) + url.search; // drop "/hf"
      const upstream = await fetch(target, {
        method: "GET",
        redirect: "follow",
        // Cache model files at the edge; they're immutable per revision.
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });
      const resp = new Response(upstream.body, upstream);
      resp.headers.set("Access-Control-Allow-Origin", "*");
      resp.headers.delete("set-cookie");
      return resp;
    }

    // Everything else: static assets (with SPA fallback from wrangler config).
    return env.ASSETS.fetch(request);
  },
};
