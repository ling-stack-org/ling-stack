import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "renderer/computer-use-preview"),
  base: "./",
  esbuild: {
    jsx: "automatic",
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer/computer-use-preview"),
    emptyOutDir: true,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        preview: resolve(import.meta.dirname, "renderer/computer-use-preview/index.html"),
        "preview-view-model": resolve(import.meta.dirname, "renderer/computer-use-preview/preview-view-model.ts"),
        "page-deck-view-model": resolve(import.meta.dirname, "renderer/computer-use-preview/page-deck-view-model.ts"),
        messages: resolve(import.meta.dirname, "renderer/computer-use-preview/messages.ts"),
      },
      output: {
        minifyInternalExports: false,
        entryFileNames: (chunk) => {
          if (chunk.name === "preview-view-model") {
            return "preview-view-model.js";
          }
          if (chunk.name === "page-deck-view-model") {
            return "page-deck-view-model.js";
          }
          if (chunk.name === "messages") {
            return "messages.js";
          }
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
});
