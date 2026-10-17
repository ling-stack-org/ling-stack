import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { filterGstackUpstreamSelfTestPackages } from "./filter-upstream-self-test-packages.mjs";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const scopes = ["client-command-imports", "native-build-imports", "node-browser-build-imports", "diagram-build-imports", "security-sidecar-build-imports"];
const sdk = "node_modules/@anthropic-ai/claude-agent-sdk";
const nativeSdk = `${sdk}-darwin-arm64`;

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ling-self-test-selection-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const stage = await mkdtemp(join(parent, ".gstack-resource-stage-"));
  const candidate = join(stage, "candidate"), runtime = join(candidate, "runtime");
  const write = async (path, text) => {
    const absolute = join(candidate, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    return { path, checksum: hash(text), sizeBytes: Buffer.byteLength(text) };
  };
  const files = [];
  for (const [path, text] of [
    ["runtime/bin/gstack-fixture", '#!/usr/bin/env bun\nthrow new Error("client must not execute");\n'],
    ["runtime/test/paid.ts", 'throw new Error("claude-agent-sdk self-test must not execute");\n'],
    ["runtime/lib/optional.ts", 'export const value = "optional API preserved";\n'],
  ]) files.push(await write(path, text));
  const source = { schemaVersion: 1, deliveryStage: "source", upstream: { revision: "a".repeat(40) }, files };
  const sourceBytes = JSON.stringify(source);
  await write("source-manifest.json", sourceBytes);
  const native = { schemaVersion: 1, deliveryStage: "native-dependencies", upstreamRevision: source.upstream.revision,
    sourceManifestChecksum: hash(sourceBytes), target: { platform: "darwin", arch: "arm64" }, components: [] };
  await write("native-build.json", JSON.stringify(native));
  const packageRecords = [];
  for (const path of [sdk, nativeSdk]) {
    const metadata = { name: path.slice("node_modules/".length), version: "0.2.117", license: "SEE LICENSE" };
    const text = JSON.stringify(metadata);
    await write(`runtime/${path}/package.json`, text);
    await write(`runtime/${path}/LICENSE`, "retained until reviewed exclusion\n");
    await write(`runtime/${path}/sdk.mjs`, 'throw new Error("SDK must not execute");\n');
    packageRecords.push({ path, name: metadata.name, version: metadata.version, metadataChecksum: hash(text) });
  }
  const api = await write("runtime/node_modules/@anthropic-ai/sdk/index.mjs", 'throw new Error("API must not execute"); export const judge = true;\n');
  const inputs = [files[0], api].map(file => ({ path: file.path.slice("runtime/".length), checksum: file.checksum, sizeBytes: file.sizeBytes }));
  const compilerChecksum = hash("fixture compiler");
  const importReports = scopes.map(dependencyScope => ({ dependencyScope, sourceManifestChecksum: hash(sourceBytes),
    compilerChecksum, inputs, inputGraphChecksum: hash(JSON.stringify(inputs)) }));
  const review = { schemaVersion: 1, target: native.target, sourceManifestChecksum: hash(sourceBytes),
    upstreamRevision: source.upstream.revision, sourceFileCount: files.length, marker: "claude-agent-sdk", compilerChecksum,
    importGraphs: importReports.map(({ dependencyScope, inputGraphChecksum }) => ({ dependencyScope, inputGraphChecksum })),
    references: [{ path: files[1].path, checksum: files[1].checksum, classification: "upstream-self-test" }], packages: packageRecords };
  const reviewPath = join(parent, "review.json"), reviewBytes = JSON.stringify(review);
  await writeFile(reviewPath, reviewBytes);
  const options = { runtimeRoot: runtime, stagingRoot: stage, expectedNativeBuildChecksum: hash(JSON.stringify(native)),
    importReports, target: native.target, reviewPath, expectedReviewChecksum: hash(reviewBytes) };
  const rebind = async () => {
    await writeFile(join(candidate, "source-manifest.json"), JSON.stringify(source));
    native.sourceManifestChecksum = hash(JSON.stringify(source));
    await writeFile(join(candidate, "native-build.json"), JSON.stringify(native));
    review.sourceManifestChecksum = native.sourceManifestChecksum;
    for (const graph of importReports) graph.sourceManifestChecksum = native.sourceManifestChecksum;
    await writeFile(reviewPath, JSON.stringify(review));
    options.expectedNativeBuildChecksum = hash(JSON.stringify(native));
    options.expectedReviewChecksum = hash(JSON.stringify(review));
  };
  return { parent, stage, runtime, candidate, write, source, review, options, rebind };
}

async function assertSdkPresent(runtime) {
  assert.match(await readFile(join(runtime, sdk, "sdk.mjs"), "utf8"), /SDK must not execute/);
  assert.match(await readFile(join(runtime, nativeSdk, "sdk.mjs"), "utf8"), /SDK must not execute/);
}

test("reviewed exclusion removes only the two self-test packages from owned staging, preserving optional API and all sources", async t => {
  const f = await fixture(t);
  const report = await filterGstackUpstreamSelfTestPackages(f.options);
  assert.equal(report.excludedPackages.length, 2);
  assert.equal(report.removedResources.length, 6);
  assert.ok(report.removedSizeBytes > 0);
  assert.equal(report.reviewedReferenceCount, 1);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.completeRuntimeSelection, "pending");
  assert.equal(report.compiledArtifactBinding, "pending");
  await assert.rejects(readFile(join(f.runtime, sdk, "package.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.runtime, nativeSdk, "package.json")), { code: "ENOENT" });
  assert.match(await readFile(join(f.runtime, "node_modules/@anthropic-ai/sdk/index.mjs"), "utf8"), /API must not execute/);
  for (const file of f.source.files) assert.equal(hash(await readFile(join(f.candidate, file.path))), file.checksum);
});

test("retained or installed resource roots cannot be used as exclusion staging", async t => {
  const f = await fixture(t);
  await assert.rejects(filterGstackUpstreamSelfTestPackages({ ...f.options, stagingRoot: f.parent }), /private_staging_required/);
  const alias = join(f.parent, ".gstack-resource-stage-alias");
  await symlink(f.stage, alias, "dir");
  await assert.rejects(filterGstackUpstreamSelfTestPackages({ ...f.options, stagingRoot: alias }), /private_staging_required/);
  await assertSdkPresent(f.runtime);
});

test("unreviewed targets, changed review bytes and native receipts reject before any unlink", async t => {
  const f = await fixture(t);
  await assert.rejects(filterGstackUpstreamSelfTestPackages({ ...f.options, target: { platform: "win32", arch: "x64" } }), /target_not_reviewed/);
  await assert.rejects(filterGstackUpstreamSelfTestPackages({ ...f.options, expectedReviewChecksum: hash("changed") }), /review_mismatch/);
  await assert.rejects(filterGstackUpstreamSelfTestPackages({ ...f.options, expectedNativeBuildChecksum: hash("changed") }), /native_receipt_mismatch/);
  await assertSdkPresent(f.runtime);
});

test("missing compiler scopes and a real required SDK import cannot be hidden by a rebound graph review", async t => {
  const f = await fixture(t);
  await assert.rejects(filterGstackUpstreamSelfTestPackages({ ...f.options, importReports: f.options.importReports.slice(1) }), /import_coverage_required/);
  await assert.rejects(filterGstackUpstreamSelfTestPackages({ ...f.options, importReports: f.options.importReports.slice(0, -1) }), /import_coverage_required/);
  const bytes = await readFile(join(f.runtime, sdk, "sdk.mjs"));
  const inputs = [{ path: `${sdk}/sdk.mjs`, checksum: hash(bytes), sizeBytes: bytes.length }];
  const graph = f.options.importReports.at(-1);
  graph.inputs = inputs;
  graph.inputGraphChecksum = hash(JSON.stringify(inputs));
  f.review.importGraphs.at(-1).inputGraphChecksum = graph.inputGraphChecksum;
  await f.rebind();
  await assert.rejects(filterGstackUpstreamSelfTestPackages(f.options), /required_import/);
  await assertSdkPresent(f.runtime);
});

test("changed sources or compiler inputs are not accepted from old report hashes", async t => {
  const f = await fixture(t);
  const sourcePath = join(f.runtime, "bin/gstack-fixture"), original = await readFile(sourcePath);
  await writeFile(sourcePath, original.toString().replace("client", "mutate"));
  await assert.rejects(filterGstackUpstreamSelfTestPackages(f.options), /source_changed/);
  await writeFile(sourcePath, original);
  await writeFile(join(f.runtime, "node_modules/@anthropic-ai/sdk/index.mjs"), "changed optional API\n");
  await assert.rejects(filterGstackUpstreamSelfTestPackages(f.options), /import_changed/);
  await assertSdkPresent(f.runtime);
});

test("new or omitted SDK references fail the complete source census", async t => {
  const f = await fixture(t);
  const file = await f.write("runtime/bin/new-caller", '#!/bin/sh\necho "claude-agent-sdk"\n');
  f.source.files.push(file);
  f.review.sourceFileCount++;
  await f.rebind();
  await assert.rejects(filterGstackUpstreamSelfTestPackages(f.options), /unreviewed_reference/);
  await assertSdkPresent(f.runtime);
});

test("package version drift and unsafe package resources reject before removing either package", async t => {
  const f = await fixture(t);
  const path = join(f.runtime, nativeSdk, "package.json"), bytes = await readFile(path);
  await writeFile(path, bytes.toString().replace("0.2.117", "0.2.118"));
  await assert.rejects(filterGstackUpstreamSelfTestPackages(f.options), /metadata_not_reviewed/);
  await writeFile(path, bytes);
  await symlink(join(f.runtime, "lib/optional.ts"), join(f.runtime, nativeSdk, "unexpected-link"));
  await assert.rejects(filterGstackUpstreamSelfTestPackages(f.options), /linked_resource/);
  await assertSdkPresent(f.runtime);
});

test("a missing second package does not partially remove the first one", async t => {
  const f = await fixture(t);
  await rm(join(f.runtime, nativeSdk), { recursive: true });
  await assert.rejects(filterGstackUpstreamSelfTestPackages(f.options), { code: "ENOENT" });
  assert.match(await readFile(join(f.runtime, sdk, "sdk.mjs"), "utf8"), /SDK must not execute/);
});
