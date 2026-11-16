import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { b013OwnedStore, b013ParticipantId } from "../../../core/test/support/b013-pre-gate-fixture.mjs";
import { PiRunnerAdapter } from "../../../runner-pi/dist/index.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";

export const readonlySafety = {
  sideEffectClass: "analysis_readonly",
  parallelPolicy: { autoParallel: true, maxParallelSiblings: 3 },
  requiredTools: ["read"],
};

export async function schedulerModule(name) {
  const base = process.env.LING_SCHEDULER_TEST_DIST
    ? pathToFileURL(`${resolve(process.env.LING_SCHEDULER_TEST_DIST)}/`)
    : new URL(process.env.LING_SCHEDULER_TEST_SOURCE ? "../../src/" : "../../dist/", import.meta.url);
  return import(new URL(`features/channels/${name}.js`, base));
}

export async function schedulerFixture(t, { cap = 3, workflowCap = cap } = {}) {
  const f = await b013OwnedStore(t);
  const now = new Date().toISOString();
  f.store.replaceTeammateChannelMemberships(b013ParticipantId, [{ channelId: f.channel.id }], now);
  f.runnerRegistry = createRunnerRegistry([{ id: "pi", displayName: "Scheduler Pi fixture", status: "enabled",
    adapter: new PiRunnerAdapter() }]);
  const provider = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Scheduler fixture",
    providerId: "scheduler-fixture", model: "fixture", api: "openai-responses", capabilities: ["chat", "tool_call"],
    input: ["text"], authHeader: false, enabled: true }, now);
  f.store.recordProviderCheckResult(provider.id, { ok: true, code: "static_check", message: "No transport", checkedAt: now });
  f.admission = { entries: [
    { resourceType: "provider", resourceKey: provider.id, limit: cap },
    { resourceType: "runner", resourceKey: "pi", limit: cap },
    { resourceType: "channel_parallel", resourceKey: f.channel.id, limit: cap },
  ], resourceKeys: [] };
  f.channel = f.store.updateChannel(f.channel.id, { defaultProviderPresetId: provider.id,
    runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: cap, allowReadOnlyParallel: true } }, now);
  f.workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Scheduler branches",
    objective: "Exercise explicit Host-verified scheduling without a model or a tool", status: "ready",
    createdBy: "local-user", metadata: { maxParallelSteps: workflowCap } }, now);
  f.step = (title, metadata = {}, fields = {}) => f.store.createChannelWorkflowStep({ workflowId: f.workflow.id,
    title, prompt: `Inspect ${title}`, toParticipantId: b013ParticipantId, toParticipantLabel: "Engineer",
    position: f.store.listChannelWorkflowSteps({ workflowId: f.workflow.id, complete: true }).length,
    ...fields, metadata: { ...structuredClone(readonlySafety), providerPresetId: provider.id, ...metadata } }, now);
  f.steps = () => f.store.listChannelWorkflowSteps({ workflowId: f.workflow.id, complete: true });
  // Synthetic Host evidence only. Production must validate its own frozen executor/scope.
  f.capability = ({ run }) => run && run.requestSnapshot.schedulerReadonlyVerified !== true
    ? undefined : { verified: true, resourceKeys: [], parallelLimit: cap };
  return f;
}

export function beginSchedulerStep(f, step) {
  const now = new Date().toISOString();
  const lease = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "workflow_step",
    resourceKey: step.id, ownerType: "workflow_step", ownerId: step.id, acquiredAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.ok(lease);
  const begun = f.store.beginChannelWorkflowStepStart({ workflowStepId: step.id,
    expected: f.store.getChannelWorkflowStep(step.id), leaseId: lease.id, now,
    admission: f.admission,
    task: { channelId: f.channel.id, title: step.title, prompt: step.prompt, assigneeTeammateId: step.toParticipantId } });
  assert.equal(begun.status, "begun", JSON.stringify(begun));
  return begun;
}

export function linkSchedulerRun(f, step, generation, request = {}, verified = true) {
  const now = new Date().toISOString();
  const task = f.store.getTask(generation.task.id);
  assert.equal(f.store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim", actor: "system", now }).ok, true);
  const run = f.store.createRun({ id: `scheduler_run_${task.id}`, cwd: f.cwd, taskId: task.id,
    channelId: f.channel.id, workflowStepId: step.id, teammateId: step.toParticipantId,
    providerName: "scheduler-fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {},
    requestSnapshot: { ...request, schedulerReadonlyVerified: verified }, createdAt: now });
  const unit = f.store.createWorkUnit({ id: `scheduler_unit_${task.id}`, workspaceId: f.channel.workspaceId,
    kind: "task_run", ownerType: "task", ownerId: task.id, taskId: task.id, channelId: f.channel.id,
    teammateId: step.toParticipantId, runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: `scheduler:${task.id}`,
    createdByActor: "system", request: {}, now });
  f.store.linkRunToWorkUnit(run.id, unit.id, now);
  const attempt = f.store.createWorkUnitAttempt({ id: `scheduler_attempt_${task.id}`, workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "scheduler-fixture", runnerId: "pi", effectiveRunnerId: "pi", now });
  const reserved = f.store.getChannelWorkflowStepStartAdmission(step.id, generation.owner);
  const committed = f.store.commitChannelWorkflowStepRunReady({ workflowStepId: step.id, owner: generation.owner, runId: run.id, now,
    ...(reserved ? { admission: { admission: reserved.plan, workUnitId: unit.id, attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() } } : {}) });
  assert.equal(committed.status, "linked", JSON.stringify(committed));
  return f.store.getRun(run.id);
}

export function schedulerInput(f, overrides = {}) {
  const steps = f.steps();
  return { store: f.store, channel: f.store.getChannel(f.channel.id), workflow: f.store.getChannelWorkflow(f.workflow.id),
    steps, eligibleSteps: steps.filter(step => step.status === "queued"), resolveParallelCapability: f.capability, ...overrides };
}
