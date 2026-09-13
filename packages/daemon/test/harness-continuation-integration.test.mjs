import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyConversationModeToEffectiveRunPolicySnapshot,
  createSqliteRunStore,
  resolveSessionRunPolicy,
  runnerContinuationIdempotencyKey,
} from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { createDaemonServer } from "../dist/index.js";
import { resolveConfig } from "../dist/config.js";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import {
  createDetachedRunExecutionSink,
  executeExistingRunContinuation,
  executeRunRequest,
} from "../dist/features/runs/orchestrator.js";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import {
  readStoredEffectivePolicySnapshot,
  readStoredRunnerExecution,
  rebuildExistingRunRequest,
} from "../dist/features/runs/existing-run-request.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

const cases = [
  ["manual_resume", "manual_resume"],
  ["queue_followup", "queued_followup"],
  ["interrupt_redirect", "interrupt_redirect"],
];

for (const [continuationReason, origin] of cases) {
  test(`${continuationReason} is executed through one durable RunnerContinuation`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-harness-continuation-integration-"));
    const stores = new RunStoreRegistry(createSqliteRunStore);
    const supervisor = new RuntimeSupervisor(resolveConfig({
      defaultWorkspaceCwd: cwd,
      harness: { continuations: { mode: "enforce" } },
    }));
    const activeRuns = new ActiveRunRegistry();
    const store = stores.getStore(cwd);
    t.after(async () => {
      supervisor.releaseAll();
      stores.closeAll();
      await rm(cwd, { recursive: true, force: true });
    });
    const now = new Date().toISOString();
    const preset = store.createProviderPreset({
      kind: "openai-compatible",
      displayName: "Harness continuation fixture",
      providerId: "harness-continuation-fixture",
      model: "fixture",
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
      authHeader: false,
      reasoning: false,
      capabilities: ["chat", "tool_call"],
      enabled: true,
    }, now);
    store.recordProviderCheckResult(preset.id, {
      ok: true,
      code: "ready",
      message: "Synthetic ready",
      checkedAt: now,
    });
    const thread = store.createLingThread({
      kind: "conversation",
      teammateId: "ling_agent",
      title: "Harness continuation",
      objective: "Verify continuation",
    }, now);
    const calls = [];
    class FixtureRunner extends PiRunnerAdapter {
      async runTask(options) {
        assert.ok(options.preparedInput, "every Pi dispatch must use captured prepared input");
        calls.push({ runId: options.runId, attemptId: options.runnerAttemptId, taskId: options.task.id });
        return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "done" }] };
      }
    }
    const runners = createRunnerRegistry([{
      id: "pi",
      displayName: "Fixture",
      status: "enabled",
      adapter: new FixtureRunner(),
    }]);
    const errors = [];
    const dispatch = (request) => executeRunRequest(
      request,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      runners,
      stores,
      activeRuns,
      supervisor,
      { resolve: () => ({ configured: false }) },
      {},
    );
    const sourceRunId = await dispatch({
      cwd,
      workspaceCwd: cwd,
      threadId: thread.id,
      teammateId: "ling_agent",
      providerPresetId: preset.id,
      tools: ["read"],
      task: { id: `source-${continuationReason}`, title: "Source", prompt: "Inspect the source state." },
      idempotencyKey: `source:${continuationReason}`,
      createdByActor: "local-user",
    });
    assert.ok(sourceRunId, JSON.stringify(errors));
    const sourceRun = store.getRun(sourceRunId);
    const sourceUnit = store.getWorkUnit(sourceRun.workUnitId);
    const sourceAttempt = store.getWorkUnitAttempt(sourceUnit.activeAttemptId);
    const continuationRunId = await dispatch({
      cwd,
      workspaceCwd: cwd,
      threadId: thread.id,
      teammateId: "ling_agent",
      providerPresetId: preset.id,
      tools: ["read"],
      task: { id: `continuation-${continuationReason}`, title: "Continue", prompt: "Continue from durable evidence." },
      idempotencyKey: `continuation:${continuationReason}`,
      createdByActor: "local-user",
      parentRunId: sourceRun.id,
      continuationReason,
    });
    assert.ok(continuationRunId, JSON.stringify(errors));
    const continuationRun = store.getRun(continuationRunId);
    const continuationUnit = store.getWorkUnit(continuationRun.workUnitId);
    const continuation = store.findRunnerContinuationByIdempotencyKey(runnerContinuationIdempotencyKey({
      runId: continuationRun.id,
      sourceAttemptId: sourceAttempt.id,
      origin,
      generation: 0,
    }));
    assert.equal(continuationRun.parentRunId, sourceRun.id);
    assert.match(continuationRun.contextViewId, /^ctxrun_/u);
    assert.equal(continuationRun.requestSnapshot.harnessFeatureSnapshot.continuations, "enforce");
    assert.equal(continuationRun.requestSnapshot.harnessContinuationOrigin, origin);
    assert.equal(continuation?.origin, origin);
    assert.equal(continuation?.state, "succeeded");
    assert.equal(continuation?.targetAttemptId, continuationUnit.activeAttemptId);
    assert.equal(store.getWorkUnitAttempt(continuation.targetAttemptId).status, "succeeded");
    const replay = store.getArtifact(continuation.contextSnapshotArtifactId);
    assert.equal(replay?.contentType, "application/vnd.ling.runner-continuation-replay+json");
    assert.deepEqual(calls.map((call) => call.runId), [sourceRun.id, continuationRun.id]);
    assert.notEqual(calls[0].attemptId, calls[1].attemptId);
  });
}

test("a queueable continuation conflict reuses the already-persisted Run", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-harness-continuation-queue-"));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const supervisor = new RuntimeSupervisor(resolveConfig({
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }));
  const activeRuns = new ActiveRunRegistry();
  const store = stores.getStore(cwd);
  let releaseBlocker;
  const blockerReleased = new Promise((resolve) => { releaseBlocker = resolve; });
  let notifyBlockerStarted;
  const blockerStarted = new Promise((resolve) => { notifyBlockerStarted = resolve; });
  t.after(async () => {
    releaseBlocker?.();
    supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const preset = store.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Harness queue fixture",
    providerId: "harness-queue-fixture",
    model: "fixture",
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
    authHeader: false,
    reasoning: false,
    capabilities: ["chat", "tool_call"],
    enabled: true,
  }, now);
  store.recordProviderCheckResult(preset.id, {
    ok: true,
    code: "ready",
    message: "Synthetic ready",
    checkedAt: now,
  });
  const channel = store.createChannel({
    name: "Harness queue",
    boundPath: cwd,
    defaultProviderPresetId: preset.id,
    allowedTools: ["read", "write"],
    runtimePolicy: { queueOnConflict: true, maxConcurrentRuns: 3 },
  }, now);
  const sourceThread = store.createLingThread({
    kind: "channel",
    channelId: channel.id,
    title: "Continuation source",
    objective: "Verify queue conflict persistence",
  }, now);
  const blockerThread = store.createLingThread({
    kind: "channel",
    channelId: channel.id,
    title: "Blocking writer",
    objective: "Hold the bound-path lease",
  }, now);
  const calls = [];
  class QueueFixtureRunner extends PiRunnerAdapter {
    async runTask(options) {
      assert.ok(options.preparedInput);
      calls.push(options.task.id);
      if (options.task.id === "queue-blocker") {
        notifyBlockerStarted();
        await blockerReleased;
      }
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "done" }] };
    }
  }
  const runners = createRunnerRegistry([{
    id: "pi",
    displayName: "Queue fixture",
    status: "enabled",
    adapter: new QueueFixtureRunner(),
  }]);
  const errors = [];
  const dispatch = (request) => executeRunRequest(
    request,
    { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
    runners,
    stores,
    activeRuns,
    supervisor,
    { resolve: () => ({ configured: false }) },
    {},
  );
  const recoveryCoordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: supervisor,
    activeRuns,
    executeExistingRunContinuation: (input) => executeExistingRunContinuation(
      input,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      runners,
      stores,
      activeRuns,
      supervisor,
      { resolve: () => ({ configured: false }) },
      {},
    ),
  });
  const sourceRunId = await dispatch({
    cwd,
    workspaceCwd: cwd,
    threadId: sourceThread.id,
    providerPresetId: preset.id,
    tools: ["read"],
    task: { id: "queue-source", channelId: channel.id, title: "Source", prompt: "Create source evidence." },
    idempotencyKey: "queue-source",
    createdByActor: "local-user",
  });
  assert.ok(sourceRunId, JSON.stringify(errors));
  const sourceRun = store.getRun(sourceRunId);
  const sourceUnit = store.getWorkUnit(sourceRun.workUnitId);
  const sourceAttempt = store.getWorkUnitAttempt(sourceUnit.activeAttemptId);

  const blockerCompletion = dispatch({
    cwd,
    workspaceCwd: cwd,
    threadId: blockerThread.id,
    providerPresetId: preset.id,
    tools: ["write"],
    task: { id: "queue-blocker", channelId: channel.id, title: "Blocker", prompt: "Hold the write lease." },
    idempotencyKey: "queue-blocker",
    createdByActor: "local-user",
  });
  await blockerStarted;

  const continuationRunId = await dispatch({
    cwd,
    workspaceCwd: cwd,
    threadId: sourceThread.id,
    providerPresetId: preset.id,
    tools: ["write"],
    task: { id: "queue-continuation", channelId: channel.id, title: "Continue", prompt: "Continue after the blocker." },
    idempotencyKey: "queue-continuation",
    createdByActor: "local-user",
    parentRunId: sourceRun.id,
    continuationReason: "manual_resume",
  });
  assert.ok(continuationRunId, JSON.stringify(errors));
  const continuationRun = store.getRun(continuationRunId);
  const continuationUnit = store.getWorkUnit(continuationRun.workUnitId);
  const continuation = store.findRunnerContinuationByIdempotencyKey(runnerContinuationIdempotencyKey({
    runId: continuationRun.id,
    sourceAttemptId: sourceAttempt.id,
    origin: "manual_resume",
    generation: 0,
  }));
  assert.equal(store.listRuns({ limit: 100 }).filter((candidate) => candidate.id === continuationRunId).length, 1);
  assert.equal(continuationUnit.status, "queued");
  assert.equal(continuation?.state, "prepared");
  assert.deepEqual(calls, ["queue-source", "queue-blocker"]);
  assert.equal(store.listEvents(continuationRunId, { limit: 100 }).filter((event) => event.type === "run_created").length, 1);
  assert.equal(store.listRuntimeEvents(continuationUnit.id, { limit: 100 }).some((event) => event.type === "work_unit_queued"), true);

  releaseBlocker();
  await blockerCompletion;
  assert.deepEqual(recoveryCoordinator.recoverStore(store), { scanned: 1, dispatched: 1, skipped: 0 });
  await activeRuns.waitForIdle();
  await waitForCondition(
    () => store.getRun(continuationRunId)?.status === "succeeded",
    `queued continuation did not resume: ${JSON.stringify(errors)}`,
  );
  assert.equal(store.getWorkUnit(continuationUnit.id)?.status, "succeeded");
  assert.equal(store.getRunnerContinuation(continuation.id)?.state, "succeeded");
  assert.deepEqual(calls, ["queue-source", "queue-blocker", "queue-continuation"]);
});

test("the task WorkUnit retry API dispatches one fenced runner_retry continuation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-harness-runner-retry-"));
  const calls = [];
  class RetryFixtureRunner extends PiRunnerAdapter {
    async runTask(options) {
      assert.ok(options.preparedInput, "task retry requires a durable prepared Runner input");
      calls.push({ runId: options.runId, attemptId: options.runnerAttemptId });
      if (calls.length === 1) throw new Error("synthetic first attempt failure");
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "retry finished" }] };
    }
  }

  const seeded = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  const preset = seeded.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Runner retry fixture",
    providerId: "runner-retry-fixture",
    model: "fixture",
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
    authHeader: false,
    reasoning: false,
    capabilities: ["chat", "tool_call"],
    enabled: true,
  }, now);
  seeded.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
  const channel = seeded.createChannel({
    name: "Runner retry",
    boundPath: cwd,
    defaultProviderPresetId: preset.id,
    allowedTools: ["read"],
  }, now);
  const task = seeded.createTask({ channelId: channel.id, title: "Retry task", prompt: "Retry from durable input." }, now);
  seeded.close();

  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }, { runner: new RetryFixtureRunner() });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  });

  const first = await fetch(`${baseUrl}/tasks/${encodeURIComponent(task.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerPresetId: preset.id, tools: ["read"], authorizationMode: "smart", workspaceAccessMode: "workspace_write" }),
  });
  const firstEvents = await first.text();
  assert.equal(first.status, 200, firstEvents);
  const runId = readReadyRunId(firstEvents);
  assert.ok(runId);
  await waitForHttpCondition(async () => (await getJson(`${baseUrl}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`)).status === "failed",
    "first task attempt did not fail");
  const failedRun = await getJson(`${baseUrl}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
  const failedUnit = await getJson(`${baseUrl}/work-units/${encodeURIComponent(failedRun.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(failedUnit.workUnit.status, "failed");

  const changedProviderStore = createSqliteRunStore(cwd);
  const changedAt = new Date().toISOString();
  changedProviderStore.updateProviderPreset(preset.id, { baseUrl: "https://changed.invalid/v1" }, changedAt);
  changedProviderStore.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Changed endpoint ready", checkedAt: changedAt });
  changedProviderStore.close();
  const rejectedResponse = await fetch(`${baseUrl}/work-units/${encodeURIComponent(failedRun.workUnitId)}/retry?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const rejected = await rejectedResponse.json();
  assert.equal(rejectedResponse.status, 409, JSON.stringify(rejected));
  assert.equal(rejected.error, "prepared_provider_configuration_changed");
  const stillFailed = await getJson(`${baseUrl}/work-units/${encodeURIComponent(failedRun.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(stillFailed.workUnit.status, "failed");
  assert.equal(stillFailed.attempts.length, 1, "failed retry preparation must not create an Attempt");

  const restoredProviderStore = createSqliteRunStore(cwd);
  const restoredAt = new Date().toISOString();
  restoredProviderStore.updateProviderPreset(preset.id, { baseUrl: "https://fixture.invalid/v1" }, restoredAt);
  restoredProviderStore.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Fixture endpoint restored", checkedAt: restoredAt });
  restoredProviderStore.close();

  const retryResponse = await fetch(`${baseUrl}/work-units/${encodeURIComponent(failedRun.workUnitId)}/retry?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const retry = await retryResponse.json();
  assert.equal(retryResponse.status, 202, JSON.stringify(retry));
  assert.deepEqual(retry.continuation, { origin: "runner_retry", status: "started", runId });

  await waitForHttpCondition(async () => (await getJson(`${baseUrl}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`)).status === "succeeded",
    "retried task Run did not succeed");
  const completedUnit = await getJson(`${baseUrl}/work-units/${encodeURIComponent(failedRun.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(completedUnit.workUnit.status, "succeeded");
  assert.deepEqual(calls.map((call) => call.runId), [runId, runId]);
  assert.notEqual(calls[0].attemptId, calls[1].attemptId);
  const continuations = completedUnit.events.filter((event) => event.type === "work_unit_queued"
    && event.data?.origin === "runner_retry");
  assert.equal(continuations.length, 1);
});

test("daemon recovery preparation failure atomically closes the activated continuation lineage", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-harness-daemon-recovery-failure-"));
  const seeded = await seedRecoverableHarnessRun(cwd, "preparation-failure");
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const supervisor = new RuntimeSupervisor(resolveConfig({
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }));
  const activeRuns = new ActiveRunRegistry();
  const store = stores.getStore(cwd);
  const calls = [];
  class RecoveryFailureFixtureRunner extends PiRunnerAdapter {
    async runTask(options) {
      calls.push(options);
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "unexpected" }] };
    }
  }
  const runners = createRunnerRegistry([{
    id: "pi",
    displayName: "Recovery failure fixture",
    status: "enabled",
    adapter: new RecoveryFailureFixtureRunner(),
  }]);
  t.after(async () => {
    supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });

  supervisor.getRuntime(cwd, store);
  const acquireRuntimeSemaphoreSlot = store.acquireRuntimeSemaphoreSlot.bind(store);
  let injected = false;
  store.acquireRuntimeSemaphoreSlot = (input) => {
    if (!injected) {
      injected = true;
      throw new Error("FAULT_AFTER_CONTINUATION_ACTIVATION");
    }
    return acquireRuntimeSemaphoreSlot(input);
  };
  const errors = [];
  const result = await executeExistingRunContinuation(
    {
      cwd,
      runId: seeded.runId,
      origin: "daemon_recovery",
      idempotencyDiscriminator: "runtime-startup",
    },
    { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
    runners,
    stores,
    activeRuns,
    supervisor,
    { resolve: () => ({ configured: false }) },
    {},
  );

  assert.equal(result, undefined);
  assert.equal(errors.at(-1)?.message, "FAULT_AFTER_CONTINUATION_ACTIVATION");
  assert.equal(store.getRun(seeded.runId)?.status, "failed");
  assert.equal(store.getWorkUnit(seeded.workUnitId)?.status, "failed");
  assert.equal(store.getTask(store.getRun(seeded.runId).taskId)?.status, "failed");
  const attempts = store.listWorkUnitAttempts(seeded.workUnitId);
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["lost", "failed"]);
  const continuation = store.findRunnerContinuationByIdempotencyKey(`${runnerContinuationIdempotencyKey({
    runId: seeded.runId,
    sourceAttemptId: seeded.attemptId,
    origin: "daemon_recovery",
    generation: 0,
  })}:runtime-startup`);
  assert.equal(continuation?.state, "failed");
  assert.equal(continuation?.failureCode, undefined);
  assert.equal(continuation?.targetAttemptId, attempts[1].id);
  assert.equal(store.listResourceLeases({ status: "active", limit: 100 }).length, 0);
  assert.equal(store.listRuntimeSemaphoreSlots({ status: "active", limit: 100 }).length, 0);
  assert.equal(calls.length, 0);
});

test("daemon recovery duplicate scans dispatch one in-process continuation", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "duplicate-scan");
  let releaseDispatch;
  const pending = new Promise((resolve) => { releaseDispatch = resolve; });
  const calls = [];
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: (input) => {
      calls.push(input);
      return pending;
    },
  });
  coordinator.registerStore(fixture.store);
  coordinator.start();
  const duplicate = coordinator.recoverStore(fixture.store);
  assert.equal(calls.length, 1);
  assert.deepEqual(duplicate, { scanned: 1, dispatched: 0, skipped: 1 });
  releaseDispatch(undefined);
  await pending;
});

test("daemon recovery does not take over unresolved approvals", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "approval-skip");
  const run = fixture.store.getRun(fixture.seeded.runId);
  const approval = fixture.store.createApprovalRequest({
    runId: run.id,
    taskId: run.taskId,
    channelId: run.channelId,
    actionType: "bash",
    risk: "medium",
    title: "Pending recovery approval",
    description: "Recovery must not bypass this approval.",
    payload: { type: "bash", cwd: fixture.cwd, command: "git status", riskFlags: [] },
  }, new Date().toISOString());
  const calls = [];
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: async (input) => { calls.push(input); return input.runId; },
  });
  coordinator.registerStore(fixture.store);
  coordinator.start();
  assert.equal(calls.length, 0);
  fixture.store.approveApprovalRequest(
    approval.id,
    { reason: "Still awaiting the durable resume path." },
    new Date().toISOString(),
  );
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 0, skipped: 1 });
  assert.equal(calls.length, 0);
});

test("daemon recovery does not duplicate an ActiveRun", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "active-skip");
  fixture.activeRuns.add(fixture.seeded.runId, {
    abortController: new AbortController(),
    streamEnvelope() {},
  });
  const calls = [];
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: async (input) => { calls.push(input); return input.runId; },
  });
  coordinator.registerStore(fixture.store);
  coordinator.start();
  assert.equal(calls.length, 0);
  fixture.activeRuns.delete(fixture.seeded.runId);
});

test("daemon recovery policy drift fails before creating a replacement Attempt", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "policy-drift");
  fixture.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, new Date().toISOString());
  const calls = [];
  class PolicyDriftFixtureRunner extends PiRunnerAdapter {
    async runTask(options) {
      calls.push(options);
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "unexpected" }] };
    }
  }
  const errors = [];
  const result = await executeExistingRunContinuation(
    {
      cwd: fixture.cwd,
      runId: fixture.seeded.runId,
      origin: "daemon_recovery",
      idempotencyDiscriminator: "runtime-startup",
    },
    { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
    createRunnerRegistry([{
      id: "pi",
      displayName: "Policy drift fixture",
      status: "enabled",
      adapter: new PolicyDriftFixtureRunner(),
    }]),
    fixture.stores,
    fixture.activeRuns,
    fixture.supervisor,
    { resolve: () => ({ configured: false }) },
    {},
  );
  assert.equal(result, undefined);
  assert.equal(errors.at(-1)?.error, "continuation_policy_changed");
  assert.equal(fixture.store.listWorkUnitAttempts(fixture.seeded.workUnitId).length, 1);
  assert.equal(fixture.store.getWorkUnit(fixture.seeded.workUnitId)?.status, "stale");
  assert.equal(calls.length, 0);
});

test("daemon recovery refuses dispatch after shutdown begins", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "shutdown");
  const calls = [];
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: async (input) => { calls.push(input); return input.runId; },
  });
  coordinator.registerStore(fixture.store);
  coordinator.beginShutdown();
  coordinator.start();
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 0, dispatched: 0, skipped: 0 });
  assert.equal(calls.length, 0);
});

test("daemon startup recovers one enforced Harness task Run through a fresh fenced Attempt", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-harness-daemon-recovery-"));
  const seeded = await seedRecoverableHarnessRun(cwd, "restart");
  const calls = [];
  class RecoveryFixtureRunner extends PiRunnerAdapter {
    async runTask(options) {
      assert.ok(options.preparedInput, "daemon recovery must reuse frozen Runner input");
      calls.push({ runId: options.runId, attemptId: options.runnerAttemptId });
      return {
        taskId: options.task.id,
        events: [],
        messages: [{ role: "assistant", content: "daemon recovery finished" }],
      };
    }
  }
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }, { runner: new RecoveryFixtureRunner() });
  await daemon.start();
  const observed = createSqliteRunStore(cwd);
  t.after(async () => {
    observed.close();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  });

  try {
    await waitForHttpCondition(() => observed.getRun(seeded.runId)?.status === "succeeded",
      "daemon recovery did not finish the original logical Run");
  } catch {
    const currentRun = observed.getRun(seeded.runId);
    let rebuildError;
    try { rebuildExistingRunRequest(currentRun, "daemon_recovery"); }
    catch (error) { rebuildError = error instanceof Error ? error.message : String(error); }
    assert.fail(JSON.stringify({
      run: currentRun,
      workUnit: observed.getWorkUnit(seeded.workUnitId),
      task: currentRun ? observed.getTask(currentRun.taskId) : undefined,
      storedRunnerExecution: currentRun ? Boolean(readStoredRunnerExecution(currentRun)) : false,
      storedPolicy: currentRun ? Boolean(readStoredEffectivePolicySnapshot(currentRun.requestSnapshot)) : false,
      rebuildError,
      attempts: observed.listWorkUnitAttempts(seeded.workUnitId),
      events: observed.listRuntimeEvents(seeded.workUnitId, { limit: 100 }),
      calls,
    }, null, 2));
  }
  const workUnit = observed.getWorkUnit(seeded.workUnitId);
  const attempts = observed.listWorkUnitAttempts(seeded.workUnitId);
  assert.equal(workUnit.status, "succeeded");
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["lost", "succeeded"]);
  assert.deepEqual(calls.map((call) => call.runId), [seeded.runId]);
  assert.notEqual(calls[0].attemptId, seeded.attemptId);
  const continuation = observed.findRunnerContinuationByIdempotencyKey(`${runnerContinuationIdempotencyKey({
    runId: seeded.runId,
    sourceAttemptId: seeded.attemptId,
    origin: "daemon_recovery",
    generation: 0,
  })}:runtime-startup`);
  assert.equal(continuation?.state, "succeeded");
  assert.equal(continuation?.targetAttemptId, calls[0].attemptId);
});

function readReadyRunId(text) {
  for (const block of text.split("\n\n")) {
    if (!block.includes("event: ready")) continue;
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) continue;
    const parsed = JSON.parse(data);
    if (typeof parsed.runId === "string") return parsed.runId;
  }
  return undefined;
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function waitForHttpCondition(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(message);
}

async function seedRecoverableHarnessRun(cwd, suffix) {
  const store = createSqliteRunStore(cwd);
  const now = "2026-09-13T02:00:00.000Z";
  const channel = store.createChannel({ name: `Harness recovery ${suffix}`, boundPath: cwd }, now);
  const task = store.createTask({
    channelId: channel.id,
    title: `Harness recovery ${suffix}`,
    prompt: "Continue the saved task after daemon restart.",
  }, now);
  const taskSnapshot = { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt };
  const thread = store.createLingThread({
    kind: "task",
    channelId: channel.id,
    taskId: task.id,
    title: task.title,
    objective: task.prompt,
  }, now);
  const turn = store.createLingTurn({
    threadId: thread.id,
    kind: "initial_request",
    title: task.title,
    userInstruction: task.prompt,
    channelId: channel.id,
    taskId: task.id,
    createdByActor: "local-user",
  }, now);
  const preset = store.createProviderPreset({
    kind: "openai-compatible",
    displayName: `Harness recovery ${suffix}`,
    providerId: `harness-recovery-${suffix}`,
    model: "fixture",
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
    authHeader: false,
    reasoning: false,
    capabilities: ["chat", "tool_call"],
    enabled: true,
  }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
  const provider = resolveProviderForRun(store, { providerPresetId: preset.id }, { resolve: () => ({ configured: false }) });
  const runtimeToolFeatures = { unifiedExec: false, shellSnapshot: false };
  const runnerOptions = { cwd, task: taskSnapshot, provider, tools: ["read"], runtimeToolFeatures };
  const preparedInput = await new PiRunnerAdapter().prepareTaskInput(runnerOptions);
  const runnerExecutionInput = capturePreparedRunnerInput({ runnerId: "pi", options: runnerOptions, preparedInput });
  const effectivePolicySnapshot = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({
    workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
    channelBoundPath: cwd,
  }).snapshot, thread.conversationMode.mode);
  const runId = `run_harness_daemon_recovery_${suffix}`;
  const workUnit = store.createWorkUnit({
    id: `work_unit_harness_daemon_recovery_${suffix}`,
    workspaceId: "workspace_default",
    kind: "task_run",
    ownerType: "task",
    ownerId: task.id,
    channelId: channel.id,
    taskId: task.id,
    providerPresetId: preset.id,
    runnerId: "pi",
    effectiveRunnerId: "pi",
    idempotencyKey: `harness-daemon-recovery-${suffix}`,
    createdByActor: "system",
    request: { runId },
    now,
  });
  const attempt = store.createWorkUnitAttempt({
    id: `attempt_harness_daemon_recovery_${suffix}`,
    workUnitId: workUnit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime_before_restart",
    runnerId: "pi",
    effectiveRunnerId: "pi",
    providerPresetId: preset.id,
    now,
  });
  const run = store.createRun({
    id: runId,
    cwd,
    taskId: task.id,
    channelId: channel.id,
    providerPresetId: preset.id,
    providerName: provider.provider,
    providerModel: provider.model,
    taskSnapshot,
    providerSnapshot: provider,
    requestSnapshot: {
      cwd,
      workspaceCwd: cwd,
      task: taskSnapshot,
      threadId: thread.id,
      turnId: turn.id,
      providerPresetId: preset.id,
      tools: ["read"],
      runtimeToolFeatures,
      authorizationMode: "smart",
      workspaceAccessMode: "workspace_write",
      harnessFeatureSnapshot: {
        schemaVersion: 1,
        continuations: "enforce",
        toolBroker: "off",
        evaluations: "off",
        evaluationModelGate: "shadow",
        delegations: "off",
        delegationMaxDepth: 3,
      },
      effectivePolicySnapshot,
      runnerExecutionInput,
    },
    threadId: thread.id,
    turnId: turn.id,
    turnRunRole: "primary",
    workUnitId: workUnit.id,
    contextViewId: `context_harness_daemon_recovery_${suffix}`,
    contextViewCreatedAt: now,
    createdAt: now,
  });
  store.linkRunToWorkUnit(run.id, workUnit.id, now);
  store.markRunStarted(run.id, now);
  assert.equal(store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim",
    actor: "system", reason: `run:${run.id}`, now }).ok, true);
  const fence = { workUnitId: workUnit.id, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId,
    fencingToken: attempt.fencingToken };
  assert.equal(store.transitionWorkUnitStatus({ ...fence, activeAttemptId: attempt.id, expectedStatus: "queued",
    event: "claim", actor: "system", now }).ok, true);
  assert.equal(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started",
    actor: "runner", now }).ok, true);
  assert.ok(store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now, startedAt: now }));
  store.transitionLingTurnStatus({ turnId: turn.id, expectedStatus: "open", event: "start", actor: "system", now });
  store.updateLingThread(thread.id, { status: "running", activeRunId: run.id, lastRunId: run.id }, now);
  store.close();
  return { runId: run.id, workUnitId: workUnit.id, attemptId: attempt.id, presetId: preset.id };
}

async function createDaemonRecoveryCoordinatorFixture(t, suffix) {
  const cwd = await mkdtemp(join(tmpdir(), `ling-harness-recovery-coordinator-${suffix}-`));
  const seeded = await seedRecoverableHarnessRun(cwd, suffix);
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const supervisor = new RuntimeSupervisor(resolveConfig({
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }));
  const activeRuns = new ActiveRunRegistry();
  const store = stores.getStore(cwd);
  supervisor.getRuntime(cwd, store);
  t.after(async () => {
    supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, seeded, stores, supervisor, activeRuns, store };
}

async function waitForCondition(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(message);
}
