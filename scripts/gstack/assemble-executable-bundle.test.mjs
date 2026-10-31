import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

test("failed publication removes only its empty reservation, never a directory populated by another writer", {
  skip: process.platform === "win32" ? "POSIX reservation interleaving; Windows uses non-replacing Directory.Move" : false,
}, async t => {
  const f = await fixture(t);
  const source = await readFile(new URL("./assemble-executable-bundle.mjs", import.meta.url), "utf8");
  assert.match(source, /await publishStagedDirectory\(candidate, outputRoot\);/);
  const helper = await readFile(new URL("./publish-staged-directory.mjs", import.meta.url), "utf8");
  const key = `publicationProbe${Math.random().toString(36).slice(2)}`;
  const error = Object.assign(new Error("forced publish failure"), { code: "EIO" });
  let otherWriter = false;
  globalThis[key] = { ...fs, rename: async () => {
    if (otherWriter) await writeFile(join(f.outputRoot, "KEEP"), "other writer");
    throw error;
  } };
  const instrumented = helper.replace('import { mkdir, rename, rmdir } from "node:fs/promises";',
    `const { mkdir, rename, rmdir } = globalThis[${JSON.stringify(key)}];`);
  assert.notEqual(instrumented, helper);
  try {
    const { publishStagedDirectory } = await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString("base64")}`);
    await assert.rejects(publishStagedDirectory("/fixture/candidate", f.outputRoot), value => value === error);
    await assert.rejects(lstat(f.outputRoot), { code: "ENOENT" });
    otherWriter = true;
    await assert.rejects(publishStagedDirectory("/fixture/candidate", f.outputRoot), value => {
      assert.ok(value instanceof AggregateError);
      assert.equal(value.errors[0], error);
      assert.equal(value.errors[1].code, "ENOTEMPTY");
      return true;
    });
    assert.equal(await readFile(join(f.outputRoot, "KEEP"), "utf8"), "other writer");
  } finally { delete globalThis[key]; }
});
