import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS } from "../scripts/packaged-office-native-review-inputs.mjs";

test("package signing hooks keep their authored runtime dependencies in the fixed review inventory", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [
      "apps/desktop/scripts/after-sign.mjs",
      "apps/desktop/scripts/cua-driver-electron-builder.config.mjs",
      "apps/desktop/scripts/cua-driver-signing/electron-builder-mac-sign.mjs",
    ],
    bundle: true, packages: "external", platform: "node", format: "esm",
    metafile: true, write: false, outdir: "unused-review-output", logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs).map(path => path.replaceAll("\\", "/"));
  assert.ok(inputs.length > 0);
  assert.deepEqual(inputs.filter(path => !PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(path)), []);
});
