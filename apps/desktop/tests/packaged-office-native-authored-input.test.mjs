import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

function put(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

for (const generated of ["missing", "poisoned"]) {
  test(`Office hook imports authored review with ${generated} dist (synthetic dependencies)`, async t => {
    const root = mkdtempSync(join(tmpdir(), "ling-office-authored-import-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    put(join(root, "package.json"), '{"type":"module"}');
    const scripts = join(root, "apps/desktop/scripts");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(new URL("../scripts/packaged-office-native-package-checks.mjs", import.meta.url),
      join(scripts, "packaged-office-native-package-checks.mjs"));
    const authored = join(root, "packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts");
    mkdirSync(dirname(authored), { recursive: true });
    copyFileSync(new URL("../../../packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts",
      import.meta.url), authored);
    const marker = `ling.office.poisoned-dist.${generated}`;
    t.after(() => { delete globalThis[Symbol.for(marker)]; });
    if (generated === "poisoned") {
      put(join(root, "packages/daemon/dist/runtime/sandbox/packaged-office-native-published-review.js"),
        `globalThis[Symbol.for(${JSON.stringify(marker)})] = true; throw new Error("unreviewed dist executed");`);
    }
    // Only module selection is exercised; these stubs grant no build publication.
    put(join(scripts, "build-packaged-office-native.mjs"),
      "export function readActiveOriginalPackagedOfficeNativePublication() { throw new Error('test stub'); }");
    put(join(scripts, "packaged-office-native-asar-checks.mjs"),
      "export function verifyOriginalOfficeDaemonInApp() { throw new Error('test stub'); }");
    put(join(scripts, "cua-driver-signing/final-artifact-extractor.mjs"),
      "export function extractCuaDriverFinalArtifact() { throw new Error('test stub'); }");
    const api = await import(pathToFileURL(join(scripts, "packaged-office-native-package-checks.mjs")).href);
    assert.equal(typeof api.verifyOriginalOfficeCopyInApp, "function");
    assert.equal(globalThis[Symbol.for(marker)], undefined);
  });
}
