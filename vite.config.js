import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: ".vite-src/index.html",
        realtimeDemo: ".vite-src/realtime-demo-client.js",
      },
      output: {
        entryFileNames: "assets/[name].js",
      },
    },
  },
});
