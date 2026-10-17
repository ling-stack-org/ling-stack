import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundleFile, bundleInventory, digest } from "./executable-bundle.mjs";
import { assertRefreshBuildDelta, verifyRefreshStage } from "./refresh-executable-browser-verifier.mjs";

test("stage and compiler are independently pinned before any compiler can run", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-refresh-stage-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime/tools"), { recursive: true });
  const path = join(root, "runtime/tools/bun");
  await writeFile(path, "fixture, never executed");
  const compiler = await bundleFile(root, "runtime/tools/bun"), inventoryBytes = JSON.stringify({ files: await bundleInventory(root) });
  await writeFile(join(root, "resource-inventory.json"), inventoryBytes);
  const stageBytes = JSON.stringify({ inventoryChecksum: digest(Buffer.from(inventoryBytes)) });
  await writeFile(join(root, "resource-stage.json"), stageBytes);
  const receipt = { retainedStageChecksum: digest(Buffer.from(stageBytes)) }, build = { compiler: { checksum: compiler.checksum, sizeBytes: compiler.sizeBytes } };
  await verifyRefreshStage(root, receipt, build);
  await assert.rejects(verifyRefreshStage(root, receipt, { compiler: { ...build.compiler, checksum: digest(Buffer.from("wrong")) } }), /compiler_changed/);
  await writeFile(path, "replaced compiler");
  await assert.rejects(verifyRefreshStage(root, receipt, build), /stage_changed/);
});
test("compilation closure may change only the reviewed verifier input", () => {
  const verifier = { path: "packages/core/src/bundled-skill-browser.ts", checksum: "new", sizeBytes: 2 };
  const before = { inputs: [{ ...verifier, checksum: "old" }, { path: "source.ts", checksum: "same", sizeBytes: 3 }], compiler: { checksum: "pinned" } };
  const after = { ...before, inputs: [verifier, before.inputs[1]] };
  assert.doesNotThrow(() => assertRefreshBuildDelta(before, after, verifier));
  assert.throws(() => assertRefreshBuildDelta(before, { ...after, compiler: { checksum: "replaced" } }, verifier), /delta_invalid/);
  assert.throws(() => assertRefreshBuildDelta(before, { ...after, inputs: [...after.inputs, { path: "extra" }] }, verifier), /delta_invalid/);
});
