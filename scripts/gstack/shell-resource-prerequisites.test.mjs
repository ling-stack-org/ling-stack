import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const revision = "a".repeat(40);
const shell = process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash";
const paths = ["bin/start", "bin/helper.sh", "migrations/without-shebang.sh"];
const invoke = async options => (await import("./verify-shell-resource-prerequisites.mjs")).verifyGstackShellResourcePrerequisites(options);

async function fixture(t, text = "# sourced helper without a shebang\nprintf '%s' inert\n") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling shell prerequisite ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime"), files = [];
  for (const path of paths) {
    await mkdir(dirname(join(runtime, path)), { recursive: true });
    await writeFile(join(runtime, path), text);
    files.push({ path: `runtime/${path}`, checksum: checksum(text), sizeBytes: Buffer.byteLength(text) });
  }
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "source", upstream: { revision }, files }));
  await writeFile(join(root, "source-manifest.json"), manifest);
  const census = { schemaVersion: 1, reviewStatus: "pinned-source-census", releaseEligible: false,
    upstreamRevision: revision, sourceManifestChecksum: checksum(manifest), shellPaths: paths,
    reviewedSourceEdges: [["bin/start", "bin/helper.sh"]] };
  const inventoryPath = join(root, "inventory.json"), inventory = Buffer.from(JSON.stringify(census));
  await writeFile(inventoryPath, inventory);
  return { root, runtime, manifest, census, inventoryPath, options: { runtimeRoot: runtime, inventoryPath,
    expectedInventoryChecksum: checksum(inventory), expectedSourceManifestChecksum: checksum(manifest),
    expectedUpstreamRevision: revision, shellPath: shell, expectedShellChecksum: checksum(await readFile(shell)) } };
}

test("parse-only checks include sourced and migration scripts without shebangs", async t => {
  const { options } = await fixture(t);
  const report = await invoke(options);
  assert.deepEqual(report.scripts.map(script => script.path), [...paths].sort());
  assert.equal(report.validationMode, "parse-only");
  assert.equal(report.releaseEligible, false);
  assert.equal(report.hostAcceptance, "pending");
  assert.equal(report.packageAcceptance, "pending");
  assert.equal(report.sourceEdges[0].path, "bin/helper.sh");
  assert.equal(report.scriptGraphChecksum, checksum(JSON.stringify(report.scripts)));
  assert.equal(report.sourceEdgeGraphChecksum, checksum(JSON.stringify(report.sourceEdges)));
});

test("parse-only validation never evaluates command substitutions or inherited shell startup files", async t => {
  const { root, runtime, options } = await fixture(t);
  const marker = join(root, "executed"), text = `touch '${marker}'\nvalue=$(touch '${marker}')\n`;
  const manifest = JSON.parse(await readFile(join(root, "source-manifest.json")));
  for (const file of manifest.files) {
    await writeFile(join(root, file.path), text);
    file.checksum = checksum(text); file.sizeBytes = Buffer.byteLength(text);
  }
  const source = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(root, "source-manifest.json"), source);
  const census = JSON.parse(await readFile(options.inventoryPath));
  census.sourceManifestChecksum = checksum(source);
  const inventory = Buffer.from(JSON.stringify(census));
  await writeFile(options.inventoryPath, inventory);
  const startup = join(root, "startup.sh");
  await writeFile(startup, text);
  const previous = process.env.BASH_ENV;
  process.env.BASH_ENV = startup;
  try { await invoke({ ...options, runtimeRoot: runtime, expectedInventoryChecksum: checksum(inventory), expectedSourceManifestChecksum: checksum(source) }); }
  finally { if (previous === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = previous; }
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("a pinned script with invalid shell syntax blocks prerequisites", async t => {
  const { options } = await fixture(t, "if true; then\nprintf broken\n");
  await assert.rejects(invoke(options), /gstack_shell_resource_syntax_invalid/);
});

test("missing, equal-length altered and linked helpers cannot silently use upstream fallbacks", async t => {
  const { runtime, options } = await fixture(t);
  const helper = join(runtime, "bin/helper.sh"), bytes = await readFile(helper);
  await rm(helper);
  await assert.rejects(invoke(options), /gstack_shell_resource_script_missing/);
  await writeFile(helper, bytes.toString().replace("inert", "other"));
  await assert.rejects(invoke(options), /gstack_shell_resource_source_mismatch/);
  await rm(helper);
  await symlink(join(runtime, "bin/start"), helper);
  await assert.rejects(invoke(options), /gstack_shell_resource_file_invalid/);
});

test("detached inventory, source and interpreter checksums and revisions are mandatory", async t => {
  const { options } = await fixture(t);
  for (const key of ["expectedInventoryChecksum", "expectedSourceManifestChecksum", "expectedShellChecksum"]) {
    await assert.rejects(invoke({ ...options, [key]: undefined }), /gstack_shell_resource_detached_checksums_required/);
  }
  await assert.rejects(invoke({ ...options, expectedInventoryChecksum: checksum("other") }), /gstack_shell_resource_inventory_mismatch/);
  await assert.rejects(invoke({ ...options, expectedSourceManifestChecksum: checksum("other") }), /gstack_shell_resource_source_manifest_mismatch/);
  await assert.rejects(invoke({ ...options, expectedShellChecksum: checksum("other") }), /gstack_shell_resource_interpreter_mismatch/);
  await assert.rejects(invoke({ ...options, expectedUpstreamRevision: "b".repeat(40) }), /gstack_shell_resource_source_manifest_invalid/);
});

test("census paths and helper edges reject traversal, duplicates and unlisted targets", async t => {
  const { census, options } = await fixture(t);
  for (const change of [
    c => c.shellPaths.push("../outside"),
    c => c.shellPaths.push("C:\\outside.sh"),
    c => c.shellPaths.push(c.shellPaths[0]),
    c => c.reviewedSourceEdges.push(["bin/start", "missing.sh"]),
    c => c.reviewedSourceEdges.push(c.reviewedSourceEdges[0]),
    c => { c.releaseEligible = true; },
  ]) {
    const changed = structuredClone(census); change(changed);
    const bytes = Buffer.from(JSON.stringify(changed));
    await writeFile(options.inventoryPath, bytes);
    await assert.rejects(invoke({ ...options, expectedInventoryChecksum: checksum(bytes) }), /gstack_shell_resource_inventory_/);
  }
});

test("a linked runtime root is rejected before starting the parser", async t => {
  const { root, runtime, options } = await fixture(t);
  const linked = join(root, "linked-runtime");
  await symlink(runtime, linked, "dir");
  await assert.rejects(invoke({ ...options, runtimeRoot: linked }), /gstack_shell_resource_root_invalid/);
});

test("interpreter timeouts remain failures and never publish an acceptance result", async t => {
  const { root, options } = await fixture(t);
  const interpreter = join(root, "timeout-parser");
  const bytes = Buffer.from("#!/bin/bash\nwhile :; do :; done\n");
  await writeFile(interpreter, bytes); await chmod(interpreter, 0o700);
  await assert.rejects(invoke({ ...options, shellPath: interpreter, expectedShellChecksum: checksum(bytes), syntaxTimeoutMs: 100 }), /gstack_shell_resource_parser_failed/);
});
