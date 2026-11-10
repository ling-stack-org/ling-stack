import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { PINNED_SHELL_COMMAND_REVIEW_CHECKSUM, verifyReviewedGstackShellCommands } from "./verify-reviewed-shell-commands.mjs";

const source = process.env.LING_GSTACK_SOURCE_CANDIDATE;
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE;
const parser = process.env.LING_GSTACK_SHELL_AST_PARSER;
const parserChecksum = process.env.LING_GSTACK_SHELL_AST_PARSER_CHECKSUM;
const skip = !(source && stage && parser && parserChecksum) && "Set original source, resource stage and detached parser identity";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("all 270 expressions independently replay original bytes and their 50 resource endpoints", { skip }, async t => {
  const original = await realpath(resolve(source)), prepared = await realpath(resolve(stage));
  const manifest = await readFile(join(original, "manifest.json")), receipt = await readFile(join(prepared, "resource-stage.json"));
  const catalogBytes = await readFile(new URL("./reviewed-shell-commands.json", import.meta.url));
  assert.equal(checksum(catalogBytes), PINNED_SHELL_COMMAND_REVIEW_CHECKSUM);
  const catalog = JSON.parse(catalogBytes), inventory = JSON.parse(await readFile(new URL("./pinned-shell-inventory.json", import.meta.url)));
  assert.equal(checksum(manifest), catalog.sourceManifestChecksum);
  const records = new Map(JSON.parse(manifest).files.map(file => [file.path, file]));
  const paths = new Set([...inventory.shellPaths, ...catalog.entries.flatMap(entry => entry.targets)]);
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling original command review ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of paths) {
    const expected = records.get(`runtime/${path}`);
    assert.ok(expected, path);
    const actual = await readGstackClosureFileRecord(join(original, "runtime", path), { retain: true });
    assert.equal(actual.checksum, expected.checksum, path);
    await mkdir(dirname(join(root, "runtime", path)), { recursive: true });
    await writeFile(join(root, "runtime", path), actual.bytes, { flag: "wx" });
  }
  await writeFile(join(root, "source-manifest.json"), manifest, { flag: "wx" });
  const shellPath = await realpath(process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash");
  const options = { parserPath: await realpath(resolve(parser)), expectedParserChecksum: parserChecksum,
    expectedSourceManifestChecksum: catalog.sourceManifestChecksum, expectedUpstreamRevision: catalog.upstreamRevision,
    shellPath, expectedShellChecksum: checksum(await readFile(shellPath)) };
  const originalReport = await verifyReviewedGstackShellCommands({ ...options, runtimeRoot: join(root, "runtime") });
  const stageReport = await verifyReviewedGstackShellCommands({ ...options, runtimeRoot: join(prepared, "runtime") });
  assert.deepEqual(stageReport, originalReport);
  assert.equal(stageReport.commandExpressionCount, 270);
  assert.equal(stageReport.commandGroupCount, 99);
  assert.equal(stageReport.resources.length, 50);
  assert.equal(stageReport.dependencyClosure, "pending");
  assert.equal(stageReport.releaseEligible, false);
  assert.ok(stageReport.entries.every(entry => entry.runtimeControlAcceptance === "pending"));
  const entry = raw => stageReport.entries.find(item => item.commandRaw === raw);
  assert.deepEqual(entry('"$URL_BIN"').targets.map(item => item.path), ["bin/gstack-artifacts-url"]);
  assert.deepEqual(entry('"$EGRESS_BIN"').targets.map(item => item.path), ["bin/gstack-egress"]);
  assert.deepEqual(entry('"$bin"').targets.map(item => item.path), ["bin/gstack-egress-receipt"]);
  assert.deepEqual(entry('"$_log_bin"').targets.map(item => item.path), ["bin/gstack-learnings-log"]);
  assert.equal(entry('"$fn"').classification, "function-dispatch");
  assert.equal(entry('"$BROWSE_BIN"').classification, "generated-program");
  assert.equal(entry('"$@"').classification, "forwarded-command");
  assert.equal(entry('"${sync_cmd[@]}"').classification, "service-command");
  for (const path of paths) assert.equal((await readGstackClosureFileRecord(join(original, "runtime", path))).checksum, records.get(`runtime/${path}`).checksum);
  assert.deepEqual(await readFile(join(original, "manifest.json")), manifest);
  assert.deepEqual(await readFile(join(prepared, "resource-stage.json")), receipt);
  t.diagnostic(JSON.stringify({ groups: 99, expressions: 270, resourceEndpoints: 50,
    reviewGraphChecksum: stageReport.reviewGraphChecksum, resourceGraphChecksum: stageReport.resourceGraphChecksum, releaseEligible: false }));
});

test("resource preparation retains the exact indirect-command review as a non-executable prerequisite", { skip }, async () => {
  const bytes = await readFile(join(stage, "reviewed-shell-commands.json"));
  const receiptBytes = await readFile(join(stage, "resource-stage.json"));
  assert.equal(checksum(receiptBytes), "sha256:8fd8702b7f47b4b10618249200316b020dcbf7a4b8ddf242705cd3bd9390e616");
  const report = JSON.parse(bytes), receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.shellCommandReviewChecksum, checksum(bytes));
  assert.equal(receipt.shellCommandReviewCatalogChecksum, PINNED_SHELL_COMMAND_REVIEW_CHECKSUM);
  assert.equal(receipt.shellReviewedCommandExpressionCount, 270);
  assert.equal(receipt.shellReviewedCommandGroupCount, 99);
  assert.equal(receipt.shellCommandReviewGraphChecksum, report.reviewGraphChecksum);
  assert.equal(receipt.shellCommandResourceCount, 50);
  assert.equal(report.releaseEligible, false);
  assert.equal(receipt.releaseEligible, false);
});
