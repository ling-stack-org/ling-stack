import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, resolveSessionRunPolicy, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { createTypedWorkflowBasis, typedOperation, gateOwner } from "./workflow-operation-gate-fixture.mjs";
import { executeUnifiedBashTool } from "../../dist/features/runs/unified-exec.js";
import { createRunApprovalHandler } from "../../dist/features/runs/approvals.js";
export async function createRestrictedCommandFixture(t, command, inputRefs = []) {
  const root = await mkdtemp(join(tmpdir(), "ling-restricted-dispatch-"));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString(), runId = "restricted_command_run";
  const operation = typedOperation("run_command", command);
  operation.binding.inputRefs = inputRefs;
  operation.binding.effectScope.readPaths = inputRefs.map(ref => ref.path);
  const basis = createTypedWorkflowBasis(store, cwd, [operation], now);
  const task = store.createTask({ channelId: basis.channel.id, title: "Restricted command", prompt: "Temporary isolated command fixture", assigneeTeammateId: gateOwner }, now);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: runId,
    idempotencyKey: runId, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "fixture-runtime", runnerId: "pi", status: "started", now });
  const effectivePolicySnapshot = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  store.createRun({ id: runId, cwd, taskId: task.id, workUnitId: unit.id, channelId: basis.channel.id, workflowStepId: basis.step.id,
    teammateId: gateOwner, providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {},
    requestSnapshot: { workflowOperationExecution: basis.snapshot, delegatedRequirement: basis.requirement, effectivePolicySnapshot }, createdAt: now });
  store.linkRunToWorkUnit(runId, unit.id, now); store.markRunStarted(runId, now);
  store.updateChannelWorkflowStep(basis.step.id, { taskId: task.id, runId }, now);
  const run = store.getRun(runId), sourceFence = toRuntimeAttemptFence(attempt);
  const request = { toolName: "bash", toolCallId: "restricted-call", cwd, task, input: { command, timeoutMs: 5000 } };
  const execute = (extra = {}) => executeUnifiedBashTool({ store, run, sourceFence, request,
    appendAndMaybeStream: (type, data) => store.appendEvent(runId, type, data), ...extra });
  const approve = async (restrictedCommandRuntime, beforeApproval = () => {}, extra = {}) => {
    let onCreated;
    const created = new Promise(resolve => { onCreated = resolve; });
    const handler = createRunApprovalHandler({ store, run, sourceFence, workUnitId: unit.id, attemptId: attempt.id,
      delegatedRequirementFingerprint: basis.requirement.fingerprint,
      executionOperationBindings: basis.snapshot.plan.operations, restrictedCommandRuntime,
      approvalPolicy: { ...store.getApprovalPolicy(), toolDecisions: effectivePolicySnapshot.toolDecisions },
      effectivePolicySnapshot, unifiedExecEnabled: true, streamEnvelope() {},
      appendAndMaybeStream(type, data) {
        const event = store.appendEvent(runId, type, data);
        if (type === "approval_requested") onCreated(data.approvalId);
        return event;
      }, ...extra });
    const pending = handler(request);
    const approvalId = await Promise.race([created, pending.then(result => { throw new Error("Expected approval: " + JSON.stringify(result)); })]);
    await beforeApproval(approvalId);
    store.approveApprovalRequest(approvalId, { reason: "Approved isolated fixture only" }, new Date().toISOString());
    return pending;
  };
  return { root, cwd, store, run, sourceFence, request, operation, execute, approve, basis };
}
