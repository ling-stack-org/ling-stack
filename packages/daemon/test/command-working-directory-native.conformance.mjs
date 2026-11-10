// Explicit macOS conformance: uses current dist with the real, codesign-verified
// QA package's native helper and Electron Node resources, not a new GUI package.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { nodeFunctionGoalCommand } from "@ling-stack/contracts";
import { readPackagedRestrictedCommandConfig } from "../dist/runtime/sandbox/packaged-restricted-command-bootstrap.js";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";
import { createRestrictedCommandFixture } from "./support/restricted-command-fixture.mjs";

assert.equal(process.platform, "darwin", "run this explicit conformance suite on macOS");
const executable = resolve(dirname(fileURLToPath(import.meta.url)),
  "../../../apps/desktop/release/human-qa/mac-arm64/Ling Stack Human QA.app/Contents/MacOS/Ling Stack Human QA");
// No verifyBundle override: the production bootstrap performs actual codesign verification.
const config = readPackagedRestrictedCommandConfig({ executablePath: executable,
  environment: { LING_STACK_PACKAGED_DESKTOP: "1", ELECTRON_RUN_AS_NODE: "1" } });
assert.ok(config);
const runtime = new NativeRestrictedCommandRuntime(config);
const refs = path => ({ path, sourceRefs: [{ itemId: "source", quote: `Read ${path}`, actorType: "local_user" }] });
const directory = { path: "project", sourceRefs: [{ itemId: "source", quote: "在目录 project 中运行", actorType: "local_user" }] };
const script = "console.log(require('node:fs').readFileSync(process.argv[2], 'utf8').trim());";
async function fixture(t, inputs = ["project/cli.js", "records.csv"]) {
  const f = await createRestrictedCommandFixture(t, "node cli.js ../records.csv", inputs.map(refs), undefined, directory);
  await mkdir(join(f.cwd, "project"));
  await writeFile(join(f.cwd, "project/cli.js"), script);
  await writeFile(join(f.cwd, "records.csv"), "authorized-parent-data\n");
  return f;
}
function preparation(f, assertCurrentAuthority = () => {}) {
  return { command: f.request.input.command, cwd: f.cwd, workingDirectory: directory,
    inputRefs: f.operation.binding.inputRefs, policy: f.run.requestSnapshot.effectivePolicySnapshot,
    source: { ...f.sourceFence, workspaceId: f.store.getApprovalPolicy().workspaceId, runId: f.run.id,
      toolCallId: f.request.toolCallId }, assertCurrentAuthority };
}

test("real approval, native sandbox and durable journal agree on command cwd without changing Run root", async t => {
  const f = await fixture(t);
  let approvalId;
  const response = await f.approve(runtime, id => {
    approvalId = id;
    const approval = f.store.getApprovalRequest(id);
    assert.equal(approval.payload.cwd, join(f.cwd, "project"));
    assert.equal(approval.payload.command, f.request.input.command);
    assert.equal(approval.proposedCommandRule, undefined,
      "arbitrary node scripts do not acquire a reusable command prefix");
    const restored = createSqliteRunStore(f.cwd);
    try {
      assert.deepEqual(restored.getApprovalRequest(id).payload, approval.payload);
      assert.equal(restored.getRun(f.run.id).cwd, f.cwd);
    } finally { restored.close(); }
  });
  assert.equal(response.approved, true, JSON.stringify(response));
  const result = response.handledResult.details.unifiedExec;
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.preview, "authorized-parent-data\n");
  assert.equal(result.command.command, "node cli.js ../records.csv");
  assert.equal(result.cwd, join(f.cwd, "project"));
  assert.equal(result.isolation.originalCwd, result.cwd);
  assert.ok(result.isolation.executionCwd.endsWith("/workspace/project"));
  assert.equal(result.environmentSummary.cwd, result.isolation.executionCwd);
  assert.deepEqual(result.isolation.inputs.map(row => row.path).sort(), ["project/cli.js", "records.csv"]);
  assert.equal(f.store.getRun(f.run.id).cwd, f.cwd);
  const events = f.store.listEvents(f.run.id);
  const prepared = events.filter(event => event.type === "host_command_prepared");
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].data.cwd, realpathSync(result.cwd), "the journal records the canonical original directory");
  assert.equal(events.filter(event => event.type === "host_command_settled").length, 1);
  assert.equal(f.store.getApprovalCheckpointForApproval(approvalId).sideEffect.cwd, result.cwd);
  assert.deepEqual(f.store.listHostCommandWriteBlockers(f.cwd), []);
  await assert.rejects(readFile(join(f.cwd, "project", "records.csv")), { code: "ENOENT" });
});

test("real sandbox does not capture an unauthorized parent input even when the original file exists", async t => {
  const f = await fixture(t, ["project/cli.js"]);
  await writeFile(join(f.cwd, "records.csv"), "PRIVATE-PARENT-MARKER");
  const response = await f.approve(runtime);
  assert.equal(response.approved, true);
  const result = response.handledResult.details.unifiedExec;
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.stdout.preview + result.stderr.preview, /PRIVATE-PARENT-MARKER/);
  assert.deepEqual(result.isolation.inputs.map(row => row.path), ["project/cli.js"]);
  assert.equal(await readFile(join(f.cwd, "records.csv"), "utf8"), "PRIVATE-PARENT-MARKER");
});

test("replacing the original directory after real preparation prevents native spawn", async t => {
  const f = await fixture(t);
  const prepared = await runtime.prepare(preparation(f));
  try {
    renameSync(join(f.cwd, "project"), join(f.cwd, "previous-project"));
    mkdirSync(join(f.cwd, "project"));
    writeFileSync(join(f.cwd, "project/cli.js"), script);
    assert.throws(() => prepared.spawn(), /restricted_command_directory_changed/);
  } finally { prepared.dispose(); }
});

test("a forced directory replacement across the asynchronous input capture boundary is rejected", async t => {
  const f = await fixture(t);
  let injected = false;
  await assert.rejects(runtime.prepare(preparation(f, () => {
    if (!injected) {
      injected = true;
      queueMicrotask(() => {
        renameSync(join(f.cwd, "project"), join(f.cwd, "previous-project"));
        mkdirSync(join(f.cwd, "project"));
        writeFileSync(join(f.cwd, "project/cli.js"), script);
      });
    }
  })), /restricted_command_directory_changed/);
  assert.equal(injected, true);
});

test("Host-generated function goals import relative to the selected cwd in the real sandbox", async t => {
  const command = nodeFunctionGoalCommand({ modulePath: "project/proof.mjs", invocation: 'proof("7319")' }, "project");
  assert.ok(command.includes('import("./proof.mjs")'));
  const f = await createRestrictedCommandFixture(t, command, [refs("project/proof.mjs")], undefined, directory);
  await mkdir(join(f.cwd, "project"));
  await writeFile(join(f.cwd, "project/proof.mjs"), 'export const proof = value => "proof:" + value;');
  const response = await f.approve(runtime);
  assert.equal(response.approved, true);
  const result = response.handledResult.details.unifiedExec;
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.stdout.preview, "proof:7319\n");
  assert.equal(result.cwd, join(f.cwd, "project"));
  assert.deepEqual(result.isolation.inputs.map(ref => ref.path), ["project/proof.mjs"]);
});
