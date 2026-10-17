import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { PINNED_SHELL_DEPENDENCY_REVIEW_CHECKSUM, verifyReviewedGstackShellDependencies } from "./verify-reviewed-shell-dependencies.mjs";

const source = process.env.LING_GSTACK_SOURCE_CANDIDATE;
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE;
const parser = process.env.LING_GSTACK_SHELL_AST_PARSER;
const parserChecksum = process.env.LING_GSTACK_SHELL_AST_PARSER_CHECKSUM;
const skip = !(source && stage && parser && parserChecksum) && "Set exact original source, prepared stage and detached AST parser identity";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("all pinned source and dynamic mappings independently replay original bytes and relocated prepared resources", { skip }, async t => {
  const original = await realpath(resolve(source)), prepared = await realpath(resolve(stage));
  const manifest = await readFile(join(original, "manifest.json")), receipt = await readFile(join(prepared, "resource-stage.json"));
  const catalogBytes = await readFile(new URL("./reviewed-shell-dependencies.json", import.meta.url));
  assert.equal(checksum(catalogBytes), PINNED_SHELL_DEPENDENCY_REVIEW_CHECKSUM);
  const catalog = JSON.parse(catalogBytes), inventory = JSON.parse(await readFile(new URL("./pinned-shell-inventory.json", import.meta.url)));
  assert.equal(checksum(manifest), catalog.sourceManifestChecksum);
  const records = new Map(JSON.parse(manifest).files.map(file => [file.path, file]));
  const paths = new Set([...inventory.shellPaths, ...catalog.entries.flatMap(entry => entry.targets)]);
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling original dependency review ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of paths) {
    const expected = records.get(`runtime/${path}`);
    assert.ok(expected, path);
    const actual = await readGstackClosureFileRecord(join(original, "runtime", path), { retain: true });
    assert.equal(actual.checksum, expected.checksum, path);
    assert.equal(actual.sizeBytes, expected.sizeBytes, path);
    await mkdir(dirname(join(root, "runtime", path)), { recursive: true });
    await writeFile(join(root, "runtime", path), actual.bytes, { flag: "wx" });
  }
  await writeFile(join(root, "source-manifest.json"), manifest, { flag: "wx" });
  const shellPath = await realpath(process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash");
  const options = { parserPath: await realpath(resolve(parser)), expectedParserChecksum: parserChecksum,
    expectedSourceManifestChecksum: catalog.sourceManifestChecksum, expectedUpstreamRevision: catalog.upstreamRevision,
    shellPath, expectedShellChecksum: checksum(await readFile(shellPath)) };
  const originalReport = await verifyReviewedGstackShellDependencies({ ...options, runtimeRoot: join(root, "runtime") });
  const stageReport = await verifyReviewedGstackShellDependencies({ ...options, runtimeRoot: join(prepared, "runtime") });
  assert.deepEqual(stageReport, originalReport);
  assert.deepEqual(stageReport, JSON.parse(await readFile(join(prepared, "reviewed-shell-dependencies.json"))));
  assert.equal(stageReport.sourceSites.length, 128);
  assert.equal(stageReport.dynamicEvaluationSites.length, 26);
  assert.equal(stageReport.resources.length, 20);
  assert.equal(stageReport.sourceSites.filter(site => site.classification === "bundled-resource").length, 127);
  assert.equal(stageReport.sourceSites.filter(site => site.classification === "generated-state").length, 1);
  assert.deepEqual(Object.fromEntries(["bundled-command-output", "environment-indirection", "shell-introspection", "user-command", "host-probe"]
    .map(kind => [kind, stageReport.dynamicEvaluationSites.filter(site => site.classification === kind).length])),
  { "bundled-command-output": 17, "environment-indirection": 4, "shell-introspection": 3, "user-command": 1, "host-probe": 1 });
  assert.equal(stageReport.unresolvedCommandExpressions, 270);
  assert.equal(stageReport.dependencyClosure, "pending");
  assert.equal(stageReport.releaseEligible, false);
  assert.ok(stageReport.sourceSites.some(site => site.consumerPath === "bin/gstack-paths" && site.targets[0]?.path === "bin/gstack-state-root.sh"));
  assert.ok(stageReport.resources.some(resource => resource.path === "supabase/config.sh"));
  for (const path of paths) assert.equal((await readGstackClosureFileRecord(join(original, "runtime", path))).checksum, records.get(`runtime/${path}`).checksum);
  assert.deepEqual(await readFile(join(original, "manifest.json")), manifest);
  assert.deepEqual(await readFile(join(prepared, "resource-stage.json")), receipt);
  t.diagnostic(JSON.stringify({ sourceSites: 128, dynamicSites: 26, immutableEndpoints: 20,
    reviewGraphChecksum: stageReport.reviewGraphChecksum, resourceGraphChecksum: stageReport.resourceGraphChecksum,
    sourceRevision: catalog.upstreamRevision, releaseEligible: false }));
});
