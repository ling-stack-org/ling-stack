import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bundledDaemonUrl = new URL("../dist/daemon/cli.mjs", import.meta.url);

test("packaged daemon bundles Office runtime dependencies", async () => {
  const bundle = await readFile(bundledDaemonUrl, "utf8");

  for (const dependency of ["pptxgenjs", "xlsx-populate"]) {
    const escapedDependency = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.doesNotMatch(
      bundle,
      new RegExp(`(?:require\\(|from\\s+)["']${escapedDependency}["']`, "u"),
      `${dependency} must be included in the daemon bundle instead of resolved from the packaged app at runtime`,
    );
  }
});
