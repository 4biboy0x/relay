import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "assets",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: ".vite-src/index.html",
    },
  },
});
