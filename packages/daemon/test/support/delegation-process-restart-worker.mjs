import assert from "node:assert/strict";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_ID,
  SqliteRunStore,
  applyConversationModeToEffectiveRunPolicySnapshot,
  resolveSessionRunPolicy,
  resolveStoragePaths,
  toRuntimeAttemptFence,
} from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { resolveConfig } from "../../dist/config.js";
import { createOriginalDelegationStoreComposition, admitOriginalDelegationRoot } from "../../dist/features/harness/delegations/store-composition.js";
import { createDelegatedRunDispatchAuthority } from "../../dist/features/harness/delegations/delegated-run-dispatch.js";
import {
  assertDelegationRecoveryParentCurrent,
  createDelegationRuntimeRegistry,
  createDelegationWorkflowSelector,
} from "../../dist/features/harness/delegations/runtime-registry.js";
import { createHarnessFeatureSnapshot } from "../../dist/features/harness/index.js";
import { resolveProviderForRun } from "../../dist/features/runs/providers.js";
import { ActiveRunRegistry } from "../../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../../dist/runtime/runner-settings.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";

const phase = process.argv[2];
const cwd = process.argv[3];
const seed = process.argv[4] ? JSON.parse(process.argv[4]) : undefined;
if (!process.send || !cwd || !["seed", "recover"].includes(phase)) {
  throw new Error("delegation process restart worker requires phase, cwd and IPC");
}

const at = () => new Date().toISOString();
const keyRef = "env:ISOLATED_DELEGATION_PROCESS_RESTART_KEY";
const resolver = {
  status: ref => ({ ref, kind: "env", configured: ref === keyRef }),
  resolve: ref => ({
    ref,
    configured: ref === keyRef,
    value: ref === keyRef ? "synthetic-no-network-key" : undefined,
    status: { ref, kind: "env", configured: ref === keyRef },
  }),
};

const config = resolveConfig({
  defaultWorkspaceCwd: cwd,
  harness: {
    continuations: { mode: "enforce" },
    toolBroker: { mode: "enforce" },
    delegations: { mode: "enforce", rootBudget: { tokenBudget: 100_000, wallTimeBudgetMs: 120_000 } },
  },
});
const supervisor = new RuntimeSupervisor(config);
const activeRuns = new ActiveRunRegistry();
const runners = createRunnerRegistry([{
  id: "pi",
  displayName: "Process restart fixture",
  status: "enabled",
  adapter: new PiRunnerAdapter(),
}]);
const composition = createOriginalDelegationStoreComposition({
  supervisor,
  runnerRegistry: runners,
  secretResolver: resolver,
  delegatedDispatchAuthority: createDelegatedRunDispatchAuthority(),
});
const paths = resolveStoragePaths(cwd, {
  homeDir: join(cwd, "fixture-home"),
  env: {},
  workspaceStateLocation: "repo-local",
}).workspace;
const store = new SqliteRunStore({ cwd, paths, delegationHostBinding: composition.binding });
composition.bindExactStore(store);

const send = message => new Promise((resolve, reject) => {
  process.send(message, error => error ? reject(error) : resolve());
});

async function seedRestart() {
  const now = at();
  const runtime = supervisor.getRuntime(cwd, store);
  patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] }, now);
  const preset = store.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Process restart fixture",
    providerId: "delegation-process-restart",
    model: "fixture-model",
    api: "openai-completions",
    baseUrl: "https://delegation.invalid/v1",
    apiKeyRef: keyRef,
    contextWindow: 1_000,
    maxTokens: 100,
    capabilities: ["chat"],
    enabled: true,
  }, now);
  const provider = resolveProviderForRun(store, { providerPresetId: preset.id, skipProviderPreflight: true }, resolver);
  const channel = store.createChannel({ name: "Process restart", boundPath: cwd, allowedTools: ["read"] }, now);
  const task = store.createTask({ channelId: channel.id, title: "Parent", prompt: "Parent frozen task." }, now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Selected process workflow",
    objective: task.prompt, createdBy: "local-user", status: "running" }, now);
  const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Parent execution", prompt: task.prompt,
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer", status: "running" }, now);
  const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id,
    title: task.title, objective: task.prompt }, now);
  const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", taskId: task.id,
    channelId: channel.id, title: task.title, userInstruction: task.prompt, createdByActor: "local-user" }, now);
  const taskSnapshot = { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt };
  const request = { cwd, workspaceCwd: cwd, providerPresetId: preset.id, task: taskSnapshot,
    threadId: thread.id, turnId: turn.id, workflowStepId: step.id, runnerId: "pi", tools: ["read"],
    authorizationMode: "smart", workspaceAccessMode: "workspace_write",
    harnessFeatureSnapshot: createHarnessFeatureSnapshot({ harness: supervisor.getHarnessFeatures() }) };
  const unit = store.createWorkUnit({ id: "process-root-unit", workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "conversation_run", ownerType: "run", ownerId: "process-root", status: "claimed",
    channelId: channel.id, taskId: task.id, runnerId: "pi", effectiveRunnerId: "pi",
    idempotencyKey: "process-root", createdByActor: "system", request, now });
  const attempt = store.createWorkUnitAttempt({ id: "process-root-attempt", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", effectiveRunnerId: "pi", now });
  const run = store.createRun({ id: "process-root", cwd, taskId: task.id, channelId: channel.id,
    workflowStepId: step.id, workUnitId: unit.id, threadId: thread.id, turnId: turn.id,
    providerPresetId: preset.id, providerName: provider.provider, providerModel: provider.model,
    taskSnapshot, providerSnapshot: {}, requestSnapshot: request, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.updateChannelWorkflowStep(step.id, { runId: run.id, taskId: task.id }, now);
  const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({
    workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
    channelBoundPath: cwd,
  }).snapshot, thread.conversationMode.mode);
  admitOriginalDelegationRoot({ store, run: store.getRun(run.id), attempt: store.getWorkUnitAttempt(attempt.id),
    originalProvider: provider, request, effectivePolicySnapshot: policy, runtimeTools: ["read"], now });
  store.database.prepare("UPDATE run_sessions SET status='running',started_at=? WHERE id=?").run(now, run.id);
  store.database.prepare("UPDATE work_units SET status='running',started_at=? WHERE id=?").run(now, unit.id);
  store.database.prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id=?").run(now, attempt.id);
  const sourceFence = toRuntimeAttemptFence(store.getWorkUnitAttempt(attempt.id));
  const queued = composition.lifecycle.spawn({
    parentRunId: run.id,
    sourceFence,
    spawnCallId: "process-restart-queued",
    objective: "Read the isolated child objective.",
    requestedBudget: { tokenBudget: 1_000 },
    required: true,
    now: at(),
  });
  return { type: "seeded", pid: process.pid, workflowId: workflow.id, parentRunId: run.id,
    parentWorkUnitId: unit.id, reservationId: queued.reservation.id };
}

async function recoverRestart() {
  assert.equal(typeof seed?.workflowId, "string");
  assert.equal(typeof seed?.reservationId, "string");
  const runtime = supervisor.getRuntime(cwd, store);
  const calls = [];
  const registry = createDelegationRuntimeRegistry({
    supervisor,
    activeRuns,
    isWorkflowSelected: createDelegationWorkflowSelector([seed.workflowId]),
    assertRecoveryParentCurrent: input => assertDelegationRecoveryParentCurrent({ ...input, activeRuns }),
    executeDelegatedRunRequest: async input => {
      calls.push({ childRunId: input.request.task.id, parentRunId: input.request.parentRunId,
        prompt: input.request.task.prompt, attemptId: input.executionEntry.attemptId });
    },
  });
  registry.registerStore(store, composition.lifecycle);
  try {
    const recoveredAt = at();
    const retried = store.transitionWorkUnitStatus({ workUnitId: seed.parentWorkUnitId, expectedStatus: "stale",
      event: "retry", actor: "system", now: recoveredAt, endedAt: null, errorCode: null, errorMessage: null });
    assert.equal(retried.ok, true);
    const parentAttempt = store.createWorkUnitAttempt({ workUnitId: seed.parentWorkUnitId, attemptNumber: 2,
      runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", effectiveRunnerId: "pi",
      status: "created", now: recoveredAt });
    const parentFence = toRuntimeAttemptFence(parentAttempt);
    assert.equal(store.transitionWorkUnitStatus({ ...parentFence, activeAttemptId: parentAttempt.id,
      expectedStatus: "queued", event: "claim", actor: "system", now: recoveredAt }).ok, true);
    assert.equal(store.transitionWorkUnitStatus({ ...parentFence, expectedStatus: "claimed",
      event: "runner_started", actor: "runner", now: recoveredAt, startedAt: recoveredAt }).ok, true);
    assert.ok(store.updateWorkUnitAttemptStatus({ ...parentFence, status: "started", now: recoveredAt,
      startedAt: recoveredAt }));
    const recoveredRun = store.getRun(seed.parentRunId);
    const recoveredThread = store.getLingThread(recoveredRun.threadId);
    const recoveredProvider = resolveProviderForRun(store,
      { providerPresetId: recoveredRun.providerPresetId, skipProviderPreflight: true }, resolver);
    const recoveredPolicy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({
      workspacePolicy: store.getApprovalPolicy(),
      authorizationMode: recoveredRun.requestSnapshot.authorizationMode,
      workspaceAccessMode: recoveredRun.requestSnapshot.workspaceAccessMode,
      channelBoundPath: cwd,
    }).snapshot, recoveredThread.conversationMode.mode);
    admitOriginalDelegationRoot({ store, run: recoveredRun, attempt: store.getWorkUnitAttempt(parentAttempt.id),
      originalProvider: recoveredProvider, request: recoveredRun.requestSnapshot,
      effectivePolicySnapshot: recoveredPolicy, runtimeTools: ["read"], now: recoveredAt });

    activeRuns.add(seed.parentRunId, { abortController: new AbortController(), streamEnvelope() {},
      ...parentFence, fencingToken: "foreign-process-fence" });
    const foreign = registry.recoverStore(store);
    assert.equal(foreign.dispatched, 0);
    assert.equal(calls.length, 0);

    activeRuns.delete(seed.parentRunId);
    activeRuns.add(seed.parentRunId, { abortController: new AbortController(), streamEnvelope() {}, ...parentFence });
    const exact = registry.recoverStore(store);
    assert.equal(exact.dispatched, 1);
    await registry.settle();
    const immediate = registry.recoverStore(store);
    assert.equal(immediate.dispatched, 0);
    await new Promise(resolve => setTimeout(resolve, 5_200));
    await registry.settle();
    const child = composition.lifecycle.recover(seed.reservationId);
    assert.equal(calls.length, 1);
    assert.equal(child.runtime.workUnit.attemptCount, 1);
    return { type: "recovered", pid: process.pid, runtimeInstanceId: runtime.runtimeInstanceId,
      foreign, exact, immediate, dispatches: calls, childKind: child.kind,
      childAttemptCount: child.runtime.workUnit.attemptCount };
  } finally {
    registry.stopAdmission();
    registry.abortOwned();
    await registry.settle().catch(() => undefined);
  }
}

try {
  const receipt = phase === "seed" ? await seedRestart() : await recoverRestart();
  supervisor.releaseAll();
  store.close();
  await send(receipt);
} catch (error) {
  try { supervisor.releaseAll(); } catch {}
  try { store.close(); } catch {}
  await send({ type: "error", pid: process.pid, message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined });
  process.exitCode = 1;
}
