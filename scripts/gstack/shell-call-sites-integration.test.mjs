import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { inspectGstackShellCallSites } from "./inspect-shell-call-sites.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const source = process.env.LING_GSTACK_SOURCE_CANDIDATE;
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE;
const parser = process.env.LING_GSTACK_SHELL_AST_PARSER;
const parserChecksum = process.env.LING_GSTACK_SHELL_AST_PARSER_CHECKSUM;
const skip = !(source && stage && parser && parserChecksum) && "Set the pinned source, resource stage, AST parser and detached parser checksum";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inventory = JSON.parse(await readFile(new URL("./pinned-shell-inventory.json", import.meta.url)));
const expectedCallGraph = "sha256:5dc13f5ff671e44102cb3dab305952bfebb40a3e126113dcdd879aa6d06503df";
const expectedSourceGraph = "sha256:2020036c8d5ade3b67ab6945e56f33d691afe939f797a5a4f75717a2767bfa64";

test("all original 136 Shell sources independently replay the complete staged AST call inventory", { skip }, async t => {
  const originalRoot = await realpath(resolve(source)), stageRoot = await realpath(resolve(stage));
  const manifestPath = join(originalRoot, "manifest.json"), stageReceiptPath = join(stageRoot, "resource-stage.json");
  const manifestBytes = await readFile(manifestPath), priorStageReceipt = await readFile(stageReceiptPath);
  assert.equal(checksum(manifestBytes), inventory.sourceManifestChecksum);
  assert.equal(checksum(priorStageReceipt), "sha256:8fd8702b7f47b4b10618249200316b020dcbf7a4b8ddf242705cd3bd9390e616");
  const manifest = JSON.parse(manifestBytes), records = new Map(manifest.files.map(file => [file.path, file]));
  const relocated = await realpath(await mkdtemp(join(tmpdir(), "ling original shell AST ")));
  t.after(() => rm(relocated, { recursive: true, force: true }));
  const originals = new Map();
  for (const path of inventory.shellPaths) {
    const expected = records.get(`runtime/${path}`);
    assert.ok(expected, path);
    const record = await readGstackClosureFileRecord(join(originalRoot, "runtime", path), { retain: true });
    assert.equal(record.checksum, expected.checksum, path);
    assert.equal(record.sizeBytes, expected.sizeBytes, path);
    originals.set(path, record.bytes);
    const destination = join(relocated, "runtime", path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, record.bytes, { flag: "wx" });
  }
  await writeFile(join(relocated, "source-manifest.json"), manifestBytes, { flag: "wx" });
  const shellPath = await realpath(process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash");
  const options = { expectedSourceManifestChecksum: inventory.sourceManifestChecksum, expectedUpstreamRevision: inventory.upstreamRevision,
    shellPath, expectedShellChecksum: checksum(await readFile(shellPath)), parserPath: await realpath(resolve(parser)), expectedParserChecksum: parserChecksum };
  const originalReport = await inspectGstackShellCallSites({ ...options, runtimeRoot: join(relocated, "runtime") });
  const stageReport = await inspectGstackShellCallSites({ ...options, runtimeRoot: join(stageRoot, "runtime") });
  assert.deepEqual(stageReport, originalReport);
  assert.equal(stageReport.scripts.length, 136);
  assert.equal(stageReport.scripts.reduce((count, script) => count + script.calls.length, 0), 14_990);
  assert.equal(stageReport.sourceSites.length, 128);
  assert.equal(stageReport.dynamicEvaluationSites.length, 26);
  const bracketCalls = stageReport.scripts.flatMap(script => script.calls)
    .filter(call => call.arguments[0].raw === "[");
  assert.equal(bracketCalls.length, 3_185);
  assert.ok(bracketCalls.every(call => call.arguments[0].literal === "["));
  assert.equal(stageReport.unresolvedCommandSites.length, 270);
  assert.equal(stageReport.callGraphChecksum, expectedCallGraph);
  assert.equal(stageReport.sourceSiteGraphChecksum, expectedSourceGraph);
  assert.equal(stageReport.dependencyClosure, "pending");
  assert.equal(stageReport.releaseEligible, false);
  for (const script of stageReport.scripts) {
    const bytes = originals.get(script.path);
    for (const call of script.calls) for (const argument of call.arguments) {
      assert.equal(bytes.subarray(argument.start, argument.end).toString("utf8"), argument.raw);
    }
    assert.equal(checksum(await readFile(join(originalRoot, "runtime", script.path))), checksum(bytes));
  }
  assert.equal(checksum(await readFile(manifestPath)), checksum(manifestBytes));
  assert.equal(checksum(await readFile(stageReceiptPath)), checksum(priorStageReceipt));
  t.diagnostic(JSON.stringify({ scripts: 136, calls: 14_990, directSourceSites: 128,
    directDynamicEvaluationSites: 26, singletonBracketCommands: 3_185, unresolvedCommandExpressions: 270,
    callGraphChecksum: expectedCallGraph, sourceSiteGraphChecksum: expectedSourceGraph,
    toolInputGraphChecksum: stageReport.toolInputGraphChecksum, releaseEligible: false }));
});
