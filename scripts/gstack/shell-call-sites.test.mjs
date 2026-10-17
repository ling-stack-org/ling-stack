import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const checksum = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const revision = "a".repeat(40);
const parser = process.env.LING_GSTACK_SHELL_AST_PARSER;
const skip = !parser && "Build the pinned parse-only helper and set LING_GSTACK_SHELL_AST_PARSER";
const invoke = async options => (await import("./inspect-shell-call-sites.mjs")).inspectGstackShellCallSites(options);

async function fixture(t, additionalScripts = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling shell call sites ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = new Map([
    ["bin/main.sh", "# source comment-only.sh\ncat <<'END'\nsource document-only.sh\nEND\nsource \"$GSTACK_ROOT/bin/helper.sh\"\neval \"$CODE\"\n"],
    ["bin/helper.sh", "printf 'inert'\n"],
    ["migrations/inert.sh", ". '/external/required.conf'\n\"$COMMAND\" \"$ARG\"\n"],
    ...additionalScripts,
  ]);
  const files = [];
  for (const [path, source] of scripts) {
    await mkdir(dirname(join(root, "runtime", path)), { recursive: true });
    await writeFile(join(root, "runtime", path), source);
    files.push({ path: `runtime/${path}`, checksum: checksum(source), sizeBytes: Buffer.byteLength(source) });
  }
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "source", upstream: { revision }, files }));
  await writeFile(join(root, "source-manifest.json"), manifest);
  const inventory = Buffer.from(JSON.stringify({ schemaVersion: 1, reviewStatus: "pinned-source-census", releaseEligible: false,
    upstreamRevision: revision, sourceManifestChecksum: checksum(manifest), shellPaths: [...scripts.keys()],
    reviewedSourceEdges: [["bin/main.sh", "bin/helper.sh"]] }));
  const inventoryPath = join(root, "inventory.json");
  await writeFile(inventoryPath, inventory);
  const shellPath = await realpath(process.env.LING_GSTACK_BASH_PATH ?? "/bin/bash");
  return { root, options: { runtimeRoot: join(root, "runtime"), inventoryPath,
    expectedInventoryChecksum: checksum(inventory), expectedSourceManifestChecksum: checksum(manifest),
    expectedUpstreamRevision: revision, shellPath, expectedShellChecksum: checksum(await readFile(shellPath)),
    parserPath: await realpath(resolve(parser)), expectedParserChecksum: checksum(await readFile(parser)) } };
}

test("AST inventory binds every source site and preserves unresolved runtime dependencies", { skip }, async t => {
  const { options } = await fixture(t);
  const report = await invoke(options);
  assert.equal(report.scripts.length, 3);
  assert.equal(report.sourceSites.length, 2);
  assert.equal(report.dynamicEvaluationSites.length, 1);
  assert.equal(report.unresolvedCommandSites.length, 1);
  assert.equal(report.sourceSites[0].arguments[1].literal, null);
  assert.equal(report.sourceSites[1].arguments[1].literal, "/external/required.conf");
  assert.equal(report.callGraphChecksum, checksum(JSON.stringify(report.scripts)));
  assert.equal(report.releaseEligible, false);
  assert.equal(report.dependencyClosure, "pending");
  assert.equal(report.hostAcceptance, "pending");
  assert.equal(report.packageAcceptance, "pending");
  assert.equal(report.parser.version, "v3.14.1");
  assert.equal(report.toolInputGraphChecksum, checksum(JSON.stringify(report.toolInputs)));
  assert.equal(report.sourceManifestChecksum, options.expectedSourceManifestChecksum);
  assert.deepEqual(await invoke(options), report, "parse-only reports must replay byte-identically");
});

test("singleton bracket commands retain literal identity without resolving actual patterns", { skip }, async t => {
  const source = "[ -n \"$VALUE\" ]\n'[' -n value ']'\n\"[\" -n value \"]\"\n[ab] value\n[\"a\"] value\n[\"$SUFFIX\" value\nprintf [\n";
  const { options } = await fixture(t, [["brackets.sh", source]]);
  const report = await invoke(options);
  const calls = report.scripts.find(script => script.path === "brackets.sh").calls;
  assert.deepEqual(calls.map(call => call.arguments[0].literal), ["[", "[", "[", null, null, null, "printf"]);
  assert.equal(calls[0].arguments[2].literal, null);
  assert.equal(calls[6].arguments[1].literal, null);
  assert.equal(report.unresolvedCommandSites.filter(site => site.consumerPath === "brackets.sh").length, 3);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.dependencyClosure, "pending");
});

test("parser reports cannot invent spans, script identities or AST node kinds", { skip }, async t => {
  const { root, options } = await fixture(t);
  const valid = await invoke(options);
  for (const change of [
    report => { report.scripts[0].calls[0].line++; },
    report => { report.scripts[0].calls[0].arguments[0].raw = "invented"; },
    report => { report.scripts[0].calls[0].arguments[0].partKinds = ["UnknownNode"]; },
    report => { report.scripts[0].checksum = checksum("invented"); },
    report => { report.scripts[1].path = report.scripts[0].path; },
  ]) {
    const report = { schemaVersion: 1, parser: valid.parser.name, parserVersion: valid.parser.version,
      dialect: valid.parser.dialect, validationMode: "parse-only", scripts: structuredClone(valid.scripts) };
    change(report);
    const path = join(root, "invalid-report-parser");
    const source = `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(report))});\n`;
    await writeFile(path, source); await chmod(path, 0o700);
    await assert.rejects(invoke({ ...options, parserPath: path, expectedParserChecksum: checksum(source) }), /parser_report_invalid/);
  }
});

test("missing and equal-length altered source bytes reject before AST publication", { skip }, async t => {
  const { root, options } = await fixture(t);
  const path = join(root, "runtime/bin/helper.sh"), original = await readFile(path);
  await writeFile(path, original.toString().replace("inert", "other"));
  await assert.rejects(invoke(options), /source_mismatch/);
  await rm(path);
  await assert.rejects(invoke(options), /script_missing/);
});

test("parse-only inventory never evaluates scripts or inherited shell startup hooks", { skip }, async t => {
  const { root, options } = await fixture(t);
  const marker = join(root, "must-not-exist"), startup = join(root, "startup.sh");
  await writeFile(startup, `touch '${marker}'\n`);
  const previous = process.env.BASH_ENV;
  process.env.BASH_ENV = startup;
  try { await invoke(options); }
  finally { if (previous === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = previous; }
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("detached parser identity and timeout bounds are mandatory", { skip }, async t => {
  const { options } = await fixture(t);
  await assert.rejects(invoke({ ...options, expectedParserChecksum: undefined }), /parser_checksum_required/);
  await assert.rejects(invoke({ ...options, expectedParserChecksum: checksum("other") }), /parser_mismatch/);
  await assert.rejects(invoke({ ...options, parserTimeoutMs: 0 }), /timeout_invalid/);
  await assert.rejects(invoke({ ...options, parserTimeoutMs: 30_001 }), /timeout_invalid/);
});

test("linked parser executables reject without evaluation", { skip }, async t => {
  const { root, options } = await fixture(t);
  const linked = join(root, "linked-parser");
  await symlink(options.parserPath, linked);
  await assert.rejects(invoke({ ...options, parserPath: linked }), /file_invalid/);
});

test("malformed or timed-out parser output cannot become a valid inventory", { skip }, async t => {
  const { root, options } = await fixture(t);
  const path = join(root, "test-parser");
  for (const [source, message, timeout] of [
    ["#!/bin/bash\nprintf '{\"schemaVersion\":1,\"scripts\":[]}'\n", /parser_report_invalid/, 5_000],
    ["#!/bin/bash\nwhile :; do :; done\n", /parser_failed:ETIMEDOUT/, 100],
  ]) {
    await writeFile(path, source); await chmod(path, 0o700);
    await assert.rejects(invoke({ ...options, parserPath: path, expectedParserChecksum: checksum(source), parserTimeoutMs: timeout }), message);
  }
});
