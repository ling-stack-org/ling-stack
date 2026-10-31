import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConversationModeToEffectiveRunPolicySnapshot,
  createSqliteRunStore,
  resolveSessionRunPolicy,
} from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { resolveConfig } from "../../dist/config.js";
import { prepareExistingRunContinuationPlan } from "../../dist/features/harness/continuations/coordinator.js";
import { capturePreparedRunnerInput } from "../../dist/features/runs/prepared-runner-input.js";
import { resolveProviderForRun } from "../../dist/features/runs/providers.js";
import { ActiveRunRegistry } from "../../dist/runtime/active-runs.js";
import { createDetachedRunExecutionSink, executeExistingRunContinuation } from "../../dist/features/runs/orchestrator.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";
import { RunStoreRegistry } from "../../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";

export const DISCOVERY_CREATED_AT = "2026-10-01T00:00:00.000Z";
export const DISCOVERY_DUE_AT = "2026-10-01T01:00:00.000Z";

/** Real SQLite, frozen Pi input and Host policy. No provider request is made. */
export async function createRecoveryDiscoveryFixture(t, suffix, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), `ling-recovery-discovery-${suffix}-`));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const store = stores.getStore(cwd);
  const supervisor = options.runtimeSupervisor ?? new RuntimeSupervisor(resolveConfig({
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }));
  const runtime = supervisor.getRuntime(cwd, store);
  const activeRuns = new ActiveRunRegistry();
  const runner = createRunnerRegistry([{
    id: "pi", displayName: "Discovery fixture", status: "enabled", adapter: new PiRunnerAdapter(),
  }]).get("pi");
  assert.ok(runner);
  const channel = store.createChannel({ name: `Discovery ${suffix}`, boundPath: cwd }, DISCOVERY_CREATED_AT);
  const preset = store.createProviderPreset({
    kind: "openai-compatible", displayName: "Discovery fixture", providerId: "discovery-fixture",
    model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", authHeader: false,
    reasoning: false, capabilities: ["chat", "tool_call"], enabled: true,
  }, DISCOVERY_CREATED_AT);
  store.recordProviderCheckResult(preset.id, {
    ok: true, code: "ready", message: "Fixture does not call the provider", checkedAt: DISCOVERY_CREATED_AT,
  });
  const provider = resolveProviderForRun(store, { providerPresetId: preset.id }, { resolve: () => ({ configured: false }) });
  const reopenedRoots = [];
  const beforeCloseCallbacks = [];
  t.after(async () => {
    for (const callback of beforeCloseCallbacks) await callback();
    for (const reopened of reopenedRoots) {
      reopened.supervisor.releaseAll();
      reopened.stores.closeAll();
    }
    if (!options.runtimeSupervisor) supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });

  async function seedRun(surface, id, createdAt = DISCOVERY_CREATED_AT, ownership = {}) {
    const isTask = surface === "task";
    const isPrivate = surface === "teammate_direct";
    const channelId = isTask || surface === "channel_discussion" ? channel.id : undefined;
    const teammateId = isPrivate ? "teammate_builtin_engineer" : undefined;
    const task = isTask && !ownership.taskMissing
      ? store.createTask({ channelId, title: id, prompt: "Resume frozen input." }, createdAt) : undefined;
    const taskSnapshot = { id: task?.id ?? `task-${id}`, channelId, title: id, prompt: "Resume frozen input." };
    const thread = store.createLingThread({ kind: surface, channelId, taskId: task?.id,
      teammateId: ownership.threadTeammateId ?? teammateId,
      title: id, objective: taskSnapshot.prompt }, createdAt);
    const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", title: id,
      userInstruction: taskSnapshot.prompt, channelId, taskId: taskSnapshot.id, createdByActor: "local-user" }, createdAt);
    const runtimeToolFeatures = { unifiedExec: false, shellSnapshot: false };
    const runnerOptions = { cwd, task: taskSnapshot, provider, tools: ["read"], runtimeToolFeatures };
    const preparedInput = await new PiRunnerAdapter().prepareTaskInput(runnerOptions);
    const execution = capturePreparedRunnerInput({ runnerId: "pi", options: runnerOptions, preparedInput });
    const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({
      workspacePolicy: store.getApprovalPolicy(), authorizationMode: "smart", workspaceAccessMode: "workspace_write",
      channelBoundPath: cwd,
    }).snapshot, thread.conversationMode.mode);
    const unit = store.createWorkUnit({
      id: `unit-${id}`, workspaceId: "workspace_default", kind: ownership.workUnitKind ?? (isTask ? "task_run"
        : isPrivate ? "teammate_direct_reply" : surface === "conversation" ? "conversation_run" : "channel_ai_reply"),
      ownerType: isTask ? "task" : isPrivate ? "teammate_direct_message" : "conversation_turn",
      ownerId: task?.id ?? turn.id, channelId, taskId: taskSnapshot.id,
      teammateId: ownership.workUnitTeammateId ?? teammateId, providerPresetId: preset.id,
      runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: `discovery-${id}`, status: "stale",
      createdByActor: "system", request: { runId: `run-${id}` }, now: createdAt,
    });
    const attempt = store.createWorkUnitAttempt({ id: `attempt-${id}`, workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: "runtime-before-restart", runnerId: "pi", effectiveRunnerId: "pi",
      providerPresetId: preset.id, status: "lost", now: createdAt });
    const run = store.createRun({
      id: `run-${id}`, cwd, taskId: taskSnapshot.id, channelId, teammateId, providerPresetId: preset.id,
      providerName: provider.provider, providerModel: provider.model, taskSnapshot, providerSnapshot: provider,
      requestSnapshot: { cwd, workspaceCwd: cwd, task: taskSnapshot, threadId: thread.id, turnId: turn.id,
        providerPresetId: preset.id, tools: ["read"], runtimeToolFeatures, authorizationMode: "smart",
        workspaceAccessMode: "workspace_write", harnessFeatureSnapshot: {
          schemaVersion: 1, continuations: "enforce", toolBroker: "off", evaluations: "off",
          evaluationModelGate: "shadow", delegations: "off", delegationMaxDepth: 3,
        }, effectivePolicySnapshot: policy, runnerExecutionInput: execution },
      threadId: thread.id, turnId: turn.id, turnRunRole: "primary", workUnitId: unit.id,
      contextViewId: `context-${id}`, contextViewCreatedAt: createdAt, createdAt,
    });
    store.linkRunToWorkUnit(run.id, unit.id, createdAt);
    store.markRunStarted(run.id, createdAt);
    if (task) assert.equal(store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim",
      actor: "system", reason: `run:${run.id}`, now: createdAt }).ok, true);
    store.transitionLingTurnStatus({ turnId: turn.id, expectedStatus: "open", event: "start", actor: "system", now: createdAt });
    store.updateLingThread(thread.id, { status: "running", activeRunId: run.id, lastRunId: run.id }, createdAt);
    return { run: store.getRun(run.id), unit: store.getWorkUnit(unit.id), attempt, task, thread, policy, execution };
  }

  /** Persist prepared replay + a created replacement Attempt with the same activation CAS as production. */
  function schedule(seeded, dueAt = DISCOVERY_DUE_AT, id = seeded.run.id) {
    const plan = prepareExistingRunContinuationPlan({ store, run: seeded.run, workUnit: seeded.unit,
      sourceAttempt: seeded.attempt, runtime, runner, origin: "daemon_recovery", policySnapshot: seeded.policy,
      execution: seeded.execution, workspaceCwd: cwd, now: seeded.run.createdAt, idempotencyDiscriminator: `schedule-${id}` });
    const committed = store.commitExistingRunContinuation({ preparation: { ...plan.preparation, id: `continuation-${id}` },
      expectedRunStatus: "running", expectedWorkUnitStatus: "stale", actor: "system", reason: "Discovery fixture",
      now: seeded.run.createdAt });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    const deferred = store.deferRunnerContinuation({ continuationId: committed.continuation.id,
      expectedRevision: committed.continuation.revision, now: seeded.run.createdAt, nextAttemptAt: dueAt });
    assert.equal(deferred.ok, true, JSON.stringify(deferred));
    return deferred.value;
  }

  function seedBlockedStalePrefix(seeded, count = 500) {
    for (let index = 0; index < count; index += 1) {
      const id = `z-blocked-${seeded.unit.kind}-${String(index).padStart(4, "0")}`;
      const unit = store.createWorkUnit({ id: `unit-${id}`, workspaceId: "workspace_default", kind: seeded.unit.kind,
        ownerType: seeded.unit.ownerType, ownerId: seeded.unit.ownerId, channelId: seeded.unit.channelId,
        taskId: seeded.unit.taskId, teammateId: seeded.unit.teammateId, runnerId: "pi", effectiveRunnerId: "pi",
        providerPresetId: preset.id, idempotencyKey: id, status: "stale", request: {}, createdByActor: "system",
        now: seeded.unit.createdAt });
      store.createWorkUnitAttempt({ id: `attempt-${id}`, workUnitId: unit.id, attemptNumber: 1,
        runtimeInstanceId: "runtime-before-restart", runnerId: "pi", status: "lost", now: seeded.unit.createdAt });
      const run = store.createRun({ ...seeded.run, id: `run-${id}`, workUnitId: unit.id, createdAt: seeded.unit.createdAt });
      store.linkRunToWorkUnit(run.id, unit.id, seeded.unit.createdAt);
      store.markRunCancelled(run.id, seeded.unit.createdAt);
    }
  }

  function blockWithApproval(run) {
    return store.createApprovalRequest({ runId: run.id, taskId: run.taskId, channelId: run.channelId, actionType: "bash",
      risk: "medium", title: "Discovery approval", description: "Discovery is not approval authority.",
      payload: { type: "bash", cwd, command: "pwd", riskFlags: [] } }, DISCOVERY_CREATED_AT);
  }

  function executor() {
    const runnerCalls = [];
    const errors = [];
    const completions = [];
    class RecoveryRunner extends PiRunnerAdapter {
      async runTask(options) {
        assert.ok(options.preparedInput, "recovery must use durable frozen Pi input");
        runnerCalls.push({ runId: options.runId, attemptId: options.runnerAttemptId,
          inputFingerprint: options.preparedInput.fingerprint });
        return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "Recovered from saved input." }] };
      }
    }
    const runners = createRunnerRegistry([{ id: "pi", displayName: "Recovery fixture", status: "enabled", adapter: new RecoveryRunner() }]);
    return { runnerCalls, errors, completions, execute: (input) => {
      const completion = executeExistingRunContinuation(input,
        { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
        runners, stores, activeRuns, supervisor, { resolve: () => ({ configured: false }) }, {});
      completions.push(completion);
      return completion;
    } };
  }

  function reopenAfterRestart() {
    supervisor.releaseAll();
    stores.closeAll();
    const reopenedStores = new RunStoreRegistry(createSqliteRunStore);
    const reopenedSupervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
      harness: { continuations: { mode: "enforce" } } }));
    const reopened = { cwd, stores: reopenedStores, store: reopenedStores.getStore(cwd), supervisor: reopenedSupervisor,
      activeRuns: new ActiveRunRegistry() };
    reopenedSupervisor.getRuntime(cwd, reopened.store);
    reopenedRoots.push(reopened);
    return reopened;
  }
  return { cwd, store, stores, supervisor, runtime, activeRuns, channel, preset, seedRun, schedule, seedBlockedStalePrefix,
    blockWithApproval, executor, reopenAfterRestart, onBeforeClose: (callback) => beforeCloseCallbacks.push(callback) };
}

export async function waitForRecovery(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

export async function seedScheduledBlockedPrefix(fixture) {
  for (let index = 0; index < 500; index += 1) {
    const seeded = await fixture.seedRun("conversation", `scheduled-blocked-${String(index).padStart(4, "0")}`);
    fixture.schedule(seeded, DISCOVERY_DUE_AT, `a-blocked-${String(index).padStart(4, "0")}`);
    fixture.store.markRunCancelled(seeded.run.id, seeded.run.createdAt);
  }
}
