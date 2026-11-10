import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { verifyGstackSharedCommandClosure } from "./verify-shared-command-closure.mjs";
import * as closure from "./verify-shared-command-closure.mjs";

const stage = process.env.LING_GSTACK_RESOURCE_STAGE;
const bun = stage ? resolve(stage, "runtime/tools/bun") : undefined;
const skip = !bun && "Set LING_GSTACK_RESOURCE_STAGE to a reviewed local prerequisite stage";
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling shared command closure "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime");
  const files = [];
  for (const [path, text] of [
    ["bin/gstack-model-benchmark", '#!/usr/bin/env bun\nimport { value } from "../test/helpers/benchmark-runner"; if (process.argv.includes("--judge")) { const { judge } = await import("../test/helpers/benchmark-judge"); await judge(); } console.log(value);\n'],
    ["bin/gstack-claude-code", '#!/usr/bin/env bun\nthrow new Error("external CLI command must not execute"); export const provider = "external-claude-cli";\n'],
    ["scripts/ship-measure.ts", 'export const command = "measure";\n'],
    ["scripts/test-paid-shards.ts", 'import { dispatch } from "child-only-module"; import "./lib/paid-plan"; throw new Error("dynamic child must not execute"); export const run = dispatch;\n'],
    ["scripts/lib/paid-plan.ts", 'export const durations = "scripts/paid-test-durations.json";\n'],
    ["scripts/test-free-shards.ts", 'export const durations = "scripts/free-test-durations.json";\n'],
    ["scripts/paid-test-durations.json", '{"version":2,"tiers":{}}\n'],
    ["scripts/free-test-durations.json", '{"version":1,"durations":{}}\n'],
    ["bin/gstack-config", '#!/usr/bin/env bash\nexit 1\n'],
    ["scripts/ubicloud/test-free.sh", '#!/usr/bin/env bash\nexit 1\n'],
    ["scripts/ubicloud/ubi-runner.sh", '#!/usr/bin/env bash\nexit 1\n'],
    ["scripts/ubicloud/setup-free-suite.sh", '#!/usr/bin/env bash\nexit 1\n'],
    ["browse/scripts/build-node-server.sh", '#!/usr/bin/env bash\nexit 1\n'],
    ["test/helpers/benchmark-runner.ts", 'export const value = "benchmark";\n'],
    ["test/helpers/benchmark-judge.ts", 'export const judge = () => import("@anthropic-ai/sdk");\n'],
    ["test/skill-e2e-overlay.test.ts", 'import { query } from "@anthropic-ai/claude-agent-sdk"; export const run = query;\n'],
  ]) {
    await mkdir(dirname(join(runtime, path)), { recursive: true });
    await writeFile(join(runtime, path), text);
    files.push({ path: `runtime/${path}`, sizeBytes: Buffer.byteLength(text), checksum: hash(text) });
  }
  const pkg = join(runtime, "node_modules/@anthropic-ai/claude-agent-sdk");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-fixture", type: "module", exports: "./sdk.mjs" }));
  await writeFile(join(pkg, "sdk.mjs"), 'throw new Error("compiler must never execute a module"); export function query() {}\n');
  const api = join(runtime, "node_modules/@anthropic-ai/sdk");
  await mkdir(api, { recursive: true });
  await writeFile(join(api, "package.json"), JSON.stringify({ name: "@anthropic-ai/sdk", version: "0.0.0-fixture", type: "module", exports: "./index.mjs" }));
  await writeFile(join(api, "index.mjs"), 'throw new Error("optional API client must never execute"); export default class Anthropic {}\n');
  const child = join(runtime, "node_modules/child-only-module");
  await mkdir(child, { recursive: true });
  await writeFile(join(child, "package.json"), JSON.stringify({ name: "child-only-module", version: "0.0.0-fixture", type: "module", exports: "./index.js" }));
  await writeFile(join(child, "index.js"), 'throw new Error("child dependency must never execute"); export function dispatch() {}\n');
  const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, deliveryStage: "source", upstream: { revision: lock.revision }, files })}\n`);
  await writeFile(join(root, "source-manifest.json"), manifest);
  return { root, runtime, manifest, options: { runtimeRoot: runtime, bunPath: bun,
    expectedBunChecksum: hash(await readFile(bun)), expectedSourceManifestChecksum: hash(manifest) } };
}

async function addSources({ root, runtime, manifest, options }, records) {
  const data = JSON.parse(manifest);
  for (const [path, text] of records) {
    await mkdir(dirname(join(runtime, path)), { recursive: true });
    await writeFile(join(runtime, path), text);
    data.files.push({ path: `runtime/${path}`, sizeBytes: Buffer.byteLength(text), checksum: hash(text) });
  }
  const changed = Buffer.from(JSON.stringify(data));
  await writeFile(join(root, "source-manifest.json"), changed);
  return { ...options, expectedSourceManifestChecksum: hash(changed) };
}

test("client imports discover every source-bound Bun command, including env -S and extensionless TypeScript", { skip }, async t => {
  const data = await fixture(t);
  const options = await addSources(data, [
    ["bin/gstack-new-command", '#!/usr/bin/env -S bun --no-env-file run\nimport { value } from "../lib/new-client-helper"; const typed: string = value; throw new Error(typed);\n'],
    ["lib/new-client-helper.ts", 'export const value = "new command must not execute";\n'],
  ]);
  const report = await closure.verifyGstackClientCommandImports({ ...options, entrypoints: [] });
  assert.ok(report.entrypoints.includes("bin/gstack-new-command"));
  assert.ok(report.inputs.some(input => input.path === "lib/new-client-helper.ts"));
  assert.equal(report.bunCommandCount, 3);
  assert.equal(report.entrypointSelection, "all-source-manifest-bin-bun-commands-plus-client-shared-roots");
  assert.equal(report.runtimeResourceSelection, "pending");
});

test("client checks reject missing commands and tampered shebangs before a command can disappear from selection", { skip }, async t => {
  const data = await fixture(t);
  const options = await addSources(data, [["bin/gstack-new-command", '#!/usr/bin/env bun\nexport const value = "client";\n']]);
  const path = join(data.runtime, "bin/gstack-new-command");
  await writeFile(path, '#!/usr/bin/env sh \nexport const value = "client";\n');
  await assert.rejects(closure.verifyGstackClientCommandImports(options), /gstack_shared_command_source_input_mismatch/);
  await rm(path);
  await assert.rejects(closure.verifyGstackClientCommandImports(options), /gstack_shared_command_entry_missing:bin\/gstack-new-command/);
});

test("discovered client commands cannot silently lose required dependencies", { skip }, async t => {
  const data = await fixture(t);
  const options = await addSources(data, [["bin/gstack-new-command", '#!/usr/bin/env bun\nimport { run } from "missing-client-module"; await run();\n']]);
  await assert.rejects(closure.verifyGstackClientCommandImports(options), /gstack_shared_command_build_failed/);
});

test("build dependency checks retain native and browser-embedded inputs without executing or writing artifacts", { skip }, async t => {
  const data = await fixture(t);
  const options = await addSources(data, [
    ...["browse/src/cli.ts", "browse/src/find-browse.ts", "design/src/cli.ts", "make-pdf/src/cli.ts",
      "bin/gstack-global-discover.ts", "lib/cso/cli.ts"].map(path => [path, 'import { value } from "embedded-client-module"; console.log(value); throw new Error("native entry must not execute");\n']),
    ["browse/src/server.ts", 'import { chromium } from "playwright"; console.log(chromium); throw new Error("server must not execute");\n'],
    ["lib/diagram-render/src/entry.ts", 'import { value } from "embedded-client-module"; console.log(value); throw new Error("diagram must not execute");\n'],
    ["browse/src/security-sidecar-entry.ts", 'import { value } from "./security-classifier"; console.log(value); throw new Error("sidecar must not execute");\n'],
    ["browse/src/security-classifier.ts", 'export const value = "sidecar"; export async function load() { return import("@huggingface/transformers"); }\n'],
  ]);
  const pkg = join(data.runtime, "node_modules/embedded-client-module");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "embedded-client-module", version: "1.0.0", type: "module", exports: "./index.js" }));
  await writeFile(join(pkg, "index.js"), 'throw new Error("dependency must not execute"); export const value = "embedded";\n');
  const reports = await closure.verifyGstackBundledBuildImports(options);
  assert.deepEqual(reports.map(report => report.dependencyScope), ["native-build-imports", "node-browser-build-imports", "diagram-build-imports", "security-sidecar-build-imports"]);
  assert.deepEqual(reports.map(report => report.entrypoints.length), [6, 1, 1, 1]);
  assert.deepEqual(reports.map(report => report.compilationTarget), ["bun", "node", "browser", "node"]);
  for (const report of reports) {
    assert.equal(report.compiledArtifactBinding, "pending");
    assert.equal(report.releaseEligible, false);
    assert.ok(report.pendingGates.includes("compiled-output-input-binding"));
  }
  assert.ok(reports[0].inputs.some(input => input.path === "node_modules/embedded-client-module/index.js"));
  assert.ok(reports[2].inputs.some(input => input.path === "node_modules/embedded-client-module/index.js"));
  assert.ok(reports[1].externalSpecifiers.includes("playwright"));
  assert.ok(reports[3].inputs.some(input => input.path === "browse/src/security-classifier.ts"));
  assert.deepEqual(reports[3].externalSpecifiers, ["@huggingface/transformers"]);
  await assert.rejects(readFile(join(data.runtime, "browse/dist/browse")), { code: "ENOENT" });
  await rm(pkg, { recursive: true });
  await assert.rejects(closure.verifyGstackBundledBuildImports(options), /gstack_shared_command_build_failed/);
});

test("build import graphs reject unlisted or modified native sources instead of validating old generated binaries", { skip }, async t => {
  const data = await fixture(t);
  const options = await addSources(data, ["browse/src/cli.ts", "browse/src/find-browse.ts", "design/src/cli.ts",
    "make-pdf/src/cli.ts", "bin/gstack-global-discover.ts", "lib/cso/cli.ts"].map(path => [path, 'console.log("native");\n']));
  await writeFile(join(data.runtime, "browse/src/cli.ts"), 'console.log("mutate");\n');
  await assert.rejects(closure.verifyGstackBundledBuildImports(options), /gstack_shared_command_source_input_mismatch/);
});

test("client command imports do not require upstream paid-test files or Agent SDK", { skip }, async t => {
  const { runtime, options } = await fixture(t);
  await rm(join(runtime, "node_modules/@anthropic-ai/claude-agent-sdk"), { recursive: true });
  await rm(join(runtime, "test/skill-e2e-overlay.test.ts"));
  const report = await closure.verifyGstackClientCommandImports(options);
  assert.equal(report.dependencyScope, "client-command-imports");
  assert.equal(report.runtimeResourceSelection, "pending");
  assert.equal(report.dynamicPaidEntrypoints, 0);
  assert.deepEqual(report.unselectedSelfTestEntrypoints, ["test/skill-e2e-overlay.test.ts"]);
  assert.deepEqual(report.entrypoints, ["bin/gstack-model-benchmark", "scripts/ship-measure.ts", "bin/gstack-claude-code"]);
  assert.equal(report.inputs.some(input => input.path.includes("claude-agent-sdk")), false);
  assert.equal(report.releaseEligible, false);
  assert.ok(report.pendingGates.includes("complete-client-runtime-resource-selection"));
});

test("client command checks retain optional judge API imports and required test/helpers", { skip }, async t => {
  const { runtime, options } = await fixture(t);
  const report = await closure.verifyGstackClientCommandImports(options);
  assert.ok(report.inputs.some(input => input.path === "test/helpers/benchmark-runner.ts"));
  assert.ok(report.inputs.some(input => input.path === "test/helpers/benchmark-judge.ts"));
  assert.ok(report.inputs.some(input => input.path === "node_modules/@anthropic-ai/sdk/index.mjs"));
  await rm(join(runtime, "node_modules/@anthropic-ai/sdk"), { recursive: true });
  await assert.rejects(closure.verifyGstackClientCommandImports(options), /gstack_shared_command_build_failed/);
});

test("client imports cannot hide Agent SDK if a real selected command imports it", { skip }, async t => {
  const { root, runtime, manifest, options } = await fixture(t);
  const path = "runtime/test/helpers/benchmark-runner.ts";
  const text = 'import { query } from "@anthropic-ai/claude-agent-sdk"; export const value = query;\n';
  const data = JSON.parse(manifest);
  data.files[data.files.findIndex(file => file.path === path)] = { path, sizeBytes: Buffer.byteLength(text), checksum: hash(text) };
  const changed = Buffer.from(JSON.stringify(data));
  await writeFile(join(runtime, "test/helpers/benchmark-runner.ts"), text);
  await writeFile(join(root, "source-manifest.json"), changed);
  const selected = { ...options, expectedSourceManifestChecksum: hash(changed) };
  const report = await closure.verifyGstackClientCommandImports(selected);
  assert.ok(report.inputs.some(input => input.path === "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
  await rm(join(runtime, "node_modules/@anthropic-ai/claude-agent-sdk"), { recursive: true });
  await assert.rejects(closure.verifyGstackClientCommandImports(selected), /gstack_shared_command_build_failed/);
});

test("client commands still reject missing external-CLI entry and equal-length source changes", { skip }, async t => {
  const { runtime, options } = await fixture(t);
  const path = join(runtime, "bin/gstack-claude-code");
  const original = await readFile(path);
  await writeFile(path, original.toString("utf8").replace("external-claude-cli", "external-claude-api"));
  await assert.rejects(closure.verifyGstackClientCommandImports(options), /gstack_shared_command_source_input_mismatch/);
  await rm(path);
  await assert.rejects(closure.verifyGstackClientCommandImports(options), /gstack_shared_command_entry_missing/);
});

test("dynamic paid dispatcher and its exclusive imports are compiled without executing child commands", { skip }, async t => {
  const { options } = await fixture(t);
  const report = await verifyGstackSharedCommandClosure(options);
  assert.ok(report.entrypoints.includes("scripts/test-paid-shards.ts"));
  assert.ok(report.inputs.some(input => input.path === "node_modules/child-only-module/index.js"));
  assert.ok(report.inputs.some(input => input.path === "scripts/lib/paid-plan.ts"));
  assert.equal(report.dependencyScope, "upstream-validation");
  assert.equal(report.releaseEligible, false);
});

test("missing dynamic child or its otherwise-unreferenced dependency rejects instead of reporting a closed graph", { skip }, async t => {
  const { runtime, options } = await fixture(t);
  const child = join(runtime, "scripts/test-paid-shards.ts");
  const original = await readFile(child);
  await rm(child);
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_entry_missing:scripts\/test-paid-shards.ts/);
  await writeFile(child, original);
  await rm(join(runtime, "node_modules/child-only-module"), { recursive: true });
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_build_failed/);
});

test("reviewed shell and dynamic data inputs are retained and rechecked without running cloud or shell commands", { skip }, async t => {
  const { runtime, options } = await fixture(t);
  const report = await verifyGstackSharedCommandClosure(options);
  assert.equal(report.dynamicResources.length, 7);
  assert.ok(report.dynamicResources.some(input => input.path === "scripts/ubicloud/test-free.sh" && input.consumerPath === "scripts/ship-measure.ts"));
  assert.ok(report.dynamicResources.some(input => input.path === "scripts/paid-test-durations.json" && input.consumerPath === "scripts/lib/paid-plan.ts"));
  const shell = join(runtime, "scripts/ubicloud/ubi-runner.sh");
  const original = await readFile(shell);
  await rm(shell);
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_dynamic_resource_missing:scripts\/ubicloud\/ubi-runner.sh/);
  await writeFile(shell, Buffer.concat([original, Buffer.from("# changed\n")]));
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_source_input_mismatch:scripts\/ubicloud\/ubi-runner.sh/);
});

test("dynamic resources reject same-length changes and linked helpers even when their target bytes match", { skip }, async t => {
  const { runtime, options } = await fixture(t);
  const data = join(runtime, "scripts/paid-test-durations.json");
  const original = await readFile(data);
  await writeFile(data, original.toString("utf8").replace('"version":2', '"version":1'));
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_source_input_mismatch:scripts\/paid-test-durations.json/);
  await writeFile(data, original);
  const shell = join(runtime, "scripts/ubicloud/ubi-runner.sh");
  await rm(shell);
  await symlink(join(runtime, "scripts/ubicloud/test-free.sh"), shell);
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_file_invalid/);
});

test("compiler closure retains extensionless commands, imported test helpers and dynamically selected paid tests without executing them", { skip }, async t => {
  const { options } = await fixture(t);
  const report = await verifyGstackSharedCommandClosure(options);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.packageAcceptance, "pending");
  assert.deepEqual(report.entrypoints, ["bin/gstack-model-benchmark", "scripts/ship-measure.ts", "scripts/test-paid-shards.ts", "test/skill-e2e-overlay.test.ts"]);
  assert.equal(report.dynamicPaidEntrypoints, 1);
  assert.ok(report.inputs.some(input => input.path === "test/helpers/benchmark-runner.ts"));
  assert.ok(report.inputs.some(input => input.path === "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
});

test("missing helper and missing paid-test SDK both fail compilation rather than silently reducing the resource set", { skip }, async t => {
  const { runtime, options } = await fixture(t);
  const helper = join(runtime, "test/helpers/benchmark-runner.ts");
  const text = await readFile(helper);
  await rm(helper);
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_build_failed/);
  await writeFile(helper, text);
  await rm(join(runtime, "node_modules/@anthropic-ai/claude-agent-sdk"), { recursive: true });
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_build_failed/);
});

test("source manifest, paid-file removal, source changes and compiler tampering reject before publishing evidence", { skip }, async t => {
  const { root, runtime, manifest, options } = await fixture(t);
  await writeFile(join(root, "source-manifest.json"), Buffer.concat([manifest, Buffer.from(" ")]));
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_source_manifest_mismatch/);
  await writeFile(join(root, "source-manifest.json"), manifest);
  await assert.rejects(verifyGstackSharedCommandClosure({ ...options, expectedBunChecksum: `sha256:${"0".repeat(64)}` }), /gstack_shared_command_bun_mismatch/);
  const original = await readFile(join(runtime, "scripts/ship-measure.ts"));
  await writeFile(join(runtime, "scripts/ship-measure.ts"), 'export const command = "changed";\n');
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_source_input_mismatch/);
  await writeFile(join(runtime, "scripts/ship-measure.ts"), original);
  await rm(join(runtime, "test/skill-e2e-overlay.test.ts"));
  await assert.rejects(verifyGstackSharedCommandClosure(options), /gstack_shared_command_entry_missing/);
});

test("source manifests cannot introduce entrypoint path escapes or symlink roots", { skip }, async t => {
  const { root, manifest, options } = await fixture(t);
  const data = JSON.parse(manifest);
  data.files.push({ path: "runtime/../escape", sizeBytes: 1, checksum: hash("x") });
  const invalid = Buffer.from(JSON.stringify(data));
  await writeFile(join(root, "source-manifest.json"), invalid);
  await assert.rejects(verifyGstackSharedCommandClosure({ ...options, expectedSourceManifestChecksum: hash(invalid) }), /gstack_shared_command_source_path_invalid/);
  const link = join(root, "linked-runtime");
  await symlink(options.runtimeRoot, link, "dir");
  await assert.rejects(verifyGstackSharedCommandClosure({ ...options, runtimeRoot: link }), /gstack_shared_command_root_invalid/);
});
