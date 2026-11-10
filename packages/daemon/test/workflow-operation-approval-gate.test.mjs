import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createRunApprovalHandler } from "../dist/features/runs/approvals.js";
import { workflowOperationEffectRejection } from "../dist/features/runs/workflow-operation-effect-gate.js";
import { createTypedWorkflowBasis, gateOwner, typedOperation } from "./support/workflow-operation-gate-fixture.mjs";

test("an approval wait cannot authorize a file whose path became a symlink", async () => {
  const f = await fixture([typedOperation("file_create", "output.txt")]);
  try {
    await writeFile(join(f.cwd, "outside.txt"), "unchanged");
    const result = await f.approve({ toolName: "write", input: { path: "output.txt", content: "new" } }, async () => {
      await symlink("outside.txt", join(f.cwd, "output.txt"));
    });
    assert.equal(result.approved, false);
    assert.match(result.reason, /operation_binding_symlink_rejected/);
    assert.equal(await readFile(join(f.cwd, "outside.txt"), "utf8"), "unchanged");
    assert.equal(f.store.listApprovalRequests({ runId: f.run.id })[0].status, "approved", "User approval remains recorded; it does not widen scope");
  } finally { await f.close(); }
});

test("an approved typed create is not applied when step ownership changes during the wait", async () => {
  const f = await fixture([typedOperation("file_create", "output.txt")]);
  try {
    const result = await f.approve({ toolName: "write", input: { path: "output.txt", content: "new" } }, () => {
      f.store.updateChannelWorkflowStep(f.step.id, { runId: null }, new Date().toISOString());
    });
    assert.equal(result.approved, false);
    assert.match(result.reason, /operation_binding_owner_mismatch/);
    await assert.rejects(readFile(join(f.cwd, "output.txt")), /ENOENT/);
  } finally { await f.close(); }
});

test("unchanged typed native write passes approval without granting an extra tool or path", async () => {
  const f = await fixture([typedOperation("file_create", "output.txt")]);
  try {
    const result = await f.approve({ toolName: "write", input: { path: "output.txt", content: "new" } });
    assert.equal(result.approved, true);
    const denied = await f.handler({ toolCallId: "outside", toolName: "write", input: { path: "outside.txt", content: "new" }, task: f.task, cwd: f.cwd });
    assert.equal(denied.approved, false);
    assert.match(denied.reason, /operation_binding_path_out_of_scope/);
    assert.equal(f.store.listApprovalRequests({ runId: f.run.id }).length, 1);
  } finally { await f.close(); }
});

test("generated write requires successful read evidence from the immutable owner Run", async () => {
  const read = typedOperation("file_read", "input.txt", "read-input");
  const write = typedOperation("file_create", "output.txt", "create-output", [read.id]);
  write.binding.inputRefs = read.binding.inputRefs;
  write.binding.effectScope.readPaths = ["input.txt"];
  write.binding.contentSource.inputOperationIds = [read.id];
  const f = await fixture([read, write]);
  try {
    await writeFile(join(f.cwd, "input.txt"), "source");
    const request = { toolName: "write", input: { path: "output.txt", content: "derived" }, cwd: f.cwd };
    const gate = () => workflowOperationEffectRejection({ store: f.store, run: f.run, request });
    assert.equal(gate().code, "operation_binding_dependency_unverified");
    f.store.appendEvent(f.run.id, "tool_start", { toolCallId: "source-read", toolName: "read", args: { path: "input.txt" } });
    f.store.appendEvent(f.run.id, "tool_end", { toolCallId: "source-read", toolName: "read", isError: false, result: { content: [{ type: "text", text: "source" }] } });
    assert.equal(gate(), undefined);
    f.store.updateChannelWorkflowStep(f.step.id, { runId: null }, new Date().toISOString());
    assert.equal(gate().code, "operation_binding_owner_mismatch");
  } finally { await f.close(); }
});

test("typed file binding never overrides the existing permission policy", async () => {
  const f = await fixture([typedOperation("file_create", "output.txt")], { toolDecisions: { write: "deny", read: "allow" } });
  try {
    const result = await f.handler({ toolCallId: "policy-denied", toolName: "write", input: { path: "output.txt", content: "new" }, task: f.task, cwd: f.cwd });
    assert.equal(result.approved, false);
    assert.match(result.reason, /policy denied write/);
    await assert.rejects(readFile(join(f.cwd, "output.txt")), /ENOENT/);
  } finally { await f.close(); }
});

async function fixture(operations, policyOverrides = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-approval-gate-"));
  const store = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  const basis = createTypedWorkflowBasis(store, cwd, operations, now);
  const task = store.createTask({ channelId: basis.channel.id, title: "Bound effects", prompt: "Bound effects", assigneeTeammateId: gateOwner }, now);
  const createdRun = store.createRun({ id: "run-operation-gate", cwd, taskId: task.id, channelId: basis.channel.id,
    teammateId: gateOwner, workflowStepId: basis.step.id, providerName: "test", providerModel: "test",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: { cwd, delegatedRequirement: basis.requirement, workflowOperationExecution: basis.snapshot }, createdAt: now });
  store.markRunStarted(createdRun.id, now);
  const workUnit = store.createWorkUnit({ id: "work-unit-gate", workspaceId: "workspace_default", kind: "task_run", ownerType: "run", ownerId: createdRun.id, taskId: task.id,
    runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: "gate", createdByActor: "system", request: {}, linkedRunId: createdRun.id, now });
  const attempt = store.createWorkUnitAttempt({ id: "attempt-gate", workUnitId: workUnit.id, attemptNumber: 1, runtimeInstanceId: "runtime-gate", runnerId: "pi", effectiveRunnerId: "pi", now });
  store.linkRunToWorkUnit(createdRun.id, workUnit.id, now);
  store.updateChannelWorkflowStep(basis.step.id, { runId: createdRun.id, taskId: task.id }, now);
  const run = store.getRun(createdRun.id);
  let approvalCreated;
  const handler = createRunApprovalHandler({ store, run, workUnitId: workUnit.id, attemptId: attempt.id,
    delegatedRequirementFingerprint: basis.requirement.fingerprint,
    approvalPolicy: { toolDecisions: { write: "ask", read: "allow" }, allowedWritePaths: [cwd], ...policyOverrides },
    appendAndMaybeStream(type, data) {
      const event = store.appendEvent(run.id, type, data);
      if (type === "approval_requested") approvalCreated?.(data.approvalId);
      return event;
    },
    streamEnvelope() {},
  });
  return { cwd, store, run, task, step: basis.step, handler,
    async approve(request, beforeApproval = () => {}) {
      let resolveCreated;
      const created = new Promise((resolve) => { resolveCreated = resolve; });
      approvalCreated = resolveCreated;
      const pending = handler({ ...request, toolCallId: "approved-effect", task, cwd });
      const approvalId = await Promise.race([created, pending.then(() => { throw new Error("Expected durable approval wait"); })]);
      await beforeApproval();
      store.approveApprovalRequest(approvalId, { reason: "Approved within scope" }, new Date().toISOString());
      return pending;
    },
    async close() { store.close(); await rm(cwd, { recursive: true, force: true }); },
  };
}
