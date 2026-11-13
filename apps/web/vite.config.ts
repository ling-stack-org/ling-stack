import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
if (typeof rootPackage.version !== "string") throw new Error("root_product_version_missing");

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: {
    __LING_PRODUCT_VERSION__: JSON.stringify(rootPackage.version),
  },
});
