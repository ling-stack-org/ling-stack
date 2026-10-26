import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { packagedGstackIdentityPlugin } from "../scripts/packaged-gstack-resources.mjs";

test("identity injection intercepts native Windows and POSIX paths, retaining its exact module check", () => {
  const injection = packagedGstackIdentityPlugin({ identity: {} });
  let filter;
  injection.plugin.setup({ onLoad(options) { filter = options.filter; } });
  for (const path of ["C:\\repo\\packages\\daemon\\dist\\features\\skills\\packaged-identity.js",
    "C:\\repo\\packages\\daemon\\src\\features\\skills\\packaged-identity.ts",
    "/repo/packages/daemon/dist/features/skills/packaged-identity.js"]) {
    assert.equal(filter.test(path), true, path);
  }
  for (const path of ["/repo/features/skills/other.js", "/repo/features/skills/packaged-identity.jsx"])
    assert.equal(filter.test(path), false, path);
  assert.throws(() => injection.assertIncluded(), /identity_not_bundled/);
});

test("real source bundling includes one authenticated identity without a prior daemon build", async () => {
  const entry = fileURLToPath(new URL("../../../packages/daemon/src/features/skills/packaged-identity.ts", import.meta.url));
  const lock = JSON.parse(readFileSync(new URL("../../../scripts/gstack/upstream-lock.json", import.meta.url)));
  const identity = { manifestChecksum: `sha256:${"a".repeat(64)}`, upstreamRevision: lock.revision,
    adaptationRevision: "identity-portability-fixture", target: { platform: "win32", arch: "x64" }, skillIds: lock.skillIds };
  const injection = packagedGstackIdentityPlugin({ identity,
    sourceInputs: { loadSource(path) { return { contents: readFileSync(path, "utf8") }; } } });
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm", plugins: [injection.plugin] });
  injection.assertIncluded();
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
  assert.deepEqual(loaded.readPackagedGstackIdentity(), identity);
});

test("a different module with the same suffix cannot receive the embedded identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-identity-module-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "features/skills"); await mkdir(directory, { recursive: true });
  const entry = join(directory, "packaged-identity.js");
  await writeFile(entry, 'const embeddedBundledGstackJson = "NO_PACKAGED_GSTACK_IDENTITY";');
  const injection = packagedGstackIdentityPlugin({ identity: {} });
  await assert.rejects(build({ entryPoints: [entry], bundle: true, write: false, platform: "node",
    logLevel: "silent", plugins: [injection.plugin] }), /identity_module_changed/);
  assert.throws(() => injection.assertIncluded(), /identity_not_bundled/);
});
