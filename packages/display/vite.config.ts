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
  },
});
