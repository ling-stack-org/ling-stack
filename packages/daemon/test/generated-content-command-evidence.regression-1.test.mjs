import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { channelOperationPlanFingerprintV1, isChannelIntentExecutionPlanV1, isChannelOperationBindingV1 } from "@ling-stack/contracts";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";
import { verifyWorkflowStepExecutionOperations } from "../dist/features/channels/workflow-operation-evidence.js";
import { workflowOperationEffectRejection } from "../dist/features/runs/workflow-operation-effect-gate.js";
import { createTypedWorkflowBasis, gateOwner, typedOperation } from "./support/workflow-operation-gate-fixture.mjs";

// C01-R9 exposed this field's read-only contract. These synthetic plans probe
// read -> command -> generated report; the unpersisted live candidate is unknown.
// No model, real command or QA project is used, and no production DB is opened.
const command = "node --test checks.test.js";
const body = "Engineer 读取 input.txt；在目录 project 运行 node --test checks.test.js，输入 project/checks.test.js；依据读取与测试结果生成审计报告 report.md。QA 读取 other.txt。";
const refs = [{ itemId: "source", quote: body }];
const directory = { path: "project", sourceRefs: [{ itemId: "source", quote: "目录 project", actorType: "local_user" }] };

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-generated-command-evidence-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "project"));
  await writeFile(join(cwd, "input.txt"), "Synthetic input");
  const owner = { participantId: gateOwner, sourceQuote: "Engineer" };
  const candidate = { schemaVersion: 2, operations: [
    { id: "read", kind: "file_read", targetKind: "file", required: true, dependsOn: [], owner, sourceQuote: body,
      target: { path: "input.txt", sourceQuote: "input.txt" } },
    { id: "test", kind: "run_command", targetKind: "command", required: true, dependsOn: ["read"], owner, sourceQuote: body,
      command: { text: command, sourceQuote: command }, workingDirectory: { path: "project", sourceQuote: "目录 project" },
      inputs: [{ path: "project/checks.test.js", sourceQuote: "project/checks.test.js" }] },
    { id: "report", kind: "file_create", targetKind: "file", required: true, dependsOn: ["read", "test"], owner, sourceQuote: body,
      target: { path: "report.md", sourceQuote: "report.md" },
      contentSource: { kind: "generated_objective", text: "读取与测试结果生成审计报告", sourceQuote: "读取与测试结果生成审计报告",
        inputOperationIds: ["read", "test"] } },
  ] };
  const bind = () => bindChannelOperationPlan({ candidate, sourceItemId: "source", sourceText: body, workspaceCwd: cwd,
    participants: [
      { id: gateOwner, displayName: "Engineer", roleKey: "engineer", allowedTools: ["read", "write", "edit", "bash"] },
      { id: "teammate_builtin_qa", displayName: "QA", roleKey: "qa", allowedTools: ["read", "write", "bash"] },
    ] });
  return { cwd, candidate, bind };
}

function manualOperations() {
  const read = typedOperation("file_read", "input.txt", "read");
  const run = typedOperation("run_command", command, "test", ["read"]);
  run.binding.sourceRefs = refs;
  run.binding.workingDirectory = directory;
  run.binding.inputRefs = [{ path: "project/checks.test.js", sourceRefs: refs }];
  run.binding.effectScope.readPaths = ["project/checks.test.js"];
  const report = typedOperation("file_create", "report.md", "report", ["read", "test"]);
  report.binding.inputRefs = [{ path: "input.txt", sourceRefs: refs }];
  report.binding.effectScope.readPaths = ["input.txt"];
  report.binding.contentSource.inputOperationIds = ["read", "test"];
  return [read, run, report];
}
const plan = operations => ({ bindingVersion: 1, operations, fingerprint: channelOperationPlanFingerprintV1(operations) });

test("binder accepts same-owner command evidence without turning its inputs into report read permissions", async t => {
  const f = await fixture(t);
  const bound = f.bind();
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  assert.equal(isChannelIntentExecutionPlanV1(bound.execution), true);
  const report = bound.execution.operations[2].binding;
  assert.deepEqual(report.contentSource.inputOperationIds, ["read", "test"]);
  assert.deepEqual(report.inputRefs.map(ref => ref.path), ["input.txt"]);
  assert.deepEqual(report.effectScope.readPaths, ["input.txt"]);
  assert.deepEqual(report.effectScope.exactCommands, []);
  assert.equal(report.workingDirectory, undefined);
  assert.equal(report.commandInputScope, undefined);
});

test("a command-only report has no inferred file read or command authority", async t => {
  const f = await fixture(t);
  f.candidate.operations[2].contentSource.inputOperationIds = ["test"];
  const bound = f.bind();
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  assert.deepEqual(bound.execution.operations[2].binding.inputRefs, []);
  assert.deepEqual(bound.execution.operations[2].binding.effectScope.readPaths, []);
});

test("binder rejects cross-owner, missing, undeclared, cyclic and write-operation content inputs", async t => {
  for (const mutate of [
    f => { f.candidate.operations[1].owner = { participantId: "teammate_builtin_qa", sourceQuote: "QA" }; },
    f => { f.candidate.operations[2].dependsOn = ["read"]; },
    f => { f.candidate.operations[2].contentSource.inputOperationIds = ["unknown"]; },
    f => { f.candidate.operations[1].dependsOn.push("report"); },
    f => { f.candidate.operations[2].contentSource.inputOperationIds = ["report"]; },
  ]) {
    const f = await fixture(t); mutate(f);
    assert.equal(f.bind().status, "clarify", String(mutate));
  }
});

test("durable validator accepts command dependencies while deriving file scope only from reads", () => {
  assert.ok(manualOperations().every(operation => isChannelOperationBindingV1(operation.binding)), "individual bindings are valid before testing graph semantics");
  assert.equal(isChannelIntentExecutionPlanV1(plan(manualOperations())), true);
  for (const mutate of [
    ops => { ops[1].binding.ownerParticipantId = "teammate_builtin_qa"; },
    ops => { ops[2].dependsOn = ["read"]; },
    ops => { ops[2].binding.contentSource.inputOperationIds.push("unknown"); },
    ops => { ops[2].binding.effectScope.readPaths.push("project/checks.test.js"); },
    ops => { ops[1].dependsOn.push("report"); },
    ops => { ops[2].binding.contentSource.inputOperationIds = ["report"]; },
  ]) {
    const ops = manualOperations(); mutate(ops);
    assert.equal(isChannelIntentExecutionPlanV1(plan(ops)), false, String(mutate));
  }
});

test("a different write operation cannot become generated-content evidence", async t => {
  const f = await fixture(t);
  f.candidate.operations.push({ id: "other", kind: "file_create", targetKind: "file", required: true, dependsOn: [],
    owner: f.candidate.operations[0].owner, sourceQuote: body, target: { path: "other.txt", sourceQuote: "other.txt" },
    contentSource: { kind: "literal", text: "审计", sourceQuote: "审计" } });
  f.candidate.operations[2].dependsOn = ["other"];
  f.candidate.operations[2].contentSource.inputOperationIds = ["other"];
  assert.deepEqual(f.bind().missingFields, ["contentSource.inputOperationIds"]);
  const ops = manualOperations();
  ops.push(typedOperation("file_create", "other.txt", "other"));
  ops[2].dependsOn = ["other"];
  ops[2].binding.contentSource.inputOperationIds = ["other"];
  ops[2].binding.inputRefs = [];
  ops[2].binding.effectScope.readPaths = [];
  assert.equal(isChannelIntentExecutionPlanV1(plan(ops)), false);
});

test("generated edits keep only their target read and explicit read dependencies", () => {
  const ops = manualOperations();
  ops[2].kind = "file_edit";
  ops[2].binding.inputRefs.unshift({ path: "report.md", sourceRefs: refs });
  ops[2].binding.effectScope.readPaths.unshift("report.md");
  assert.equal(isChannelIntentExecutionPlanV1(plan(ops)), true);
  ops[2].binding.inputRefs.push({ path: "project/checks.test.js", sourceRefs: refs });
  ops[2].binding.effectScope.readPaths.push("project/checks.test.js");
  assert.equal(isChannelIntentExecutionPlanV1(plan(ops)), false, "rehashing cannot import the command's staged input scope");
});

async function evidenceFixture(t) {
  const f = await fixture(t);
  const store = createSqliteRunStore(f.cwd);
  t.after(() => store.close());
  const now = "2026-10-25T09:00:00.000Z";
  const basis = createTypedWorkflowBasis(store, f.cwd, manualOperations(), now);
  const task = store.createTask({ channelId: basis.channel.id, title: "Synthetic evidence", prompt: body, assigneeTeammateId: gateOwner }, now);
  const run = store.createRun({ id: `run_${basis.step.id}`, cwd: f.cwd, taskId: task.id, channelId: basis.channel.id,
    workflowStepId: basis.step.id, teammateId: gateOwner, providerName: "synthetic", providerModel: "synthetic",
    taskSnapshot: { id: task.id, title: task.title }, providerSnapshot: {}, requestSnapshot: {
      workflowOperationExecution: basis.snapshot, delegatedRequirement: basis.requirement,
    }, createdAt: now });
  store.markRunStarted(run.id, now);
  store.updateChannelWorkflowStep(basis.step.id, { taskId: task.id, runId: run.id }, now);
  let sequence = 0;
  const emit = (name, args, result, isError = false, targetRunId = run.id) => {
    const toolCallId = `synthetic_${++sequence}`;
    const stamp = new Date(Date.parse(now) + sequence * 1000).toISOString();
    store.appendEvent(targetRunId, "tool_start", { toolCallId, toolName: name,
      args: name === "bash" ? { cwd: join(f.cwd, "project"), ...args } : args }, stamp);
    store.appendEvent(targetRunId, "tool_end", { toolCallId, toolName: name, isError, ...(result ? { result } : {}) }, stamp);
  };
  const commandResult = (overrides = {}) => {
    const stream = { byteCount: 0, lineCount: 0, preview: "", truncated: false };
    return { details: { unifiedExec: { status: "succeeded", command: { kind: "shell", command, shell: "bash" },
      cwd: join(f.cwd, "project"), startedAt: now, endedAt: now, durationMs: 0, exitCode: 0,
      timedOut: false, cancelled: false, stdout: stream, stderr: stream, artifacts: [], ...overrides } } };
  };
  const gate = () => workflowOperationEffectRejection({ store, run: store.getRun(run.id),
    request: { toolName: "write", input: { path: "report.md", content: "Synthetic report, not a real test result" }, cwd: f.cwd } });
  const verify = () => verifyWorkflowStepExecutionOperations({ store, step: store.getChannelWorkflowStep(basis.step.id), now });
  return { ...f, store, basis, task, run, now, emit, commandResult, gate, verify };
}

test("report write remains blocked until exact command evidence exists in its immutable owning Run", async t => {
  const f = await evidenceFixture(t);
  f.emit("read", { path: "input.txt" });
  assert.equal(f.gate()?.code, "operation_binding_dependency_unverified");
  f.emit("bash", { command }, f.commandResult());
  assert.equal(f.gate(), undefined);
  assert.equal(workflowOperationEffectRejection({ store: f.store, run: f.store.getRun(f.run.id),
    request: { toolName: "read", input: { path: "project/checks.test.js" }, cwd: f.cwd } })?.code,
  "operation_binding_path_out_of_scope", "staged command inputs are not standalone read operations");
  f.emit("write", { path: "report.md", content: "Synthetic report" });
  const verified = f.verify();
  assert.equal(verified.status, "verified", JSON.stringify(verified));
  assert.deepEqual(verified.operationResults.map(result => result.status), ["succeeded", "succeeded", "succeeded"]);
});

for (const [name, overrides, isError, omitResult] of [
  ["nonzero", { status: "failed", exitCode: 1 }, true, false],
  ["cancelled", { status: "cancelled", cancelled: true }, true, false],
  ["timeout", { status: "timed_out", timedOut: true }, true, false],
  ["signal", { status: "failed", signal: "SIGTERM" }, true, false],
  ["missing-exit", { exitCode: undefined }, false, false],
  ["incomplete-structured-result", { stdout: undefined }, false, false],
  ["wrong-cwd", { cwd: tmpdir() }, false, false],
  ["wrong-command", { command: { kind: "shell", command: "node other.js", shell: "bash" } }, false, false],
  ["narration-only", {}, false, true],
]) {
  test(`report cannot consume ${name} command evidence at tool admission or fan-in`, async t => {
    const f = await evidenceFixture(t);
    f.emit("read", { path: "input.txt" });
    f.emit("bash", { command }, omitResult ? { content: [{ type: "text", text: "I ran the test successfully" }] } : f.commandResult(overrides), isError);
    assert.equal(f.gate()?.code, "operation_binding_dependency_unverified");
    f.emit("write", { path: "report.md", content: "Synthetic report" });
    const verified = f.verify();
    assert.notEqual(verified.status, "verified", JSON.stringify(verified));
    assert.equal(verified.operationResults[2].status, "out_of_order");
  });
}

test("another same-owner Run cannot supply the report's command evidence", async t => {
  const f = await evidenceFixture(t);
  const other = f.store.createRun({ id: "other_run", cwd: f.cwd, taskId: f.task.id, channelId: f.basis.channel.id,
    teammateId: gateOwner, providerName: "synthetic", providerModel: "synthetic", taskSnapshot: { id: f.task.id, title: "Other" },
    providerSnapshot: {}, requestSnapshot: {}, createdAt: f.now });
  f.store.markRunStarted(other.id, f.now);
  f.emit("read", { path: "input.txt" });
  f.emit("bash", { command }, f.commandResult(), false, other.id);
  assert.equal(f.gate()?.code, "operation_binding_dependency_unverified");
  f.emit("write", { path: "report.md", content: "Synthetic report" });
  assert.equal(f.verify().operationResults[2].status, "out_of_order");
});

test("report created before command completion stays out of order even after later success", async t => {
  const f = await evidenceFixture(t);
  f.emit("read", { path: "input.txt" });
  f.emit("write", { path: "report.md", content: "Premature synthetic report" });
  f.emit("bash", { command }, f.commandResult());
  const verified = f.verify();
  assert.equal(verified.status, "blocked", JSON.stringify(verified));
  assert.equal(verified.operationResults[2].reasonCode, "required_operation_out_of_order");
});
