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
const invoke = async options => (await import("./verify-reviewed-shell-commands.mjs")).verifyReviewedGstackShellCommands(options);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling command review ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "must-not-execute"), revision = "a".repeat(40);
  const sources = new Map([
    ["bin/main.sh", `"$HELPER" one\n"$HELPER" two\n"$@"\n$flag\n"$PROGRAM" --version\ntouch '${marker}'\n`],
    ["bin/helper.sh", "printf inert\n"], ["src/cli.ts", "console.log('inert');\n"],
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
    upstreamRevision: revision, sourceManifestChecksum: checksum(manifest), shellPaths: ["bin/main.sh", "bin/helper.sh"], reviewedSourceEdges: [] }));
  const inventoryPath = join(root, "inventory.json");
  await writeFile(inventoryPath, inventory);
  const shellPath = await realpath(process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash");
  const options = { runtimeRoot: join(root, "runtime"), inventoryPath,
    expectedInventoryChecksum: checksum(inventory), expectedSourceManifestChecksum: checksum(manifest), expectedUpstreamRevision: revision,
    shellPath, expectedShellChecksum: checksum(await readFile(shellPath)), parserPath: await realpath(resolve(parser)),
    expectedParserChecksum: checksum(await readFile(parser)) };
  const calls = await inspectGstackShellCallSites(options);
  const groups = new Map();
  for (const site of calls.unresolvedCommandSites) {
    const raw = site.arguments[0].raw;
    groups.set(raw, [...(groups.get(raw) ?? []), site]);
  }
  const policies = {
    '"$HELPER"': { classification: "bundled-command", requiredRuntimeControl: "frozen-bundle-command",
      targets: ["bin/helper.sh"], products: [], choices: [], prerequisites: [] },
    '"$@"': { classification: "forwarded-command", requiredRuntimeControl: "approved-exact-command",
      targets: [], products: [], choices: [], prerequisites: ["explicit-command-and-external-effects-approval"] },
    '$flag': { classification: "boolean-command", requiredRuntimeControl: "structured-boolean-state",
      targets: [], products: [], choices: ["true", "false"], prerequisites: ["owned-typed-state"] },
    '"$PROGRAM"': { classification: "generated-program", requiredRuntimeControl: "verified-owned-program",
      targets: ["src/cli.ts"], products: ["dist/cli"], choices: [], prerequisites: ["verified-generated-program", "native-platform-acceptance"] },
  };
  const entries = [...groups].map(([commandRaw, sites]) => ({ commandRaw, siteCount: sites.length,
    siteGraphChecksum: checksum(JSON.stringify(sites)), ...policies[commandRaw], reason: "Reviewed fixture command with separately pending runtime controls." }));
  const catalog = { schemaVersion: 1, reviewStatus: "reviewed-command-expression-mappings", releaseEligible: false,
    upstreamRevision: revision, sourceManifestChecksum: checksum(manifest), callGraphChecksum: calls.callGraphChecksum,
    commandSiteGraphChecksum: checksum(JSON.stringify(calls.unresolvedCommandSites)), entries };
  const reviewPath = join(root, "commands.json"), bytes = Buffer.from(JSON.stringify(catalog));
  await writeFile(reviewPath, bytes);
  return { root, marker, catalog, options: { ...options, commandReviewPath: reviewPath, expectedCommandReviewChecksum: checksum(bytes) } };
}

async function revised(options, catalog, change) {
  const next = structuredClone(catalog);
  change(next);
  const bytes = Buffer.from(JSON.stringify(next));
  await writeFile(options.commandReviewPath, bytes);
  return { ...options, expectedCommandReviewChecksum: checksum(bytes) };
}

test("command review binds every expression and immutable resource without approving execution", { skip }, async t => {
  const { marker, options } = await fixture(t);
  const report = await invoke(options);
  assert.equal(report.commandExpressionCount, 5);
  assert.equal(report.commandGroupCount, 4);
  assert.equal(report.resources.length, 2);
  assert.equal(report.commandExpressionReview, "classified");
  for (const key of ["dependencyClosure", "hostAcceptance", "packageAcceptance"]) assert.equal(report[key], "pending");
  assert.equal(report.releaseEligible, false);
  assert.ok(report.entries.every(entry => entry.runtimeControlAcceptance === "pending"));
  assert.equal(report.reviewGraphChecksum, checksum(JSON.stringify(report.entries)));
  assert.deepEqual(await invoke(options), report);
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("omitted, duplicate, invented and changed groups fail despite a rebound catalog digest", { skip }, async t => {
  const { catalog, options } = await fixture(t);
  for (const change of [
    c => c.entries.pop(), c => c.entries.push(c.entries[0]),
    c => { c.entries[0].commandRaw = '"$OTHER"'; },
    c => { c.entries[0].siteCount--; }, c => { c.entries[0].siteGraphChecksum = checksum("invented"); },
  ]) await assert.rejects(invoke(await revised(options, catalog, change)), /review_(coverage|binding)_invalid/);
});

test("detached review binds source and the complete command graph", { skip }, async t => {
  const { catalog, options } = await fixture(t);
  await assert.rejects(invoke({ ...options, expectedCommandReviewChecksum: undefined }), /review_checksum_required/);
  await assert.rejects(invoke({ ...options, expectedCommandReviewChecksum: checksum("other") }), /review_mismatch/);
  for (const key of ["upstreamRevision", "sourceManifestChecksum", "callGraphChecksum", "commandSiteGraphChecksum"]) {
    await assert.rejects(invoke(await revised(options, catalog, c => { c[key] = checksum("changed"); })), /review_identity_invalid/);
  }
});

test("missing, equal-length changed and linked resources reject before execution", { skip }, async t => {
  const { root, marker, options } = await fixture(t);
  const path = join(root, "runtime/src/cli.ts"), bytes = await readFile(path);
  await writeFile(path, bytes.toString().replace("inert", "other"));
  await assert.rejects(invoke(options), /resource_mismatch/);
  await rm(path);
  await assert.rejects(invoke(options), /resource_missing/);
  await symlink(join(root, "runtime/bin/helper.sh"), path);
  await assert.rejects(invoke(options), /file_invalid/);
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("classification cannot erase runtime approval, generated identity or boolean bounds", { skip }, async t => {
  const { catalog, options } = await fixture(t);
  for (const change of [
    c => { c.releaseEligible = true; }, c => { c.entries[1].prerequisites = []; },
    c => { c.entries[1].classification = "bundled-command"; },
    c => { c.entries[2].choices = ["true", "curl"]; },
    c => { c.entries[3].products = []; },
    c => { c.entries[0].requiredRuntimeControl = "none"; },
    c => { c.entries[0].targets = []; },
  ]) await assert.rejects(invoke(await revised(options, catalog, change)), /review_(identity|policy)_invalid/);
});

test("targets and generated paths reject traversal, native paths and aliases", { skip }, async t => {
  const { catalog, options } = await fixture(t);
  for (const path of ["../outside", "C:\\outside", "x/../y", "x:y", "bin/HELPER.sh", "bin/unlisted"]) {
    await assert.rejects(invoke(await revised(options, catalog, c => { c.entries[0].targets[0] = path; })), /review_target_invalid/);
  }
  for (const path of ["../outside", "C:\\outside", "x/../y", "x:y"]) {
    await assert.rejects(invoke(await revised(options, catalog, c => { c.entries[3].products[0] = path; })), /review_policy_invalid/);
  }
  await assert.rejects(invoke(await revised(options, catalog, c => { c.entries[3].products.push("DIST/cli"); })), /review_policy_invalid/);
  await assert.rejects(invoke(await revised(options, catalog, c => c.entries[0].targets.push("bin/helper.sh"))), /review_target_invalid/);
});

test("review never reads global commands or generated products and ignores inherited startup hooks", { skip }, async t => {
  const { root, marker, options } = await fixture(t);
  const startup = join(root, "startup.sh"), malicious = `touch '${marker}'\n`;
  await writeFile(startup, malicious);
  const keys = ["HELPER", "BASH_ENV", "PROGRAM", "flag"], previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { HELPER: startup, BASH_ENV: startup, PROGRAM: startup, flag: malicious });
  try { await invoke(options); }
  finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
  await assert.rejects(lstat(marker), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "runtime/dist")), { code: "ENOENT" });
});
