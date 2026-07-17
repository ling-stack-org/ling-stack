import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "computer-use-preview-renderer.spec.mjs",
  outputDir: join(tmpdir(), "ling-stack-desktop-computer-use-playwright"),
  reporter: "line",
  workers: 1,
});
