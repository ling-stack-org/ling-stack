import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { channelOperationPlanFingerprintV1 } from "@ling-stack/contracts";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";
import { verifyWorkflowStepExecutionOperations, workflowStepExecutionOperationBindings } from "../dist/features/channels/workflow-operation-evidence.js";
import { createDelegatedStepRequirement } from "../dist/features/channels/workflow-step-requirement.js";
import { createWorkflowOperationExecutionSnapshot } from "../dist/features/runs/workflow-operation-snapshot.js";

// Synthetic event-store regression fixtures only: no provider or tool is run.
async function fixture(t, runOwner = "teammate_builtin_engineer", includeSnapshot = true) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-bound-operation-evidence-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-09-06T00:00:00.000Z";
  const body = "Engineer 读取 input.txt，并将检查结果写入 report.md。";
  const channel = store.createChannel({ name: "Bound evidence fixture", boundPath: cwd }, now);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body }, now);
  const owner = { participantId: "teammate_builtin_engineer", sourceQuote: "Engineer" };
  const bound = bindChannelOperationPlan({ sourceItemId: source.id, sourceText: body, workspaceCwd: cwd,
    participants: [store.getAiTeammate(owner.participantId)], candidate: { schemaVersion: 2, operations: [
      { id: "read_input", kind: "file_read", targetKind: "file", required: true, dependsOn: [], owner, sourceQuote: body,
        target: { path: "input.txt", sourceQuote: "input.txt" } },
      { id: "write_report", kind: "file_create", targetKind: "file", required: true, dependsOn: ["read_input"], owner, sourceQuote: body,
        target: { path: "report.md", sourceQuote: "report.md" },
        contentSource: { kind: "generated_objective", text: "检查结果", sourceQuote: "检查结果", inputOperationIds: ["read_input"] } },
    ] } });
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Bound evidence", objective: body, status: "running", createdBy: "ling_agent" }, now);
  let step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Engineer review", prompt: body,
    toParticipantId: owner.participantId, toParticipantLabel: "Engineer", status: "running",
    metadata: { executionPlan: bound.execution, executionOperationIds: ["read_input", "write_report"] } }, now);
  const requirement = createDelegatedStepRequirement({ workflow, step,
    participant: { expectedOutcome: "execution" }, manifestFingerprint: "synthetic-manifest" });
  step = store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, delegatedRequirement: requirement } }, now);
  const snapshot = createWorkflowOperationExecutionSnapshot(step);
  const task = store.createTask({ channelId: channel.id, title: "Fixture", prompt: body, assigneeTeammateId: runOwner }, now);
  const run = store.createRun({ id: `run_${step.id}`, cwd, taskId: task.id, channelId: channel.id, workflowStepId: step.id,
    teammateId: runOwner, providerName: "static", providerModel: "static", taskSnapshot: { id: task.id, title: task.title },
    providerSnapshot: { provider: "static", model: "static" }, requestSnapshot: { cwd, ...(includeSnapshot ? {
      workflowOperationExecution: snapshot, delegatedRequirement: requirement,
    } : {}) }, createdAt: now });
  store.markRunStarted(run.id, now);
  store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId: run.id }, now);
  let sequence = 0;
  const emit = (toolName, path, isError = false, targetRunId = run.id) => {
    const toolCallId = `fixture_tool_${++sequence}`;
    store.appendEvent(targetRunId, "tool_start", { toolCallId, toolName,
      args: toolName === "bash" ? { command: `cat ${path}` } : { path, ...(toolName === "write" ? { content: "Synthetic review" } : {}) } });
    store.appendEvent(targetRunId, "tool_end", { toolCallId, toolName, isError });
  };
  return { store, channel, workflow, step, run, task, plan: bound.execution, now, emit,
    verify: () => verifyWorkflowStepExecutionOperations({ store, step: store.getChannelWorkflowStep(step.id), now }) };
}

test("bound file_read uses actual read evidence and generated output needs its own read dependencies", async (t) => {
  const f = await fixture(t);
  f.emit("read", "input.txt");
  f.emit("write", "report.md");
  const verification = f.verify();
  assert.equal(verification.status, "verified", JSON.stringify(verification));
  assert.deepEqual(verification.operationResults.map((result) => result.status), ["succeeded", "succeeded"]);
});

test("a bash action mentioning the same file cannot satisfy file_read", async (t) => {
  const f = await fixture(t);
  f.emit("bash", "input.txt");
  f.emit("write", "report.md");
  const verification = f.verify();
  assert.equal(verification.status, "blocked");
  assert.equal(verification.operationResults[0].reasonCode, "required_operation_missing_evidence");
});

test("bound evidence rejects another teammate's Run even when its file actions match", async (t) => {
  const f = await fixture(t, "teammate_builtin_qa");
  f.emit("read", "input.txt");
  f.emit("write", "report.md");
  const verification = f.verify();
  assert.equal(verification.status, "blocked");
  assert.ok(verification.operationResults.every((result) => result.reasonCode === "operation_binding_owner_mismatch"));
});

test("bound evidence rejects altered fingerprints before interpreting successful actions", async (t) => {
  const f = await fixture(t);
  f.emit("read", "input.txt");
  f.emit("write", "report.md");
  const altered = structuredClone(f.plan);
  altered.operations[1].binding.contentSource.text = "Changed after acceptance";
  f.store.updateChannelWorkflowStep(f.step.id, { metadata: { ...f.step.metadata, executionPlan: altered } }, f.now);
  const verification = f.verify();
  assert.equal(verification.status, "blocked");
  assert.ok(verification.operationResults.every((result) => ["operation_binding_fingerprint_invalid", "operation_binding_plan_missing"].includes(result.reasonCode)));
});

test("another step's same-owner same-path read does not replace this operation's dependency evidence", async (t) => {
  const f = await fixture(t);
  const otherStep = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Unrelated read", prompt: "Read", status: "running",
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer", metadata: { executionPlan: f.plan, executionOperationIds: [] } }, f.now);
  const otherRun = f.store.createRun({ id: `run_${otherStep.id}`, cwd: f.channel.boundPath, taskId: f.task.id, channelId: f.channel.id,
    workflowStepId: otherStep.id, teammateId: "teammate_builtin_engineer", providerName: "static", providerModel: "static",
    taskSnapshot: { id: f.task.id, title: "Fixture" }, providerSnapshot: { provider: "static", model: "static" }, requestSnapshot: {}, createdAt: f.now });
  f.store.markRunStarted(otherRun.id, f.now);
  f.store.updateChannelWorkflowStep(otherStep.id, { runId: otherRun.id, taskId: f.task.id }, f.now);
  f.emit("read", "input.txt", false, otherRun.id);
  f.emit("write", "report.md");
  const verification = f.verify();
  assert.equal(verification.status, "blocked");
  assert.equal(verification.operationResults[1].reasonCode, "required_operation_dependency_missing_evidence");
});

test("a failed read cannot satisfy generated-content dependencies", async (t) => {
  const f = await fixture(t);
  f.emit("read", "input.txt", true);
  f.emit("write", "report.md");
  const verification = f.verify();
  assert.equal(verification.status, "failed");
  assert.equal(verification.operationResults[0].status, "failed");
  assert.equal(verification.operationResults[1].status, "out_of_order");
});

test("typed successful actions cannot bypass a missing immutable Run snapshot", async (t) => {
  const f = await fixture(t, "teammate_builtin_engineer", false);
  f.emit("read", "input.txt");
  f.emit("write", "report.md");
  const verification = f.verify();
  assert.equal(verification.status, "blocked");
  assert.ok(verification.operationResults.every((result) => result.reasonCode === "operation_binding_snapshot_invalid"));
});

test("a declared dependency Run without its immutable snapshot cannot lend successful read evidence", async (t) => {
  const f = await fixture(t);
  const otherStep = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Unbound dependency", prompt: "Read", status: "running",
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer",
    metadata: { executionPlan: f.plan, executionOperationIds: ["read_input"] } }, f.now);
  const otherRun = f.store.createRun({ id: `run_${otherStep.id}`, cwd: f.channel.boundPath, taskId: f.task.id, channelId: f.channel.id,
    workflowStepId: otherStep.id, teammateId: "teammate_builtin_engineer", providerName: "static", providerModel: "static",
    taskSnapshot: { id: f.task.id, title: "Fixture" }, providerSnapshot: { provider: "static", model: "static" }, requestSnapshot: {}, createdAt: f.now });
  f.store.markRunStarted(otherRun.id, f.now);
  f.store.updateChannelWorkflowStep(otherStep.id, { runId: otherRun.id, taskId: f.task.id }, f.now);
  f.emit("read", "input.txt", false, otherRun.id);
  f.emit("write", "report.md");
  const verification = f.verify();
  assert.equal(verification.operationResults[1].status, "out_of_order");
  assert.equal(verification.operationResults[1].reasonCode, "required_operation_dependency_missing_evidence");
});

test("typed binding projection never grants all operations when the owned IDs are absent", async (t) => {
  const f = await fixture(t);
  const step = { ...f.step, metadata: { ...f.step.metadata, executionOperationIds: undefined } };
  assert.deepEqual(workflowStepExecutionOperationBindings(step), []);
});

test("a stripped step argument cannot downgrade its persisted typed owner to generic evidence", async (t) => {
  const f = await fixture(t);
  f.emit("read", "input.txt");
  f.emit("write", "report.md");
  const verification = verifyWorkflowStepExecutionOperations({ store: f.store,
    step: { ...f.store.getChannelWorkflowStep(f.step.id), metadata: undefined }, now: f.now });
  assert.equal(verification?.status, "blocked");
});

test("a rehashed step argument cannot replace its Run snapshot's accepted plan", async (t) => {
  const f = await fixture(t);
  f.emit("read", "input.txt");
  f.emit("write", "report.md");
  const plan = structuredClone(f.plan);
  plan.operations[1].binding.contentSource.text = "Different review objective";
  plan.fingerprint = channelOperationPlanFingerprintV1(plan.operations);
  const step = { ...f.store.getChannelWorkflowStep(f.step.id), metadata: { ...f.step.metadata, executionPlan: plan } };
  const verification = verifyWorkflowStepExecutionOperations({ store: f.store, step, now: f.now });
  assert.equal(verification.status, "blocked");
  assert.ok(verification.operationResults.every((result) => result.reasonCode === "operation_binding_fingerprint_mismatch"));
});
