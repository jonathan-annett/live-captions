import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [svelte()],
  // Relative base so the app works at the Pages root or any subpath.
  base: "./",
  // Don't pre-bundle the workspace Svelte lib or the (large) ASR runtime.
  optimizeDeps: { exclude: ["@captions/display", "@huggingface/transformers"] },
  worker: { format: "es" },
  // Mirror the production Worker's /hf proxy so model loading works in dev too.
  server: {
    proxy: {
      "/hf": {
        target: "https://huggingface.co",
        changeOrigin: true,
        followRedirects: true,
        rewrite: (p) => p.replace(/^\/hf/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      input: {
        // Same-origin pages: control + display share a BroadcastChannel; the
        // viewer is the audience join target (the QR points here).
        main: resolve(root, "index.html"), // operator control
        display: resolve(root, "display.html"), // on-air surface
        room: resolve(root, "room.html"), // audience join page → /room?<id>
        viewer: resolve(root, "viewer.html"), // audience viewer (legacy entry)
      },
    },
  },
});
