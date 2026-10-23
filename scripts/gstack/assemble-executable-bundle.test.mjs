import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleExecutableBundle } from "./assemble-executable-bundle.mjs";
import { digest } from "./executable-bundle.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gstack-assemble-admission-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stageRoot = join(root, "stage");
  await mkdir(stageRoot);
  return { root, stageRoot, browserInspectionRoot: join(root, "inspection"), archiveRoot: join(root, "archives"), outputRoot: join(root, "output") };
}

test("assembly requires an explicit detached stage hash and ffmpeg location, not a retained machine-local stage", async t => {
  const f = await fixture(t);
  await assert.rejects(assembleExecutableBundle(f), /stage_receipt_required/);
  await assert.rejects(assembleExecutableBundle({ ...f, expectedResourceStageChecksum: "latest" }), /stage_receipt_required/);
  await assert.rejects(assembleExecutableBundle({ ...f, archiveRoot: undefined,
    expectedResourceStageChecksum: `sha256:${"a".repeat(64)}` }), /archive_root_required/);
  assert.deepEqual(await readdir(f.root), ["stage"]);
});

test("a changed receipt or a foreign stage cannot be relabeled for the current executable target", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "resource-prerequisites", releaseEligible: false,
    upstreamRevision: "foreign", upstreamVersion: "foreign", target: { platform: process.platform, arch: process.arch } }));
  await writeFile(join(f.stageRoot, "resource-stage.json"), bytes);
  await assert.rejects(assembleExecutableBundle({ ...f, expectedResourceStageChecksum: `sha256:${"a".repeat(64)}` }),
    /source_receipt_mismatch/);
  await assert.rejects(assembleExecutableBundle({ ...f, expectedResourceStageChecksum: digest(bytes) }), /source_identity_mismatch/);
  assert.deepEqual(await readdir(f.root), ["stage"]);
});

test("assembly never overwrites an existing executable generation", async t => {
  const f = await fixture(t);
  await mkdir(f.outputRoot);
  await writeFile(join(f.outputRoot, "KEEP"), "existing generation");
  await assert.rejects(assembleExecutableBundle({ ...f, expectedResourceStageChecksum: `sha256:${"a".repeat(64)}` }), /output_exists/);
  assert.equal(await readFile(join(f.outputRoot, "KEEP"), "utf8"), "existing generation");
});

test("failed publication removes only its empty reservation, never a directory populated by another writer", async t => {
  const f = await fixture(t);
  const source = await readFile(new URL("./assemble-executable-bundle.mjs", import.meta.url), "utf8");
  const block = source.match(/    await mkdir\(outputRoot\);\n    try \{ await rename\(candidate, outputRoot\); \}\n    catch \(error\) \{[^\n]+\}/)?.[0];
  assert.ok(block);
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)("mkdir", "rename", "rm", "rmdir", "outputRoot", "candidate", block);
  const error = Object.assign(new Error("forced publish failure"), { code: "EIO" });
  await assert.rejects(execute(mkdir, async () => { throw error; }, rm, rmdir, f.outputRoot, "/fixture/candidate"), value => value === error);
  await assert.rejects(lstat(f.outputRoot), { code: "ENOENT" });
  await assert.rejects(execute(mkdir, async () => {
    await writeFile(join(f.outputRoot, "KEEP"), "other writer"); throw error;
  }, rm, rmdir, f.outputRoot, "/fixture/candidate"), value => value === error);
  assert.equal(await readFile(join(f.outputRoot, "KEEP"), "utf8"), "other writer");
});
