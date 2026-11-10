import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteRunStore, toRuntimeAttemptFence } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { hostCapabilityToolsV1 } from "@ling-stack/contracts";
import { capturePreparedRunnerInput } from "../../dist/features/runs/prepared-runner-input.js";
import { createRunApprovalHandler } from "../../dist/features/runs/approvals.js";

/** Real isolated SQLite and SDK preparation; callers may supply a loopback provider. */
export async function hostAuthorityFixture(t, configure = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-authority-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "Host authority fixture", boundPath: cwd }, now);
  let workflowStepId;
  if (configure.workflow) {
    const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Host authority", objective: "Open local artifact", status: "running", createdBy: "ling_agent" }, now);
    workflowStepId = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Open", prompt: "Open local artifact",
      toParticipantId: "host-agent", toParticipantLabel: "Host agent", status: "running" }, now).id;
  }
  const task = store.createTask({ channelId: channel.id, title: "Host authority", prompt: configure.prompt ?? "Open index.html" }, now);
  const options = { cwd, task, agentDir: join(cwd, "agent"), tools: [],
    hostCapabilityTools: configure.tools ?? [hostCapabilityToolsV1[0]],
    provider: configure.provider ?? { provider: "host-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1", api: "openai-completions", reasoning: false } };
  const prepared = capturePreparedRunnerInput({ runnerId: "pi", options,
    preparedInput: await new PiRunnerAdapter().prepareTaskInput(options) });
  configure.prepare?.(prepared);
  const unit = store.createWorkUnit({ id: "host-unit", workspaceId: "workspace_default", kind: "task_run", ownerType: "run", ownerId: "host-run",
    taskId: task.id, runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: "host-unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ id: "host-attempt", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "host-runtime", runnerId: "pi", effectiveRunnerId: "pi", status: "started", now });
  const created = store.createRun({ id: "host-run", cwd, workUnitId: unit.id, taskId: task.id, channelId: channel.id,
    teammateId: "host-agent", workflowStepId, providerName: "fixture", providerModel: "fixture", taskSnapshot: task,
    requestSnapshot: { cwd, runnerExecutionInput: configure.withoutPrepared ? undefined : prepared }, providerSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(created.id, unit.id, now);
  store.markRunStarted(created.id, now);
  const f = { cwd, store, task, unit, attempt, prepared, runnerOptions: options, run: store.getRun(created.id), workUnitId: unit.id, attemptId: attempt.id,
    sourceFence: toRuntimeAttemptFence(attempt), approvals: [], nextAttempt: 2 };
  f.request = { toolCallId: "host-call", toolName: "host_open_local_target", input: { path: "index.html" }, cwd, task, defaultApproval: "allow" };
  f.replace = () => {
    const other = createSqliteRunStore(cwd);
    try { return other.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: f.nextAttempt++, runtimeInstanceId: "new-runtime",
      runnerId: "pi", effectiveRunnerId: "pi", status: "started", now: new Date().toISOString() }); }
    finally { other.close(); }
  };
  f.handler = (overrides = {}) => createRunApprovalHandler({ store, run: f.run, workUnitId: unit.id, attemptId: attempt.id, sourceFence: f.sourceFence,
    approvalPolicy: { toolDecisions: { bash: "allow", read: "allow" }, allowedWritePaths: [cwd] },
    appendAndMaybeStream(type, data) {
      const event = store.appendEvent(created.id, type, data);
      if (type === "approval_requested") {
        const approval = store.getApprovalRequest(data.approvalId);
        f.approvals.push(approval);
        f.duringApproval?.(approval);
        if (approval.status === "pending") store.approveApprovalRequest(approval.id, { reason: "Fixture scoped approval only" }, new Date().toISOString());
      }
      return event;
    }, streamEnvelope() {}, ...overrides,
  });
  return f;
}
