import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { inspectGstackShellCallSites } from "./inspect-shell-call-sites.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const parser = process.env.LING_GSTACK_SHELL_AST_PARSER;
const skip = !parser && "Set the verified build-only Shell AST parser";
const invoke = async options => (await import("./verify-reviewed-shell-dependencies.mjs")).verifyReviewedGstackShellDependencies(options);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling reviewed shell dependencies ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "must-not-execute"), revision = "a".repeat(40);
  const sources = new Map([
    ["bin/main.sh", `source "$BUNDLE_ROOT/bin/helper.sh"\n. "$STATE/env"\neval "$CODE"\neval "$("$BUNDLE_ROOT/bin/helper.sh")"\nsh -c 'echo $PPID'\ntouch '${marker}'\n`],
    ["bin/helper.sh", "cat \"$BUNDLE_ROOT/assets/config.json\"\n"],
    ["assets/config.json", "{\"value\":\"inert\"}\n"],
  ]);
  const files = [];
  for (const [path, bytes] of sources) {
    await mkdir(dirname(join(root, "runtime", path)), { recursive: true });
    await writeFile(join(root, "runtime", path), bytes);
    files.push({ path: `runtime/${path}`, checksum: checksum(bytes), sizeBytes: Buffer.byteLength(bytes) });
  }
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "source", upstream: { revision }, files }));
  await writeFile(join(root, "source-manifest.json"), manifest);
  const inventory = Buffer.from(JSON.stringify({ schemaVersion: 1, reviewStatus: "pinned-source-census", releaseEligible: false,
    upstreamRevision: revision, sourceManifestChecksum: checksum(manifest), shellPaths: ["bin/main.sh", "bin/helper.sh"],
    reviewedSourceEdges: [["bin/main.sh", "bin/helper.sh"]] }));
  const inventoryPath = join(root, "inventory.json");
  await writeFile(inventoryPath, inventory);
  const shellPath = await realpath(process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash");
  const options = { runtimeRoot: join(root, "runtime"), inventoryPath,
    expectedInventoryChecksum: checksum(inventory), expectedSourceManifestChecksum: checksum(manifest), expectedUpstreamRevision: revision,
    shellPath, expectedShellChecksum: checksum(await readFile(shellPath)), parserPath: await realpath(resolve(parser)),
    expectedParserChecksum: checksum(await readFile(parser)) };
  const calls = await inspectGstackShellCallSites(options);
  const binding = site => ({ consumerPath: site.consumerPath, consumerChecksum: site.consumerChecksum,
    start: site.start, end: site.end, argumentsChecksum: checksum(JSON.stringify(site.arguments)) });
  const entries = [
    { ...binding(calls.sourceSites[0]), kind: "source", classification: "bundled-resource", requiredRuntimeControl: "frozen-bundle-root",
      targets: ["bin/helper.sh", "assets/config.json"], prerequisites: [], reason: "Fixture source and transitive immutable data are package resources." },
    { ...binding(calls.sourceSites[1]), kind: "source", classification: "generated-state", requiredRuntimeControl: "structured-owned-state",
      targets: [], prerequisites: ["owned-cloud-state", "explicit-cloud-operation-approval"], reason: "Fixture generated state must not be read or copied by preparation." },
    { ...binding(calls.dynamicEvaluationSites[0]), kind: "dynamic-evaluation", classification: "user-command", requiredRuntimeControl: "approved-workspace-command",
      targets: [], prerequisites: ["explicit-user-command-approval"], reason: "Fixture user command is not build input execution authority." },
    { ...binding(calls.dynamicEvaluationSites[1]), kind: "dynamic-evaluation", classification: "bundled-command-output", requiredRuntimeControl: "structured-helper-output",
      targets: ["bin/helper.sh"], prerequisites: [], reason: "Fixture helper output still needs structured host adaptation." },
    { ...binding(calls.dynamicEvaluationSites[2]), kind: "dynamic-evaluation", classification: "shell-introspection", requiredRuntimeControl: "owned-shell-introspection",
      targets: [], prerequisites: ["owned-shell-runtime"], reason: "Fixture parent PID introspection is inventoried, never executed." },
  ];
  const catalog = { schemaVersion: 1, reviewStatus: "reviewed-static-dependency-mappings", releaseEligible: false,
    upstreamRevision: revision, sourceManifestChecksum: checksum(manifest), callGraphChecksum: calls.callGraphChecksum,
    sourceSiteGraphChecksum: calls.sourceSiteGraphChecksum, dynamicSiteGraphChecksum: checksum(JSON.stringify(calls.dynamicEvaluationSites)), entries };
  const reviewPath = join(root, "review.json");
  const bytes = Buffer.from(JSON.stringify(catalog));
  await writeFile(reviewPath, bytes);
  return { root, marker, catalog, options: { ...options, reviewPath, expectedReviewChecksum: checksum(bytes) } };
}

async function revised(options, catalog, change) {
  const next = structuredClone(catalog);
  change(next);
  const bytes = Buffer.from(JSON.stringify(next));
  await writeFile(options.reviewPath, bytes);
  return { ...options, expectedReviewChecksum: checksum(bytes) };
}

test("reviewed mappings cover actual source and dynamic sites without granting execution", { skip }, async t => {
  const { marker, options } = await fixture(t);
  const report = await invoke(options);
  assert.equal(report.sourceSites.length, 2);
  assert.equal(report.dynamicEvaluationSites.length, 3);
  assert.equal(report.resources.length, 2);
  assert.equal(report.sourceSiteReview, "classified");
  assert.equal(report.dynamicSiteReview, "classified");
  assert.equal(report.dependencyClosure, "pending");
  assert.equal(report.hostAcceptance, "pending");
  assert.equal(report.packageAcceptance, "pending");
  assert.equal(report.releaseEligible, false);
  assert.equal(report.reviewGraphChecksum, checksum(JSON.stringify([...report.sourceSites, ...report.dynamicEvaluationSites])));
  assert.equal(report.toolInputGraphChecksum, checksum(JSON.stringify(report.toolInputs)));
  assert.deepEqual(await invoke(options), report);
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("missing, duplicate, invented or stale call bindings reject even with a rebound review digest", { skip }, async t => {
  const { catalog, options } = await fixture(t);
  for (const change of [
    c => c.entries.pop(),
    c => c.entries.push(structuredClone(c.entries[0])),
    c => { c.entries[0].start++; },
    c => { c.entries[0].consumerChecksum = checksum("changed"); },
    c => { c.entries[0].argumentsChecksum = checksum("invented"); },
    c => { c.entries[0].kind = "dynamic-evaluation"; },
    c => { c.entries[0].consumerPath = "bin/unlisted"; },
  ]) await assert.rejects(invoke(await revised(options, catalog, change)), /review_site_(coverage|binding)_invalid/);
});

test("missing and equal-length modified non-Shell resource endpoints reject", { skip }, async t => {
  const { root, options } = await fixture(t);
  const path = join(root, "runtime/assets/config.json"), bytes = await readFile(path);
  await writeFile(path, bytes.toString().replace("inert", "other"));
  await assert.rejects(invoke(options), /resource_mismatch/);
  await rm(path);
  await assert.rejects(invoke(options), /resource_missing/);
});

test("review targets reject traversal, aliases, duplicates and unlisted paths", { skip }, async t => {
  const { catalog, options } = await fixture(t);
  for (const target of ["../outside", "C:\\outside", "runtime/../outside", "assets/unlisted", "assets/CONFIG.json"]) {
    await assert.rejects(invoke(await revised(options, catalog, c => { c.entries[0].targets[0] = target; })), /review_target_invalid/);
  }
  await assert.rejects(invoke(await revised(options, catalog, c => c.entries[0].targets.push(c.entries[0].targets[0]))), /review_target_invalid/);
});

test("linked non-Shell resources and linked review catalogs are rejected", { skip }, async t => {
  const { root, options } = await fixture(t);
  const target = join(root, "runtime/assets/config.json"), bytes = await readFile(target);
  await rm(target);
  await symlink(join(root, "runtime/bin/helper.sh"), target);
  await assert.rejects(invoke(options), /file_invalid/);
  await rm(target); await writeFile(target, bytes);
  const link = join(root, "review-link.json");
  await symlink(options.reviewPath, link);
  await assert.rejects(invoke({ ...options, reviewPath: link }), /file_invalid/);
});

test("generated state and user commands cannot be promoted to immutable or preapproved resources", { skip }, async t => {
  const { catalog, options } = await fixture(t);
  for (const change of [
    c => { c.entries[1].targets = ["bin/helper.sh"]; },
    c => { c.entries[1].prerequisites = []; },
    c => { c.entries[1].requiredRuntimeControl = "none"; },
    c => { c.entries[2].classification = "bundled-resource"; },
    c => { c.entries[2].prerequisites = []; },
    c => { c.entries[0].targets = []; },
    c => { c.entries[0].classification = "accepted-runtime"; },
    c => { c.releaseEligible = true; },
  ]) await assert.rejects(invoke(await revised(options, catalog, change)), /review_(policy|identity)_invalid/);
});

test("review identity is detached and bound to exact source and call graphs", { skip }, async t => {
  const { catalog, options } = await fixture(t);
  await assert.rejects(invoke({ ...options, expectedReviewChecksum: undefined }), /review_checksum_required/);
  await assert.rejects(invoke({ ...options, expectedReviewChecksum: checksum("other") }), /review_mismatch/);
  for (const key of ["upstreamRevision", "sourceManifestChecksum", "callGraphChecksum", "sourceSiteGraphChecksum", "dynamicSiteGraphChecksum"]) {
    await assert.rejects(invoke(await revised(options, catalog, c => { c[key] = checksum("different"); })), /review_identity_invalid/);
  }
});

test("inspection does not source generated state, execute commands or inherit shell startup files", { skip }, async t => {
  const { root, marker, options } = await fixture(t);
  const generated = join(root, "env"), startup = join(root, "startup.sh");
  const malicious = `touch '${marker}'\n`;
  await writeFile(generated, malicious); await writeFile(startup, malicious);
  const keys = ["STATE", "BASH_ENV", "ENV", "CODE"], previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { STATE: root, BASH_ENV: startup, ENV: startup, CODE: malicious });
  try { await invoke(options); }
  finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
  assert.equal(await readFile(generated, "utf8"), malicious);
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});
