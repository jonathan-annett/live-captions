import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the app works at the Pages root or any subpath.
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
