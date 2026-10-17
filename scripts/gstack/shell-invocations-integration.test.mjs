import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { inspectGstackShellInvocations } from "./inspect-shell-invocations.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const parser = process.env.LING_GSTACK_SHELL_AST_PARSER;
const source = process.env.LING_GSTACK_SOURCE_CANDIDATE;
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE;
const parserChecksum = process.env.LING_GSTACK_SHELL_AST_PARSER_CHECKSUM;
const skip = !parser && "Set the verified build-only Shell AST parser";
const actualSkip = !(parser && source && stage && parserChecksum) && "Set original source, prepared resources and detached parser identity";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling invocation fixture ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "must-not-run"), revision = "a".repeat(40);
  const text = `# exec node comment.js\ncat <<'DOC'\nexec bun document.ts\nDOC\nexec bun "$ENTRY"\ntimeout 90 node -e "$PROBE"\ncommand -v "$tool"\nbash -lc "touch '${marker}'"\npython3 - <<'PY'\nprint('node hidden.py')\nPY\n`;
  await mkdir(join(root, "runtime/bin"), { recursive: true });
  await writeFile(join(root, "runtime/bin/fixture"), text);
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "source", upstream: { revision },
    files: [{ path: "runtime/bin/fixture", checksum: checksum(text), sizeBytes: Buffer.byteLength(text) }] }));
  await writeFile(join(root, "source-manifest.json"), manifest);
  const census = Buffer.from(JSON.stringify({ schemaVersion: 1, reviewStatus: "pinned-source-census", releaseEligible: false,
    upstreamRevision: revision, sourceManifestChecksum: checksum(manifest), shellPaths: ["bin/fixture"], reviewedSourceEdges: [] }));
  const inventoryPath = join(root, "inventory.json");
  await writeFile(inventoryPath, census);
  const shellPath = await realpath(process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash");
  return { root, marker, options: { runtimeRoot: join(root, "runtime"), inventoryPath,
    expectedInventoryChecksum: checksum(census), expectedSourceManifestChecksum: checksum(manifest), expectedUpstreamRevision: revision,
    parserPath: await realpath(resolve(parser)), expectedParserChecksum: checksum(await readFile(parser)),
    shellPath, expectedShellChecksum: checksum(await readFile(shellPath)) } };
}

test("real AST retains wrapped boundaries, inline programs and stdin without execution", { skip }, async t => {
  const { marker, options } = await fixture(t);
  const report = await inspectGstackShellInvocations(options);
  assert.equal(report.invocations.length, 5);
  assert.equal(report.invocations[0].interpretation.effectiveCommand.literal, "bun");
  assert.equal(report.invocations[0].interpretation.interpreter.mode, "unresolved");
  assert.equal(report.invocations[1].interpretation.interpreter.resource.raw, '"$PROBE"');
  assert.equal(report.invocations[2].interpretation.kind, "discovery");
  assert.equal(report.invocations[3].interpretation.interpreter.mode, "inline");
  assert.equal(report.invocations[4].interpretation.interpreter.mode, "stdin");
  assert.equal(report.invocationGraphChecksum, checksum(JSON.stringify(report.invocations)));
  assert.equal(report.toolInputGraphChecksum, checksum(JSON.stringify(report.toolInputs)));
  assert.equal(report.releaseEligible, false);
  assert.ok(report.invocations.every(site => site.interpretation.runtimeAcceptance === "pending"));
  assert.deepEqual(await inspectGstackShellInvocations(options), report);
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("actual inspection rejects changed source and never promotes prerequisite resources", { skip }, async t => {
  const { root, options } = await fixture(t);
  const path = join(root, "runtime/bin/fixture"), text = await readFile(path, "utf8");
  await writeFile(path, text.replace("hidden", "edited"));
  await assert.rejects(inspectGstackShellInvocations(options), /source_mismatch/);
});

test("all original source bytes replay the prepared invocation graph under relocation", { skip: actualSkip }, async t => {
  const original = await realpath(resolve(source)), prepared = await realpath(resolve(stage));
  const manifest = await readFile(join(original, "manifest.json")), before = await readFile(join(prepared, "resource-stage.json"));
  const records = new Map(JSON.parse(manifest).files.map(file => [file.path, file]));
  const census = JSON.parse(await readFile(new URL("./pinned-shell-inventory.json", import.meta.url)));
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling original invocations ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(checksum(manifest), census.sourceManifestChecksum);
  for (const path of census.shellPaths) {
    const expected = records.get(`runtime/${path}`), actual = await readGstackClosureFileRecord(join(original, "runtime", path), { retain: true });
    assert.equal(actual.checksum, expected.checksum, path);
    await mkdir(dirname(join(root, "runtime", path)), { recursive: true });
    await writeFile(join(root, "runtime", path), actual.bytes, { flag: "wx" });
  }
  await writeFile(join(root, "source-manifest.json"), manifest, { flag: "wx" });
  const shellPath = await realpath(process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash");
  const options = { parserPath: await realpath(resolve(parser)), expectedParserChecksum: parserChecksum,
    expectedSourceManifestChecksum: census.sourceManifestChecksum, expectedUpstreamRevision: census.upstreamRevision,
    shellPath, expectedShellChecksum: checksum(await readFile(shellPath)) };
  const originalReport = await inspectGstackShellInvocations({ ...options, runtimeRoot: join(root, "runtime") });
  const preparedReport = await inspectGstackShellInvocations({ ...options, runtimeRoot: join(prepared, "runtime") });
  assert.deepEqual(preparedReport, originalReport);
  assert.equal(checksum(JSON.stringify(JSON.parse(await readFile(join(prepared, "shell-invocations.json"))))),
    checksum(JSON.stringify(preparedReport)), "staged invocation report must match a fresh original-source replay");
  const at = (path, line) => preparedReport.invocations.find(site => site.consumerPath === path && site.line === line
    && site.arguments[0].literal !== "command")?.interpretation;
  assert.equal(at("bin/gstack-browser-ensure", 56).interpreter.name, "node");
  assert.equal(at("bin/gstack-ios-qa-daemon", 70).interpreter.name, "bun");
  assert.equal(at("lib/cso/images/entrypoint", 12).boundaryArgument.raw, '"$@"');
  assert.equal(at("bin/gstack-launch-probe.sh", 28).boundaryArgument.raw, '"$1"');
  assert.equal(at("scripts/build.sh", 66).interpreter.resource.literal, "scripts/build-cso.sh");
  assert.equal(at("bin/gstack-gbrain-install", 188).interpreter.mode, "package-operation");
  assert.equal(at("bin/gstack-gbrain-install", 188).interpreter.operation.literal, "link");
  assert.equal(at("bin/gstack-gbrain-install", 188).interpreter.resource, undefined);
  assert.equal(preparedReport.releaseEligible, false);
  for (const path of census.shellPaths) assert.equal((await readGstackClosureFileRecord(join(original, "runtime", path))).checksum, records.get(`runtime/${path}`).checksum);
  assert.deepEqual(await readFile(join(original, "manifest.json")), manifest);
  assert.deepEqual(await readFile(join(prepared, "resource-stage.json")), before);
  t.diagnostic(JSON.stringify({ invocations: preparedReport.invocations.length,
    invocationGraphChecksum: preparedReport.invocationGraphChecksum, releaseEligible: false }));
});

test("resource preparation requires the invocation analysis rather than only outer commands", { skip: actualSkip }, async () => {
  const receipt = JSON.parse(await readFile(join(stage, "resource-stage.json")));
  assert.match(receipt.shellInvocationAnalysisChecksum ?? "", /^sha256:[a-f0-9]{64}$/);
  const bytes = await readFile(join(stage, "shell-invocations.json")), report = JSON.parse(bytes);
  assert.equal(receipt.shellInvocationAnalysisChecksum, checksum(bytes));
  assert.equal(receipt.shellInvocationGraphChecksum, report.invocationGraphChecksum);
  assert.equal(receipt.shellInvocationCount, report.invocations.length);
  assert.equal(report.releaseEligible, false);
  assert.equal(receipt.releaseEligible, false);
});
