import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  // Relative base so the built page works when served from the Python
  // desktop server at any path, or opened directly.
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      input: {
        // On-air display (desktop/PWA) and the audience viewer ship together.
        main: resolve(import.meta.dirname, "index.html"),
        viewer: resolve(import.meta.dirname, "viewer.html"),
        // Desktop operator control / config panel (thin client over /ws).
        control: resolve(import.meta.dirname, "control.html"),
      },
    },
  },
});
