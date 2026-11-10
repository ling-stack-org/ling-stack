import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { PINNED_SHELL_INVENTORY_CHECKSUM, verifyGstackShellResourcePrerequisites } from "./verify-shell-resource-prerequisites.mjs";

const source = process.env.LING_GSTACK_SOURCE_CANDIDATE ? resolve(process.env.LING_GSTACK_SOURCE_CANDIDATE) : undefined;
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE ? resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE) : undefined;
const skip = !(source && stage) && "Set source and platform resource candidates for independent real shell census verification";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inventoryBytes = await readFile(new URL("./pinned-shell-inventory.json", import.meta.url));
const inventory = JSON.parse(inventoryBytes);

test("the pinned 136-file census independently matches all source shell shebangs and every sh extension", { skip }, async () => {
  assert.equal(checksum(inventoryBytes), PINNED_SHELL_INVENTORY_CHECKSUM);
  const manifestBytes = await readFile(join(source, "manifest.json"));
  assert.equal(checksum(manifestBytes), inventory.sourceManifestChecksum);
  const manifest = JSON.parse(manifestBytes), paths = [];
  for (const file of manifest.files.filter(file => file.path.startsWith("runtime/"))) {
    const bytes = await readFile(join(source, file.path));
    assert.equal(checksum(bytes), file.checksum, file.path);
    const header = bytes.subarray(0, 512).toString("utf8").split("\n")[0];
    if (file.path.endsWith(".sh") || /^#!.*\b(?:bash|sh)\b/.test(header)) paths.push(file.path.slice(8));
  }
  assert.deepEqual(paths.sort(), inventory.shellPaths);
  assert.equal(paths.length, 136);
});

test("all real shell bytes and eleven reviewed source edges parse without script or global installation execution", { skip }, async t => {
  const interpreter = await realpath(process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash");
  const report = await verifyGstackShellResourcePrerequisites({ runtimeRoot: join(stage, "runtime"),
    expectedSourceManifestChecksum: inventory.sourceManifestChecksum, expectedUpstreamRevision: inventory.upstreamRevision,
    shellPath: interpreter, expectedShellChecksum: checksum(await readFile(interpreter)) });
  assert.equal(report.scripts.length, 136);
  assert.equal(report.sourceEdges.length, 11);
  assert.equal(report.validationMode, "parse-only");
  assert.equal(report.releaseEligible, false);
  assert.deepEqual(report.buildHost, { platform: process.platform, arch: process.arch });
  assert.equal(report.inventoryChecksum, PINNED_SHELL_INVENTORY_CHECKSUM);
  assert.equal(report.scriptGraphChecksum, checksum(JSON.stringify(report.scripts)));
  for (const edge of report.sourceEdges) {
    assert.equal(edge.consumerChecksum, checksum(await readFile(join(stage, "runtime", edge.consumerPath))));
    assert.equal(edge.checksum, checksum(await readFile(join(stage, "runtime", edge.path))));
  }
  t.diagnostic(JSON.stringify({ scripts: report.scripts.length, edges: report.sourceEdges.length,
    interpreterChecksum: report.interpreterChecksum, scriptGraphChecksum: report.scriptGraphChecksum,
    sourceEdgeGraphChecksum: report.sourceEdgeGraphChecksum }));
});
