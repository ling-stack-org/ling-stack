import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyConversationModeToEffectiveRunPolicySnapshot,
  captureRunProgressCheckpointLineage,
  createSqliteRunStore,
  resolveSessionRunPolicy,
  runnerContinuationIdempotencyKey,
  toRuntimeAttemptFence,
} from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDaemonServer } from "../dist/index.js";
import { resolveConfig } from "../dist/config.js";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { assessRunCompactionRecovery } from "../dist/features/harness/continuations/run-compaction-recovery.js";
import { commitRunCompactionProgress } from "../dist/features/harness/continuations/run-compaction-progress.js";
import { OrdinaryRunProgressController } from "../dist/features/harness/continuations/run-ordinary-progress.js";
import { runnerPolicySnapshotFingerprint } from "../dist/features/harness/continuations/replay-package.js";
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
import { assertA21ExactRecoveredToolProgress, createA21LoopbackTransport, createA21RealPiRunner, readA21SettledCommand }
  from "./support/noncompacted-recovery-crash-worker.mjs";

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
        await options.onTaskContinuationBoundary?.("before_provider_request");
        if (options.task.id === "unfinished-tool") {
          options.onEvent?.({ type: "tool_start", toolCallId: "unfinished-tool-call", toolName: "read",
            args: { path: "fixture" } });
        } else if (options.task.id === "source-queue_followup") {
          options.onEvent?.({ type: "tool_start", toolCallId: "completed-tool-call", toolName: "read",
            args: { path: "fixture" } });
          options.onEvent?.({ type: "tool_end", toolCallId: "completed-tool-call", toolName: "read",
            result: { content: [{ type: "text", text: "read complete" }] }, isError: false });
        }
        options.onEvent?.({ type: "context_compaction_start", reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1",
          contextSnapshot: [{ role: "assistant", content: "pre-compaction evidence" }] });
        options.onEvent?.({ type: "context_compaction_end", reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1",
          outcome: "sdk_installed", willRetry: false, tokensBefore: 1800, estimatedTokensAfter: 400,
          compactedSummary: "Fixture compacted view",
          compactedModelView: [{ role: "compactionSummary", summary: "Fixture compacted view" },
            { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] });
        await options.onTaskContinuationBoundary?.("before_provider_request");
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
    const streamedEvents = [];
    const dispatch = (request) => executeRunRequest(
      request,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body),
        writeEvent: (_type, envelope) => streamedEvents.push(envelope) },
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
    const compaction = store.listEvents(sourceRun.id).filter(event => event.type.startsWith("context_compaction_"));
    assert.deepEqual(compaction.map(event => [event.type, event.data.attemptId]), [
      ["context_compaction_start", sourceAttempt.id], ["context_compaction_end", sourceAttempt.id],
    ]);
    assert.equal(compaction[1].data.outcome, "sdk_installed");
    assert.match(compaction[0].data.checkpointArtifactId, /^artifact_/u);
    const compactionArtifact = store.getArtifact(compaction[0].data.checkpointArtifactId);
    assert.equal(compactionArtifact.contentType, "application/vnd.ling.pi-compaction-context+json");
    assert.equal(compactionArtifact.sealedPayload.boundary, "pi-compaction-context");
    assert.deepEqual(compactionArtifact.sealedPayload.messages, [{ role: "assistant", content: "pre-compaction evidence" }]);
    const checkpoint = store.getLatestRunCompactionCheckpoint(sourceRun.id);
    assert.equal(checkpoint?.state, "committed");
    const summaryArtifact = store.getArtifact(checkpoint.summaryArtifactId);
    assert.equal(summaryArtifact?.sealedPayload.modelView[0].summary, "Fixture compacted view");
    const streamedCompactionArtifact = streamedEvents.find((event) => event.type === "artifact_created"
      && event.data.artifact?.id === compactionArtifact.id);
    assert.ok(streamedCompactionArtifact);
    assert.equal("sealedPayload" in streamedCompactionArtifact.data.artifact, false);
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
    if (continuationReason === "manual_resume") {
      await dispatch({
        cwd, workspaceCwd: cwd, threadId: thread.id, teammateId: "ling_agent",
        providerPresetId: preset.id, tools: ["read"],
        task: { id: "unfinished-tool", title: "Unsafe compaction", prompt: "Keep tool evidence complete." },
        idempotencyKey: "unfinished-tool", createdByActor: "local-user",
      });
      const unsafeRunId = calls.at(-1).runId;
      assert.equal(store.getLatestRunCompactionCheckpoint(unsafeRunId), undefined,
        "an active tool cannot become a committed recovery checkpoint");
      assert.equal(store.getRun(unsafeRunId)?.status, "failed");
      assert.match(store.listEvents(unsafeRunId).filter((event) => event.type === "run_error").at(-1)?.data.message ?? "",
        /checkpoint\.effect_unknown/u);
    }
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
  const transport = await createA21LoopbackTransport(() => ({ content: "retry finished" }));
  t.after(() => transport.close());
  const runner = createA21RealPiRunner(transport, { afterHostBoundary: async ({ boundary, options }) => {
    assert.ok(options.preparedInput, "task retry requires a durable prepared Runner input");
    // Fail inside the real SDK lifetime, not a fabricated adapter return. The
    // original SDK cleanup must prove that this source executed no tools.
    if (runner.dispatches.length === 1 && boundary === "before_provider_request") {
      throw new Error("synthetic first attempt failure");
    }
  } });
  const calls = runner.dispatches;

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
    // This fixture counts exact task Attempts/provider dispatches. Terminal
    // report synthesis has its own tests and otherwise adds a valid tool-free
    // model call without runId after this task completes.
    channels: { terminalReports: false },
  }, { runner });
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
  assert.equal(transport.requests.length, 1, "only the successful retry reaches the offline provider");
  const continuations = completedUnit.events.filter((event) => event.type === "work_unit_queued"
    && event.data?.origin === "runner_retry");
  assert.equal(continuations.length, 1);
});

for (const surface of ["task", "conversation", "teammate_direct"]) {
test(`daemon recovery preparation failure atomically closes the activated ${surface} lineage`, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-harness-daemon-recovery-failure-"));
  const seeded = await seedRecoverableHarnessRun(cwd, "preparation-failure", false, surface);
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
  assert.equal(store.getTask(store.getRun(seeded.runId).taskId)?.status, surface === "task" ? "failed" : undefined);
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
}

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
  coordinator.beginShutdown();
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
  coordinator.beginShutdown();
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
  coordinator.beginShutdown();
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

for (const surface of ["task", "conversation", "teammate_direct"]) {
test(`daemon recovery provider preflight failure settles the stale ${surface} Run once with visible error`, async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "provider-blocked", false, surface);
  fixture.store.recordProviderCheckResult(fixture.seeded.presetId, {
    ok: false,
    code: "network_failed",
    message: "Provider check failed before recovery.",
    checkedAt: new Date().toISOString(),
  });
  const errors = [];
  const dispatches = [];
  const runnerCalls = [];
  class BlockedRecoveryRunner extends PiRunnerAdapter {
    async runTask(options) {
      runnerCalls.push(options);
      return { taskId: options.task.id, events: [], messages: [] };
    }
  }
  const executeRecovery = (input) => {
    dispatches.push(input);
    return executeExistingRunContinuation(
      input,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "Fixture", status: "enabled", adapter: new BlockedRecoveryRunner() }]),
      fixture.stores,
      fixture.activeRuns,
      fixture.supervisor,
      { resolve: () => ({ configured: false }) },
      {},
    );
  };
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: executeRecovery,
  });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  await waitForCondition(() => errors.length === 1, "provider preflight was not rejected");

  const run = fixture.store.getRun(fixture.seeded.runId);
  assert.equal(errors[0]?.error, "provider_preflight_failed");
  assert.equal(run?.status, "failed");
  assert.match(run?.errorMessage ?? "", /network_failed/);
  assert.equal(fixture.store.getWorkUnit(fixture.seeded.workUnitId)?.status, "failed");
  assert.equal(fixture.store.getTask(run.taskId)?.status, surface === "task" ? "failed" : undefined);
  assert.equal(fixture.store.getLingThread(run.threadId)?.status, "failed");
  assert.deepEqual(fixture.store.listWorkUnitAttempts(fixture.seeded.workUnitId).map((attempt) => attempt.status), ["lost"]);
  const terminalEvents = fixture.store.listEvents(run.id, { limit: 100 }).filter((event) => event.type === "run_error");
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].data.code, "provider_preflight_failed");
  const summary = JSON.parse(await readFile(run.summaryPath, "utf8"));
  assert.equal(summary.status, "failed");
  assert.match(summary.errorMessage, /network_failed/);
  assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
  const afterRestart = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: async (input) => { dispatches.push(input); return input.runId; },
  });
  assert.deepEqual(afterRestart.recoverStore(fixture.store), { scanned: 0, dispatched: 0, skipped: 0 });
  assert.equal(dispatches.length, 1);
  assert.equal(runnerCalls.length, 0);
});
}

test("stale recovery failure cannot close a Run after its replacement Attempt takes ownership", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "provider-race");
  const source = fixture.store.getWorkUnitAttempt(fixture.seeded.attemptId);
  const run = fixture.store.getRun(fixture.seeded.runId);
  assert.equal(fixture.store.transitionWorkUnitStatus({
    workUnitId: fixture.seeded.workUnitId, expectedStatus: "stale", event: "retry",
    actor: "system", now: new Date().toISOString(),
  }).ok, true);
  const replacement = fixture.store.createWorkUnitAttempt({
    workUnitId: fixture.seeded.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "replacement_runtime", runnerId: "pi", effectiveRunnerId: "pi",
    providerPresetId: fixture.seeded.presetId, now: new Date().toISOString(),
  });
  const result = fixture.store.commitStaleRunRecoveryFailure({
    runId: run.id, sourceFence: toRuntimeAttemptFence(source), expectedRunStatus: "running",
    errorCode: "provider_preflight_failed", errorMessage: "Old preflight result",
    summaryPath: "unused", now: new Date().toISOString(),
  });
  assert.deepEqual(result, { ok: false, code: "recovery_failure_lineage_stale" });
  assert.equal(fixture.store.getRun(run.id)?.status, "running");
  assert.equal(fixture.store.getWorkUnit(fixture.seeded.workUnitId)?.status, "queued");
  assert.equal(fixture.store.getWorkUnit(fixture.seeded.workUnitId)?.activeAttemptId, replacement.id);
  assert.equal(fixture.store.getTask(run.taskId)?.status, "claimed");
  assert.equal(fixture.store.getWorkUnitAttempt(source.id)?.status, "lost");
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
  const transport = await createA21LoopbackTransport(() => ({ content: "daemon recovery finished" }));
  t.after(() => transport.close());
  const runner = createA21RealPiRunner(transport);
  const calls = runner.dispatches;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }, { runner });
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
  assert.equal(transport.requests.length, 1);
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

test("daemon restart blocks a compacted Run without a committed Host checkpoint", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-missing", true);
  const runnerCalls = [];
  const errors = [];
  class BlockedCompactionRunner extends PiRunnerAdapter {
    async runTask(options) {
      runnerCalls.push(options);
      assert.fail("A compacted Run without a Host checkpoint must not be replayed.");
    }
  }
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: (input) => executeExistingRunContinuation(
      input,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "Fixture", status: "enabled", adapter: new BlockedCompactionRunner() }]),
      fixture.stores,
      fixture.activeRuns,
      fixture.supervisor,
      { resolve: () => ({ configured: false }) },
      {},
    ),
  });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  await waitForCondition(() => errors.length === 1, "missing checkpoint was not rejected");
  assert.equal(errors[0]?.error, "checkpoint.missing");
  assert.equal(fixture.store.getRun(fixture.seeded.runId)?.status, "failed");
  assert.equal(fixture.store.getWorkUnit(fixture.seeded.workUnitId)?.status, "failed");
  assert.equal(fixture.store.listEvents(fixture.seeded.runId).filter((event) => event.type === "run_error").at(-1)?.data.code,
    "checkpoint.missing");
  assert.equal(runnerCalls.length, 0);
  assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
});

test("A21 real non-compacted worker crash blocks recovery without committed Host model-view authority", async (t) => {
  const fixture = await createA21CrashedDaemonRecoveryFixture(t, "head_insert");
  const sourceFacts = fixture.store.listEvents(fixture.source.runId);
  t.diagnostic(JSON.stringify({ sourceRunId: fixture.source.runId, sourceAttemptId: fixture.source.attemptId,
    preparedSeq: fixture.source.settlement.prepared.seq, settledSeq: fixture.source.settlement.settled.seq,
    toolEndSeq: fixture.source.settlement.end.seq, sourceEventSeq: fixture.source.settlement.sourceEventSeq,
    sourceModelRequests: fixture.source.requests.length, sourceToolEnds: sourceFacts.filter((event) => event.type === "tool_end").length,
    markerLines: (await readFile(fixture.source.markerPath, "utf8")).trim().split("\n").length }));
  const transport = await createA21LoopbackTransport(() => ({ content: "A fresh prompt must not reach this provider." }));
  t.after(() => transport.close());
  const runner = createA21RealPiRunner(transport);
  const errors = [];
  const coordinator = new DaemonRunnerRecoveryCoordinator({ runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns, executeExistingRunContinuation: (input) => executeExistingRunContinuation(
      input, { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "A21 real SDK recovery", status: "enabled", adapter: runner }]),
      fixture.stores, fixture.activeRuns, fixture.supervisor, { resolve: () => ({ configured: false }) }, {},
    ) });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  await waitForCondition(() => errors.length > 0 || ["succeeded", "failed"].includes(fixture.store.getRun(fixture.source.runId)?.status),
    "non-compacted crash recovery did not reach a structured decision", 10_000);
  const recoveryRun = fixture.store.getRun(fixture.source.runId);
  const events = fixture.store.listEvents(fixture.source.runId);
  const attempts = fixture.store.listWorkUnitAttempts(fixture.source.workUnitId);
  const markerContents = await readFile(fixture.source.markerPath, "utf8");
  // Read effect and lineage facts even when the expected structured error is
  // absent. A fresh provider request is not evidence of a repeated command.
  assert.deepEqual(events.filter((event) => event.seq <= fixture.source.settlement.sourceEventSeq), sourceFacts);
  assert.equal(events.filter((event) => event.type === "tool_start").length, 1);
  assert.equal(events.filter((event) => event.type === "tool_end").length, 1);
  assert.equal(events.some((event) => event.type.startsWith("context_compaction_")), false);
  assert.equal(markerContents, "a21-effect\n");
  assert.equal(fixture.store.listHostCommandWriteBlockers(fixture.cwd).length, 0);
  t.diagnostic(JSON.stringify({ recoveryStatus: recoveryRun?.status, recoveryErrors: errors,
    replacementAttempts: attempts.filter((attempt) => attempt.id !== fixture.source.attemptId).map((attempt) =>
      ({ id: attempt.id, status: attempt.status })), replacementDispatches: runner.dispatches,
    replacementModelRequests: transport.requests.length,
    recoveredToolResults: runner.contexts.flat().filter((message) => message.role === "toolResult").length,
    markerLinesAfterRecovery: markerContents.trim().split("\n").length,
    sourceAuthorityTables: fixture.sourceAuthorityTables }));
  assert.equal(errors[0]?.error, "checkpoint.missing", JSON.stringify({ errors, requestCount: transport.requests.length,
    dispatches: runner.dispatches, run: { id: recoveryRun?.id, status: recoveryRun?.status, errorMessage: recoveryRun?.errorMessage } }));
  assert.equal(transport.requests.length, 0, "missing committed authority must block before any model request");
  assert.equal(runner.contexts.length, 0);
  assert.equal(attempts.length, 1, "missing authority must be rejected before creating a replacement Attempt");
  assert.equal(events.filter((event) => event.type === "run_error").at(-1)?.data.code, "checkpoint.missing");
  assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
  assert.deepEqual(fixture.store.listWorkUnitAttempts(fixture.source.workUnitId), attempts);
  assert.equal(transport.requests.length, 0);
  assert.equal(await readFile(fixture.source.markerPath, "utf8"), markerContents);
});

test("A21 real non-compacted worker crash restores the exact committed SDK and wire tool view once", async (t) => {
  const fixture = await createA21CrashedDaemonRecoveryFixture(t);
  const sourceFacts = fixture.store.listEvents(fixture.source.runId);
  const transport = await createA21LoopbackTransport(() => ({ content: "The original command completed once before restart." }));
  t.after(() => transport.close());
  const runner = createA21RealPiRunner(transport);
  const errors = [];
  const coordinator = new DaemonRunnerRecoveryCoordinator({ runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns, executeExistingRunContinuation: (input) => executeExistingRunContinuation(
      input, { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "A21 real SDK recovery", status: "enabled", adapter: runner }]),
      fixture.stores, fixture.activeRuns, fixture.supervisor, { resolve: () => ({ configured: false }) }, {},
    ) });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  await waitForCondition(() => errors.length > 0 || ["succeeded", "failed"].includes(fixture.store.getRun(fixture.source.runId)?.status),
    "non-compacted checkpoint recovery did not finish", 10_000).catch(error => {
    const run = fixture.store.getRun(fixture.source.runId);
    const workUnit = fixture.store.getWorkUnit(fixture.source.workUnitId);
    assert.fail(JSON.stringify({ message: error.message, errors,
      run: run && { status: run.status, errorCode: run.errorCode, errorMessage: run.errorMessage },
      workUnit: workUnit && { status: workUnit.status, activeAttemptId: workUnit.activeAttemptId,
        errorCode: workUnit.errorCode, errorMessage: workUnit.errorMessage },
      attempts: fixture.store.listWorkUnitAttempts(fixture.source.workUnitId).map(attempt => ({ id: attempt.id,
        status: attempt.status, errorCode: attempt.errorCode, errorMessage: attempt.errorMessage })),
      leases: fixture.store.listResourceLeases({ workUnitId: fixture.source.workUnitId, limit: 100 }).map(lease => ({
        status: lease.status, attemptId: lease.attemptId, releaseReason: lease.releaseReason })),
      semaphores: fixture.store.listRuntimeSemaphoreSlots({ workUnitId: fixture.source.workUnitId, limit: 100 }).map(slot => ({
        status: slot.status, attemptId: slot.attemptId, releaseReason: slot.releaseReason })),
      completion: fixture.store.getHostAttemptCompletion({ runId: fixture.source.runId,
        ...toRuntimeAttemptFence(fixture.store.getWorkUnitAttempt(fixture.source.attemptId)) }),
      dispatches: runner.dispatches, requests: transport.requests.length }));
  });
  const recoveredRun = fixture.store.getRun(fixture.source.runId);
  t.diagnostic(JSON.stringify({ recoveryStatus: recoveredRun.status, error: recoveredRun.errorMessage, errors,
    contextRoles: runner.contexts.map(context => context.map(message => message.role)),
    recoveryEvents: fixture.store.listEvents(fixture.source.runId)
      .filter(event => event.seq > fixture.source.settlement.sourceEventSeq) }));
  assert.deepEqual(errors, []);
  assert.equal(fixture.store.getRun(fixture.source.runId)?.status, "succeeded");
  assert.equal(runner.dispatches.length, 1);
  assert.equal(runner.contexts.length, 1);
  assert.equal(transport.requests.length, 1);
  assertA21ExactRecoveredToolProgress(fixture.source, runner.contexts[0], transport.requests[0].body);
  const events = fixture.store.listEvents(fixture.source.runId);
  assert.deepEqual(events.filter(event => event.seq <= fixture.source.settlement.sourceEventSeq), sourceFacts);
  assert.equal(events.filter(event => event.type === "tool_start").length, 1);
  assert.equal(events.filter(event => event.type === "tool_end").length, 1);
  assert.equal(events.some(event => event.type.startsWith("context_compaction_")), false);
  assert.equal(await readFile(fixture.source.markerPath, "utf8"), "a21-effect\n");
  const attempts = fixture.store.listWorkUnitAttempts(fixture.source.workUnitId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts.filter(attempt => attempt.status === "succeeded").length, 1);
  assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
  assert.deepEqual(fixture.store.listWorkUnitAttempts(fixture.source.workUnitId), attempts);
  assert.equal(transport.requests.length, 1);
  assert.equal(await readFile(fixture.source.markerPath, "utf8"), "a21-effect\n");
  t.diagnostic(JSON.stringify({ sourceAttempt: fixture.source.attemptId, recoveryAttempt: runner.dispatches[0].attemptId,
    authorityTables: fixture.sourceAuthorityTables, sourceHighWater: fixture.source.settlement.sourceEventSeq,
    sourceRequestCount: fixture.source.requests.length, recoveryRequestCount: transport.requests.length,
    recoveredToolResults: runner.contexts[0].filter(message => message.role === "toolResult").length, markerLines: 1 }));
});

for (const toolBroker of ["off", "enforce"]) {
  test(`A21 real SDK write/edit remain live-capable with toolBroker ${toolBroker}`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), `ling-a21-live-files-${toolBroker}-`));
    const stores = new RunStoreRegistry(createSqliteRunStore);
    const store = stores.getStore(cwd);
    const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
      harness: { continuations: { mode: "enforce" }, toolBroker: { mode: toolBroker } } }));
    const activeRuns = new ActiveRunRegistry();
    t.after(async () => { supervisor.releaseAll(); stores.closeAll(); await rm(cwd, { recursive: true, force: true }); });
    const filePath = join(cwd, "ordinary-progress.txt");
    const calls = [
      { id: `a21-write-${toolBroker}`, name: "write", arguments: { path: filePath, content: "alpha\n" } },
      { id: `a21-edit-${toolBroker}`, name: "edit", arguments: { path: filePath,
        edits: [{ oldText: "alpha", newText: "beta" }] } },
    ];
    const transport = await createA21LoopbackTransport((count) => count <= calls.length
      ? { tool_calls: [{ index: 0, id: calls[count - 1].id, type: "function",
        function: { name: calls[count - 1].name, arguments: JSON.stringify(calls[count - 1].arguments) } }] }
      : { content: "The owned file was written and edited." });
    t.after(() => transport.close());
    const runner = createA21RealPiRunner(transport);
    const now = new Date().toISOString();
    const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "A21 file fixture",
      providerId: `a21-live-${toolBroker}`, model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
      authHeader: false, reasoning: false, capabilities: ["chat", "tool_call"], enabled: true }, now);
    store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
    const channel = store.createChannel({ name: "A21 file fixture", boundPath: cwd }, now);
    const task = store.createTask({ channelId: channel.id, title: "Write and edit",
      prompt: "Write alpha then edit to beta in the authorized owned file." }, now);
    const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id, title: task.title, objective: task.prompt }, now);
    const errors = [];
    const runId = await executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id,
      providerPresetId: preset.id, task: { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt },
      tools: ["write", "edit"], authorizationMode: "always", workspaceAccessMode: "full_access",
      permissionConfirmation: { mode: "full_access", confirmed: true, confirmedAt: now,
        reason: "Authorized fixture-owned write/edit tools in an isolated temporary workspace." },
      idempotencyKey: `a21-live-files-${toolBroker}`, createdByActor: "local-user" },
    { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
    createRunnerRegistry([{ id: "pi", displayName: "A21 real SDK file fixture", status: "enabled", adapter: runner }]),
    stores, activeRuns, supervisor, { resolve: () => ({ configured: false }) }, {});
    assert.deepEqual(errors, []);
    assert.ok(runId);
    t.diagnostic(JSON.stringify({ toolBroker, status: store.getRun(runId).status, error: store.getRun(runId).errorMessage,
      contextRoles: runner.contexts.map(context => context.map(message => message.role)),
      toolResults: store.listEvents(runId).filter(event => event.type === "tool_end")
        .map(event => ({ id: event.data.toolCallId, name: event.data.toolName, isError: event.data.isError })),
      executions: store.listHarnessToolExecutions(runId).map(execution =>
        ({ id: execution.toolCallId, name: execution.toolName, state: execution.state })) }));
    assert.equal(store.getRun(runId).status, "succeeded", store.getRun(runId).errorMessage);
    assert.equal(await readFile(filePath, "utf8"), "beta\n");
    assert.equal(transport.requests.length, 3);
    const events = store.listEvents(runId);
    assert.deepEqual(events.filter(event => event.type === "tool_end").map(event =>
      ({ id: event.data.toolCallId, name: event.data.toolName, isError: event.data.isError })),
    calls.map(call => ({ id: call.id, name: call.name, isError: false })));
    assert.equal(events.some(event => event.type.startsWith("context_compaction_")), false);
    const database = new DatabaseSync(store.paths.databasePath, { readOnly: true });
    try {
      assert.equal(Number(database.prepare("SELECT COUNT(*) AS n FROM run_progress_checkpoints WHERE run_id=?").get(runId).n),
        toolBroker === "off" ? 0 : 2);
      const head = database.prepare("SELECT revision FROM run_progress_checkpoint_heads WHERE run_id=?").get(runId);
      assert.equal(head?.revision, toolBroker === "off" ? undefined : 2);
    } finally { database.close(); }
  });
}

for (const code of ["checkpoint.effect_unjournaled", "checkpoint.effect_unknown", "checkpoint.commit_failed", "checkpoint.head_conflict"]) {
  test(`A21 ordinary producer distinguishes Core ${code} without granting recovery authority`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-a21-producer-decision-"));
    const seeded = await seedRecoverableHarnessRun(cwd, code.replaceAll(".", "-"));
    const store = createSqliteRunStore(cwd);
    t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
    const run = store.getRun(seeded.runId);
    const sourceFence = toRuntimeAttemptFence(store.getWorkUnitAttempt(seeded.attemptId));
    store.appendExecutionEvent(run.id, sourceFence, "tool_start", { toolCallId: "decision-read", toolName: "read", args: { path: "owned.txt" } });
    store.appendExecutionEvent(run.id, sourceFence, "tool_end", { toolCallId: "decision-read", toolName: "read", isError: false,
      result: { content: [{ type: "text", text: "producer control-flow fixture" }] } });
    let commits = 0;
    const decisionStore = new Proxy(store, { get(target, key) {
      if (key === "commitRunProgressCheckpoint") return () => { commits += 1; return { kind: "blocked", code }; };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const controller = new OrdinaryRunProgressController({ store: decisionStore, run, sourceFence,
      policySnapshot: readStoredEffectivePolicySnapshot(run.requestSnapshot) });
    const expected = { kind: code === "checkpoint.effect_unjournaled" ? "unsupported" : "blocked", code };
    assert.deepEqual(controller.beforeProviderBoundary({ modelView: [], activeToolCallIds: [] }), expected);
    assert.equal(commits, 1);
    // Unsupported is not latched as safe: the next boundary must still ask Core
    // to revalidate all effects, rather than swallowing later unknown outcomes.
    assert.deepEqual(controller.beforeProviderBoundary({ modelView: [], activeToolCallIds: [] }), expected);
    assert.equal(commits, 2);
    assert.deepEqual(controller.beforeProviderBoundary({ modelView: [], activeToolCallIds: ["unsettled-call"] }),
      { kind: "blocked", code: "checkpoint.effect_unknown" });
    assert.equal(commits, 2);
  });
}

test("A21 real-SDK fixture preserves falsy Host boundary rejections without issuing a request", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a21-falsy-host-fixture-"));
  const seeded = await seedRecoverableHarnessRun(cwd, "falsy-host-fixture");
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const execution = readStoredRunnerExecution(store.getRun(seeded.runId));
  const transport = await createA21LoopbackTransport(() => ({ content: "No rejected callback may reach this provider." }));
  t.after(() => transport.close());
  for (const rejection of [undefined, null, false, 0, ""]) {
    const captured = [];
    const events = [];
    const runner = createA21RealPiRunner(transport, { afterHostBoundary: async input => {
      captured.push({ failed: input.hostFailed, rejection: input.hostError });
    } });
    await assert.rejects(runner.runTask({ ...execution.input, preparedInput: execution.preparedInput,
      runId: seeded.runId, runnerAttemptId: seeded.attemptId, onEvent: event => events.push(event),
      onTaskContinuationBoundary: async () => { throw rejection; } }));
    assert.ok(captured.some(input => input.failed && Object.is(input.rejection, rejection)));
    assert.equal(events.some(event => event.type === "run_end"), false);
    assert.equal(runner.contexts.length, 0);
    assert.equal(transport.requests.length, 0);
  }
});

test("daemon restart cannot activate a compacted checkpoint without its sealed Host resource boundary", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-boundary-missing", "committed");
  const boundary = fixture.store.listArtifacts(fixture.seeded.runId).find(artifact =>
    artifact.contentType === "application/vnd.ling.host-compaction-resource-boundary+json");
  assert.ok(boundary, "the positive fixture must first have a valid resource boundary");
  fixture.store.database.prepare("DELETE FROM artifacts WHERE id=?").run(boundary.id);
  const calls = [], errors = [];
  class UnverifiedCompactionRunner extends PiRunnerAdapter {
    async runTask(options) { calls.push(options); assert.fail("Missing Host evidence must not dispatch a replacement."); }
  }
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: input => executeExistingRunContinuation(
      input,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "Fixture", status: "enabled", adapter: new UnverifiedCompactionRunner() }]),
      fixture.stores, fixture.activeRuns, fixture.supervisor,
      { resolve: () => ({ configured: false }) }, {},
    ),
  });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  await waitForCondition(() => errors.length > 0, "missing resource boundary was not rejected");
  assert.equal(errors[0].error, "continuation.activation_checkpoint_unverified");
  assert.equal(calls.length, 0);
  assert.equal(fixture.store.listWorkUnitAttempts(fixture.seeded.workUnitId).length, 1);
  assert.equal(fixture.store.getWorkUnit(fixture.seeded.workUnitId).status, "stale");
  assert.equal(fixture.store.getRun(fixture.seeded.runId).status, "running");
});

test("daemon restart restores a completed compacted Run without replaying the prompt", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-committed", "committed");
  const runnerCalls = [];
  const errors = [];
  class ReconstructedCompactionRunner extends PiRunnerAdapter {
    async runTask(options) {
      runnerCalls.push(options);
      assert.deepEqual(options.compactionRecovery?.modelView.at(-1), {
        role: "assistant", content: [{ type: "text", text: "The task was already completed before restart." }],
        stopReason: "stop",
      });
      options.onEvent?.({ type: "run_start", taskId: options.task.id, cwd: options.cwd,
        provider: options.provider.provider, model: options.provider.model });
      options.onEvent?.({ type: "run_end", taskId: options.task.id, messageCount: options.compactionRecovery.modelView.length });
      return { taskId: options.task.id, events: [], messages: options.compactionRecovery.modelView };
    }
  }
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: (input) => executeExistingRunContinuation(
      input,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "Fixture", status: "enabled", adapter: new ReconstructedCompactionRunner() }]),
      fixture.stores,
      fixture.activeRuns,
      fixture.supervisor,
      { resolve: () => ({ configured: false }) },
      {},
    ),
  });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  await waitForCondition(() => fixture.store.getRun(fixture.seeded.runId)?.status === "succeeded",
    "committed checkpoint was not reconstructed");
  assert.equal(errors.length, 0);
  assert.equal(fixture.store.getWorkUnit(fixture.seeded.workUnitId)?.status, "succeeded");
  assert.equal(runnerCalls.length, 1);
});

test("real Pi SDK advances recovered tool progress through Host SQLite before the next model request", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-real-tool-progress", "tool_result");
  const filePath = join(fixture.cwd, "recovered-read.txt");
  await writeFile(filePath, "Recovered read evidence", "utf8");
  const errors = [];
  let taskRequests = 0;
  let checkpointAtSecondRequest;
  class RealRecoveredRunner extends PiRunnerAdapter {
    async prepareTaskInput(options) {
      return super.prepareTaskInput({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
    }
    async runTask(options) {
      return super.runTask({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
    }
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions",
        streamSimple: (model, context, options) => stream(model, context, { ...options,
          fetch: async () => {
            taskRequests += 1;
            if (taskRequests === 2) checkpointAtSecondRequest = fixture.store.getLatestRunCompactionCheckpoint(fixture.seeded.runId);
            const delta = taskRequests === 1
              ? { tool_calls: [{ index: 0, id: "after-restart-read", type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: filePath }) } }] }
              : { content: "Recovered task complete." };
            const finish = taskRequests === 1 ? "tool_calls" : "stop";
            return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
              + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`
              + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
          },
        }),
      });
    }
  }
  const runner = new RealRecoveredRunner();
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: (input) => executeExistingRunContinuation(
      input,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "Real SDK fixture", status: "enabled", adapter: runner }]),
      fixture.stores, fixture.activeRuns, fixture.supervisor,
      { resolve: () => ({ configured: false }) }, {},
    ),
  });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  await waitForCondition(() => ["succeeded", "failed"].includes(fixture.store.getRun(fixture.seeded.runId)?.status),
    "real recovered tool loop did not settle", 10_000);
  assert.equal(fixture.store.getRun(fixture.seeded.runId).status, "succeeded", JSON.stringify({ errors, taskRequests,
    runErrors: fixture.store.listEvents(fixture.seeded.runId).filter((event) => event.type === "run_error" || event.type === "message_end"),
    workUnit: fixture.store.getWorkUnit(fixture.seeded.workUnitId) }));
  assert.equal(taskRequests, 2);
  assert.ok(checkpointAtSecondRequest?.sourceEventSeq > fixture.store.getLatestRunCompactionStart(fixture.seeded.runId).seq,
    "Host must seal the completed read before Pi sends its second task request");
  assert.notEqual(checkpointAtSecondRequest.attemptId, fixture.seeded.attemptId);
  assert.equal(fixture.store.listEvents(fixture.seeded.runId).filter((event) => event.type === "tool_end").length, 1);
});

test("daemon restart installs the latest progress view without replaying its completed tool", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-progress-restart", "progress");
  const errors = [];
  let modelRequests = 0;
  class LatestProgressRunner extends PiRunnerAdapter {
    async prepareTaskInput(options) {
      return super.prepareTaskInput({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
    }
    async runTask(options) {
      assert.equal(options.compactionRecovery?.modelView.at(-1)?.toolCallId, "already-done");
      return super.runTask({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
    }
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions",
        streamSimple: (model, context, options) => stream(model, context, { ...options,
          fetch: async () => {
            modelRequests += 1;
            return new Response('data: {"choices":[{"index":0,"delta":{"content":"Resumed after saved read."},"finish_reason":null}]}\n\n'
              + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
              + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
          },
        }),
      });
    }
  }
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: (input) => executeExistingRunContinuation(
      input,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "Real SDK fixture", status: "enabled", adapter: new LatestProgressRunner() }]),
      fixture.stores, fixture.activeRuns, fixture.supervisor,
      { resolve: () => ({ configured: false }) }, {},
    ),
  });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  await waitForCondition(() => ["succeeded", "failed"].includes(fixture.store.getRun(fixture.seeded.runId)?.status),
    "latest progress recovery did not settle", 10_000);
  assert.equal(fixture.store.getRun(fixture.seeded.runId).status, "succeeded", JSON.stringify(errors));
  assert.equal(modelRequests, 1);
  assert.equal(fixture.store.listEvents(fixture.seeded.runId).filter((event) => event.type === "tool_end").length, 1,
    "the completed tool is evidence, not a command to replay");
});

test("a failed read after compaction is checkpointed as an error, then the model may recover", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-failed-tool", "tool_result");
  const missingPath = join(fixture.cwd, "missing-read.txt");
  const errors = [];
  let modelRequests = 0;
  class FailedReadRunner extends PiRunnerAdapter {
    async prepareTaskInput(options) {
      return super.prepareTaskInput({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
    }
    async runTask(options) {
      return super.runTask({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
    }
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions",
        streamSimple: (model, context, options) => stream(model, context, { ...options,
          fetch: async () => {
            modelRequests += 1;
            const delta = modelRequests === 1
              ? { tool_calls: [{ index: 0, id: "failed-read", type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: missingPath }) } }] }
              : { content: "The first read failed; report the missing file." };
            const finish = modelRequests === 1 ? "tool_calls" : "stop";
            return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
              + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`
              + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
          },
        }),
      });
    }
  }
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: (input) => executeExistingRunContinuation(
      input,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "Real SDK fixture", status: "enabled", adapter: new FailedReadRunner() }]),
      fixture.stores, fixture.activeRuns, fixture.supervisor,
      { resolve: () => ({ configured: false }) }, {},
    ),
  });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  await waitForCondition(() => ["succeeded", "failed"].includes(fixture.store.getRun(fixture.seeded.runId)?.status),
    "failed read was not settled", 10_000);
  assert.equal(fixture.store.getRun(fixture.seeded.runId).status, "succeeded", JSON.stringify(errors));
  assert.equal(modelRequests, 2);
  assert.notEqual(fixture.store.getLatestRunCompactionCheckpoint(fixture.seeded.runId).attemptId, fixture.seeded.attemptId);
  assert.equal(fixture.store.listEvents(fixture.seeded.runId).filter((event) => event.type === "tool_end").at(-1)?.data.isError, true);
});

for (const [surface, workUnitKind] of [
  ["conversation", "conversation_run"],
  ["teammate_direct", "teammate_direct_reply"],
]) {
  test(`daemon restart resumes a compacted ${surface} Run with no Task row exactly once`, async (t) => {
    const fixture = await createDaemonRecoveryCoordinatorFixture(t, `compaction-${surface}`, "committed", surface);
    const calls = [];
    const errors = [];
    const dispatches = [];
    class ConversationRecoveryRunner extends PiRunnerAdapter {
      async runTask(options) {
        calls.push(options);
        assert.equal(options.hostCompactionEnabled, true);
        assert.ok(options.compactionRecovery?.modelView, "the sealed compacted view must be installed");
        return { taskId: options.task.id, events: [], messages: options.compactionRecovery.modelView };
      }
    }
    const coordinator = new DaemonRunnerRecoveryCoordinator({
      runtimeSupervisor: fixture.supervisor,
      activeRuns: fixture.activeRuns,
      executeExistingRunContinuation: (input) => {
        dispatches.push(input);
        return executeExistingRunContinuation(
          input,
          { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
          createRunnerRegistry([{ id: "pi", displayName: "Fixture", status: "enabled", adapter: new ConversationRecoveryRunner() }]),
          fixture.stores,
          fixture.activeRuns,
          fixture.supervisor,
          { resolve: () => ({ configured: false }) },
          {},
        );
      },
    });
    t.after(() => coordinator.beginShutdown());
    assert.equal(fixture.store.getTask(fixture.store.getRun(fixture.seeded.runId).taskId), undefined);
    assert.equal(fixture.store.getWorkUnit(fixture.seeded.workUnitId).kind, workUnitKind);
    coordinator.registerStore(fixture.store);
    coordinator.start();
    try {
      await waitForCondition(() => fixture.store.getRun(fixture.seeded.runId)?.status === "succeeded",
        `${surface} checkpoint was not resumed`);
    } catch {
      assert.fail(JSON.stringify({ surface, run: fixture.store.getRun(fixture.seeded.runId)?.status,
        workUnit: fixture.store.getWorkUnit(fixture.seeded.workUnitId)?.status,
        attempts: fixture.store.listWorkUnitAttempts(fixture.seeded.workUnitId).map((attempt) => attempt.status),
        errors, dispatches, calls: calls.length,
        runErrors: fixture.store.listEvents(fixture.seeded.runId).filter((event) => event.type === "run_error").map((event) => event.data),
        scan: coordinator.recoverStore(fixture.store) }));
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(fixture.store.listWorkUnitAttempts(fixture.seeded.workUnitId).map((attempt) => attempt.status),
      ["lost", "succeeded"]);
    const completedRun = fixture.store.getRun(fixture.seeded.runId);
    assert.equal(fixture.store.getLingTurnForRun(completedRun.id)?.status, "succeeded");
    assert.equal(fixture.store.getLingThread(completedRun.threadId)?.status, "succeeded");
    assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
  });
}

test("daemon Run recovery leaves stale channel reply children to channel dispatch", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-channel", "committed", "channel_discussion");
  const calls = [];
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: async (input) => { calls.push(input); return input.runId; },
  });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  assert.equal(fixture.store.getWorkUnit(fixture.seeded.workUnitId).kind, "channel_ai_reply");
  assert.equal(calls.length, 0);
  assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
});

test("daemon restart cannot rebind a private compacted Run to another teammate", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-private-owner", "committed", "teammate_direct");
  const getLingThread = fixture.store.getLingThread.bind(fixture.store);
  fixture.store.getLingThread = (id) => {
    const thread = getLingThread(id);
    return thread ? { ...thread, teammateId: "teammate_builtin_designer" } : undefined;
  };
  const calls = [];
  const coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns,
    executeExistingRunContinuation: async (input) => { calls.push(input); return input.runId; },
  });
  t.after(() => coordinator.beginShutdown());
  coordinator.registerStore(fixture.store);
  coordinator.start();
  assert.equal(calls.length, 0);
  assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
});

test("recovery cannot replay a committed compaction after a later completed tool", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-post-tool", "committed");
  const run = fixture.store.getRun(fixture.seeded.runId);
  const sourceAttempt = fixture.store.getWorkUnitAttempt(fixture.seeded.attemptId);
  const policySnapshot = readStoredEffectivePolicySnapshot(run.requestSnapshot);
  for (let index = 0; index < 1000; index++) fixture.store.appendEvent(run.id, "turn_end", {});
  fixture.store.appendEvent(run.id, "tool_start", {
    toolCallId: "post-checkpoint-effect", toolName: "bash", args: { command: "completed before crash" },
  });
  fixture.store.appendEvent(run.id, "tool_end", {
    toolCallId: "post-checkpoint-effect", toolName: "bash", isError: false,
    result: { content: [{ type: "text", text: "effect was already committed" }] },
  });
  const assessment = assessRunCompactionRecovery({ store: fixture.store, run, sourceAttempt, policySnapshot });
  assert.deepEqual({ kind: assessment.kind, code: assessment.code },
    { kind: "blocked", code: "checkpoint.effect_unknown" });
});

test("settled tool progress seals a new SDK view and restart reads the latest checkpoint", async (t) => {
  const fixture = await createActiveCompactionProgressFixture(t, "compaction-progress");
  const { store } = fixture;
  const run = store.getRun(fixture.seeded.runId);
  const attempt = store.getWorkUnitAttempt(fixture.seeded.attemptId);
  const sourceFence = toRuntimeAttemptFence(attempt);
  const activeStore = new Proxy(store, { get(target, property) {
    if (property === "isCurrentRunExecutionOwner") return () => true;
    if (property === "findRequiredUserInputForAttempt") return () => undefined;
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const policySnapshot = readStoredEffectivePolicySnapshot(run.requestSnapshot);
  const previous = store.getLatestRunCompactionCheckpoint(run.id);
  const previousView = store.getArtifact(previous.summaryArtifactId).sealedPayload.modelView;
  store.appendEvent(run.id, "tool_start", {
    toolCallId: "progress-tool", toolName: "read", args: { path: "fixture" },
  });
  store.appendEvent(run.id, "tool_end", {
    toolCallId: "progress-tool", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "read complete" }] },
  });
  const modelView = [...previousView,
    { role: "assistant", content: [{ type: "toolCall", id: "progress-tool", name: "read", arguments: { path: "fixture" } }] },
    { role: "toolResult", toolCallId: "progress-tool", toolName: "read", content: [{ type: "text", text: "read complete" }] }];
  assert.equal(assessRunCompactionRecovery({ store, run, sourceAttempt: attempt, policySnapshot }).code,
    "checkpoint.effect_unknown");
  const result = commitRunCompactionProgress({ store: activeStore, run, attempt, sourceFence, policySnapshot,
    modelView, activeToolCallIds: [] });
  assert.equal(result.kind, "committed");
  const checkpoint = store.getLatestRunCompactionCheckpoint(run.id);
  assert.equal(checkpoint.predecessorId, previous.id);
  assert.ok(checkpoint.sourceEventSeq > previous.sourceEventSeq);
  const recovery = assessRunCompactionRecovery({ store, run, sourceAttempt: attempt, policySnapshot });
  assert.equal(recovery.kind, "verified", JSON.stringify(recovery));
  assert.deepEqual(recovery.modelView, modelView);
  store.appendEvent(run.id, "tool_start", {
    toolCallId: "second-progress-tool", toolName: "read", args: { path: "fixture-2" },
  });
  store.appendEvent(run.id, "tool_end", {
    toolCallId: "second-progress-tool", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "second read complete" }] },
  });
  const secondView = [...modelView,
    { role: "assistant", content: [{ type: "toolCall", id: "second-progress-tool", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "second-progress-tool", toolName: "read",
      content: [{ type: "text", text: "second read complete" }] }];
  const second = commitRunCompactionProgress({ store: activeStore, run, attempt, sourceFence, policySnapshot,
    modelView: secondView, activeToolCallIds: [] });
  assert.equal(second.kind, "committed");
  assert.notEqual(second.checkpointId, checkpoint.id);
  const secondRecovery = assessRunCompactionRecovery({ store, run, sourceAttempt: attempt, policySnapshot });
  assert.equal(secondRecovery.kind, "verified");
  assert.deepEqual(secondRecovery.modelView, secondView);
  store.appendEvent(run.id, "tool_start", {
    toolCallId: "late-tool", toolName: "bash", args: { command: "side effect" },
  });
  store.appendEvent(run.id, "tool_end", {
    toolCallId: "late-tool", toolName: "bash", isError: false,
    result: { content: [{ type: "text", text: "done" }] },
  });
  assert.equal(assessRunCompactionRecovery({ store, run, sourceAttempt: attempt, policySnapshot }).code,
    "checkpoint.effect_unknown");
});

test("progress refuses a tool result absent from the exact SDK view", async (t) => {
  const fixture = await createActiveCompactionProgressFixture(t, "compaction-progress-mismatch");
  const { store } = fixture;
  const run = store.getRun(fixture.seeded.runId);
  const attempt = store.getWorkUnitAttempt(fixture.seeded.attemptId);
  const sourceFence = toRuntimeAttemptFence(attempt);
  const activeStore = new Proxy(store, { get(target, property) {
    if (property === "isCurrentRunExecutionOwner") return () => true;
    if (property === "findRequiredUserInputForAttempt") return () => undefined;
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const policySnapshot = readStoredEffectivePolicySnapshot(run.requestSnapshot);
  const previous = store.getLatestRunCompactionCheckpoint(run.id);
  store.appendEvent(run.id, "tool_start", {
    toolCallId: "progress-tool", toolName: "read", args: { path: "fixture" },
  });
  store.appendEvent(run.id, "tool_end", {
    toolCallId: "progress-tool", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "read complete" }] },
  });
  const wrongView = store.getArtifact(previous.summaryArtifactId).sealedPayload.modelView;
  const result = commitRunCompactionProgress({ store: activeStore, run, attempt, sourceFence, policySnapshot,
    modelView: wrongView, activeToolCallIds: [] });
  assert.equal(result.kind, "blocked");
  assert.equal(store.getLatestRunCompactionCheckpoint(run.id).id, previous.id);
  store.appendEvent(run.id, "run_cancelled", { reason: "user_cancelled", active: true });
  const correctView = [...wrongView,
    { role: "assistant", content: [{ type: "toolCall", id: "progress-tool", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "progress-tool", toolName: "read", content: [{ type: "text", text: "read complete" }] }];
  assert.equal(commitRunCompactionProgress({ store: activeStore, run, attempt, sourceFence, policySnapshot,
    modelView: correctView, activeToolCallIds: [] }).kind, "blocked");
  assert.equal(store.getLatestRunCompactionCheckpoint(run.id).id, previous.id);
});

test("a verified restart Attempt can advance compacted progress without granting an arbitrary handoff", async (t) => {
  const fixture = await createActiveCompactionProgressFixture(t, "compaction-progress-handoff");
  const { store } = fixture;
  const run = store.getRun(fixture.seeded.runId);
  const previous = store.getLatestRunCompactionCheckpoint(run.id);
  const oldView = store.getArtifact(previous.summaryArtifactId).sealedPayload.modelView;
  const attempt = store.createWorkUnitAttempt({
    workUnitId: fixture.seeded.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "runtime_after_restart", runnerId: "pi", effectiveRunnerId: "pi",
    providerPresetId: fixture.seeded.presetId, now: new Date().toISOString(),
  });
  const sourceFence = toRuntimeAttemptFence(attempt);
  assert.ok(store.updateWorkUnitAttemptStatus({ ...sourceFence, status: "started",
    now: new Date().toISOString(), startedAt: new Date().toISOString() }));
  const activeStore = new Proxy(store, { get(target, property) {
    if (property === "isCurrentRunExecutionOwner") return () => true;
    if (property === "findRequiredUserInputForAttempt") return () => undefined;
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  store.appendEvent(run.id, "tool_start", { toolCallId: "after-restart", toolName: "read", args: {} });
  store.appendEvent(run.id, "tool_end", { toolCallId: "after-restart", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "saved" }] } });
  const modelView = [...oldView,
    { role: "assistant", content: [{ type: "toolCall", id: "after-restart", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "after-restart", toolName: "read", content: [{ type: "text", text: "saved" }] }];
  const policySnapshot = readStoredEffectivePolicySnapshot(run.requestSnapshot);
  assert.equal(commitRunCompactionProgress({ store: activeStore, run, attempt, sourceFence, policySnapshot,
    modelView, activeToolCallIds: [] }).kind, "blocked");
  const committed = commitRunCompactionProgress({ store: activeStore, run, attempt, sourceFence, policySnapshot,
    modelView, activeToolCallIds: [], allowRecoveredAttemptHandoff: true });
  assert.equal(committed.kind, "committed", JSON.stringify(committed));
  assert.equal(store.getLatestRunCompactionCheckpoint(run.id).attemptId, attempt.id);
  const recovery = assessRunCompactionRecovery({ store, run, sourceAttempt: attempt, policySnapshot });
  assert.equal(recovery.kind, "verified", JSON.stringify(recovery));
  assert.deepEqual(recovery.modelView, modelView);
});

test("a failed consequential tool remains effect-unknown after compaction", async (t) => {
  const fixture = await createActiveCompactionProgressFixture(t, "compaction-failed-effect");
  const { store } = fixture;
  const run = store.getRun(fixture.seeded.runId);
  const attempt = store.getWorkUnitAttempt(fixture.seeded.attemptId);
  const sourceFence = toRuntimeAttemptFence(attempt);
  const previous = store.getLatestRunCompactionCheckpoint(run.id);
  const oldView = store.getArtifact(previous.summaryArtifactId).sealedPayload.modelView;
  store.appendEvent(run.id, "tool_start", { toolCallId: "failed-bash", toolName: "bash", args: { command: "write then fail" } });
  store.appendEvent(run.id, "tool_end", { toolCallId: "failed-bash", toolName: "bash", isError: true,
    result: { content: [{ type: "text", text: "nonzero after partial write" }] } });
  const activeStore = new Proxy(store, { get(target, property) {
    if (property === "isCurrentRunExecutionOwner") return () => true;
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const result = commitRunCompactionProgress({ store: activeStore, run, attempt, sourceFence,
    policySnapshot: readStoredEffectivePolicySnapshot(run.requestSnapshot), activeToolCallIds: [],
    modelView: [...oldView,
      { role: "assistant", content: [{ type: "toolCall", id: "failed-bash", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "failed-bash", toolName: "bash",
        content: [{ type: "text", text: "nonzero after partial write" }], isError: true }],
  });
  assert.deepEqual(result, { kind: "blocked", code: "checkpoint.effect_unknown" });
  assert.equal(store.getLatestRunCompactionCheckpoint(run.id).id, previous.id);
});

for (const kind of ["mcp", "media", "host_capability", "plugin"]) {
  test(`a sealed compaction view cannot hide a pending ${kind} Host operation`, async t => {
    const { store, seeded } = await createActiveCompactionProgressFixture(t, `host-blocker-${kind}`);
    const run = store.getRun(seeded.runId);
    const attempt = store.getWorkUnitAttempt(seeded.attemptId);
    const sourceFence = toRuntimeAttemptFence(attempt);
    const policySnapshot = readStoredEffectivePolicySnapshot(run.requestSnapshot);
    const checkpoint = store.getLatestRunCompactionCheckpoint(run.id);
    const modelView = store.getArtifact(checkpoint.summaryArtifactId).sealedPayload.modelView;
    const source = { runId: run.id, ...sourceFence };
    assert.equal(assessRunCompactionRecovery({ store, run, sourceAttempt: attempt, policySnapshot }).kind, "verified");
    const ticket = store.admitHostOperation({ source, operationId: `pending-${kind}`, kind, toolCallId: `call-${kind}` });
    assert.equal(store.listHostOperationBlockers(source).length, 1);
    const assess = () => assessRunCompactionRecovery({ store, run, sourceAttempt: attempt, policySnapshot });
    const progress = () => commitRunCompactionProgress({ store, run, attempt, sourceFence, policySnapshot,
      modelView, activeToolCallIds: [] });
    assert.equal(assess().code, "checkpoint.effect_unknown");
    assert.deepEqual(progress(), { kind: "blocked", code: "checkpoint.effect_unknown" });
    assert.equal(store.getLatestRunCompactionCheckpoint(run.id).id, checkpoint.id);
    store.settleHostOperation(ticket, { kind: "known_no_start", settledAt: new Date().toISOString() });
    assert.equal(store.listHostOperationBlockers(source).length, 0);
    assert.equal(assess().kind, "verified");
    assert.equal(progress().kind, "not_needed");
    const unknown = store.admitHostOperation({ source, operationId: `unknown-${kind}`, kind, toolCallId: `unknown-call-${kind}` });
    store.settleHostOperation(unknown, { kind: "unknown_outcome", code: "controlled_transport_loss" });
    assert.equal(assess().code, "checkpoint.effect_unknown");
    assert.deepEqual(progress(), { kind: "blocked", code: "checkpoint.effect_unknown" });
    const reopened = createSqliteRunStore(store.paths.cwd);
    try {
      assert.equal(assessRunCompactionRecovery({ store: reopened, run, sourceAttempt: attempt, policySnapshot }).code,
        "checkpoint.effect_unknown");
    } finally { reopened.close(); }
  });
}

test("compaction recovery rejects drift, unknown effects and corrupted sealed evidence", async (t) => {
  const fixture = await createDaemonRecoveryCoordinatorFixture(t, "compaction-safety", "committed");
  const run = fixture.store.getRun(fixture.seeded.runId);
  const sourceAttempt = fixture.store.getWorkUnitAttempt(fixture.seeded.attemptId);
  const policySnapshot = readStoredEffectivePolicySnapshot(run.requestSnapshot);
  const assess = (store = fixture.store, policy = policySnapshot) => assessRunCompactionRecovery({
    store, run, sourceAttempt, policySnapshot: policy,
  });
  const override = (name, value) => new Proxy(fixture.store, {
    get(target, property) {
      if (property === name) return value;
      const original = target[property];
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
  assert.equal(assess().kind, "verified");
  assert.equal(assess(fixture.store, { ...policySnapshot, changedForTest: true }).code, "checkpoint.permission_drift");
  assert.equal(assess(override("getLatestWorkspaceProvenanceWatermark", () => "workspace_default:999")).code,
    "checkpoint.source_watermark_changed");
  assert.equal(assess(override("listHarnessToolExecutions", () => [{ state: "unknown_outcome" }])).code,
    "checkpoint.effect_unknown");
  const checkpoint = fixture.store.getLatestRunCompactionCheckpoint(run.id);
  const corruptSummary = override("getArtifact", (id) => {
    const artifact = fixture.store.getArtifact(id);
    return id === checkpoint.summaryArtifactId ? { ...artifact, sealedPayload: { summary: "corrupted after commit" } } : artifact;
  });
  assert.equal(assess(corruptSummary).code, "checkpoint.snapshot_unavailable");
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

async function seedRecoverableHarnessRun(cwd, suffix, withCompaction = false, surface = "task") {
  const store = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: `Harness recovery ${suffix}`, boundPath: cwd }, now);
  const channelId = surface === "task" || surface === "channel_discussion" ? channel.id : undefined;
  const task = surface === "task" ? store.createTask({
    channelId: channel.id, title: `Harness recovery ${suffix}`,
    prompt: "Continue the saved task after daemon restart.",
  }, now) : undefined;
  const taskSnapshot = { id: task?.id ?? `synthetic_task_${suffix}`, channelId,
    title: `Harness recovery ${suffix}`, prompt: "Continue the saved task after daemon restart." };
  const thread = store.createLingThread({
    kind: surface,
    channelId,
    taskId: task?.id,
    teammateId: surface === "teammate_direct" ? "teammate_builtin_engineer" : undefined,
    title: taskSnapshot.title,
    objective: taskSnapshot.prompt,
  }, now);
  const turn = store.createLingTurn({
    threadId: thread.id,
    kind: "initial_request",
    title: taskSnapshot.title,
    userInstruction: taskSnapshot.prompt,
    channelId,
    taskId: taskSnapshot.id,
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
    kind: surface === "task" ? "task_run" : surface === "conversation" ? "conversation_run"
      : surface === "teammate_direct" ? "teammate_direct_reply" : "channel_ai_reply",
    ownerType: surface === "task" ? "task" : surface === "conversation" ? "conversation_turn"
      : surface === "teammate_direct" ? "teammate_direct_message" : "channel_message",
    ownerId: task?.id ?? turn.id,
    channelId,
    taskId: taskSnapshot.id,
    teammateId: surface === "teammate_direct" ? "teammate_builtin_engineer" : undefined,
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
    taskId: taskSnapshot.id,
    channelId,
    teammateId: surface === "teammate_direct" ? "teammate_builtin_engineer" : undefined,
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
  if (task) assert.equal(store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim",
    actor: "system", reason: `run:${run.id}`, now }).ok, true);
  const fence = { workUnitId: workUnit.id, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId,
    fencingToken: attempt.fencingToken };
  assert.equal(store.transitionWorkUnitStatus({ ...fence, activeAttemptId: attempt.id, expectedStatus: "queued",
    event: "claim", actor: "system", now }).ok, true);
  assert.equal(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started",
    actor: "runner", now }).ok, true);
  assert.ok(store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now, startedAt: now }));
  if (withCompaction) {
    const artifact = store.createArtifact({ runId: run.id, type: "json", path: "pre-compaction.json",
      contentType: "application/vnd.ling.pi-compaction-context+json",
      sealedPayload: { schemaVersion: 1, boundary: "pi-compaction-context", runId: run.id,
        attemptId: attempt.id, contextViewId: run.contextViewId, model: run.providerModel,
        capturedAt: now, messages: [] }, createdAt: now });
    const start = store.appendExecutionEvent(run.id, fence, "context_compaction_start", {
      reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", attemptId: attempt.id,
      checkpointArtifactId: artifact.id,
    });
    if (withCompaction === "committed" || withCompaction === "tool_result" || withCompaction === "progress") {
      const summary = store.createArtifact({ runId: run.id, type: "json", path: "compaction-summary.json",
        contentType: "application/vnd.ling.run-compaction-summary+json",
        sealedPayload: { schemaVersion: 1, boundary: "run-compaction-summary", runId: run.id,
          attemptId: attempt.id, sourceEventSeq: start.seq, summary: "Host-approved compacted view",
          modelView: withCompaction === "tool_result" ? [
            { role: "compactionSummary", summary: "Host-approved compacted view" },
            { role: "user", content: [{ type: "text", text: preparedInput.userPrompt }], timestamp: 0 },
            { role: "assistant", content: [{ type: "toolCall", id: "before-restart", name: "read", arguments: {} }] },
            { role: "toolResult", toolCallId: "before-restart", toolName: "read",
              content: [{ type: "text", text: "Prior read already completed" }], isError: false },
          ] : [
            { role: "compactionSummary", summary: "Host-approved compacted view" },
            { role: "user", content: [{ type: "text", text: preparedInput.userPrompt }], timestamp: 0 },
            { role: "assistant", content: [{ type: "text", text: "The task was already completed before restart." }], stopReason: "stop" },
          ] }, createdAt: now });
      const checkpoint = store.createRunCompactionCheckpoint({
        runId: run.id, attemptId: attempt.id, sourceEventSeq: start.seq,
        contextSnapshotArtifactId: artifact.id, summaryArtifactId: summary.id,
        summaryContentSha256: summary.contentSha256, contextViewId: run.contextViewId,
        providerName: run.providerName, providerModel: run.providerModel,
        policyVersion: "pi_sdk_lifecycle_v1",
        policySnapshotFingerprint: runnerPolicySnapshotFingerprint(effectivePolicySnapshot),
        workspaceProvenanceWatermark: store.getLatestWorkspaceProvenanceWatermark(),
        objective: taskSnapshot.prompt, createdAt: now,
      });
      assert.equal(store.transitionRunCompactionCheckpoint({ id: checkpoint.id, expectedRevision: 0,
        state: "committed", now })?.state, "committed");
    }
    store.appendExecutionEvent(run.id, fence, "context_compaction_end", {
      reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", attemptId: attempt.id,
      outcome: "sdk_installed", willRetry: false,
    });
    if (withCompaction === "progress") {
      store.appendEvent(run.id, "tool_start", { toolCallId: "already-done", toolName: "read", args: {} });
      store.appendEvent(run.id, "tool_end", { toolCallId: "already-done", toolName: "read", isError: false,
        result: { content: [{ type: "text", text: "already completed before crash" }] } });
      const prior = store.getLatestRunCompactionCheckpoint(run.id);
      const oldView = store.getArtifact(prior.summaryArtifactId).sealedPayload.modelView;
      const activeStore = new Proxy(store, { get(target, property) {
        if (property === "isCurrentRunExecutionOwner") return () => true;
        if (property === "findRequiredUserInputForAttempt") return () => undefined;
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const result = commitRunCompactionProgress({ store: activeStore, run, attempt, sourceFence: fence,
        policySnapshot: effectivePolicySnapshot, activeToolCallIds: [],
        modelView: [...oldView,
          { role: "assistant", content: [{ type: "toolCall", id: "already-done", name: "read", arguments: {} }] },
          { role: "toolResult", toolCallId: "already-done", toolName: "read",
            content: [{ type: "text", text: "already completed before crash" }] }],
      });
      assert.equal(result.kind, "committed", JSON.stringify(result));
    }
    const checkpoint = store.getLatestRunCompactionCheckpoint(run.id);
    if (checkpoint) {
      // This fixture explicitly owns its synthetic source and completed read
      // inventory. It cannot borrow drain/effect proof from the replacement.
      const toolCallIds = withCompaction === "tool_result" ? ["before-restart"]
        : withCompaction === "progress" ? ["already-done"] : [];
      assert.equal(typeof store.sealHostCompactionResourceBoundary({
        source: { runId: run.id, ...fence }, checkpointId: checkpoint.id,
        inventory: { schemaVersion: 1, toolCallIds,
          settledBuiltinReads: toolCallIds.map(toolCallId => ({ toolCallId, toolName: "read" })) },
        now: new Date().toISOString(),
      }), "string", "the explicitly constructed checkpoint must seal its own Host boundary before restart");
    }
  }
  store.transitionLingTurnStatus({ turnId: turn.id, expectedStatus: "open", event: "start", actor: "system", now });
  store.updateLingThread(thread.id, { status: "running", activeRunId: run.id, lastRunId: run.id }, now);
  store.close();
  return { runId: run.id, workUnitId: workUnit.id, attemptId: attempt.id, presetId: preset.id };
}

async function createDaemonRecoveryCoordinatorFixture(t, suffix, withCompaction = false, surface = "task") {
  const cwd = await mkdtemp(join(tmpdir(), `ling-harness-recovery-coordinator-${suffix}-`));
  const seeded = await seedRecoverableHarnessRun(cwd, suffix, withCompaction, surface);
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

/** Crash only a nonce/PID/path-verified owned worker after durable Host settlement. */
async function createA21CrashedDaemonRecoveryFixture(t, checkpointFault) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a21-noncompacted-workspace-"));
  const ambient = await mkdtemp(join(tmpdir(), "ling-a21-noncompacted-ambient-"));
  const lingHome = join(ambient, "home");
  await mkdir(lingHome);
  const scriptPath = fileURLToPath(new URL("./support/noncompacted-recovery-crash-worker.mjs", import.meta.url));
  const nonce = randomUUID();
  const markerPath = join(cwd, "a21-effect-marker.txt");
  const child = fork(scriptPath, [JSON.stringify({ cwd, markerPath, nonce, toolCallId: `a21-bash-${nonce}`, checkpointFault })],
    { cwd, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LING_STACK_HOME: lingHome,
      LING_STACK_DEFAULT_WORKSPACE_CWD: cwd,
    } });
  const messages = [];
  const output = [];
  let childError;
  let childExit;
  child.on("message", (message) => messages.push(message));
  child.on("error", (error) => { childError = error; });
  child.on("exit", (code, signal) => { childExit = { code, signal }; });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  let stores;
  let supervisor;
  t.after(async () => {
    // This is always the child object this fixture forked, never a queried App PID.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForCondition(() => childExit !== undefined, "owned worker cleanup did not observe exit", 5_000);
    }
    supervisor?.releaseAll();
    stores?.closeAll();
    await rm(cwd, { recursive: true, force: true });
    await rm(ambient, { recursive: true, force: true });
  });
  try {
    await waitForCondition(() => messages.some((message) => message?.kind === "a21_settled_before_provider_request"
      || message?.kind === "a21_fixture_error") || childError || childExit,
    "the real owned SDK worker did not reach its settled crash boundary", 15_000);
  } catch (error) {
    assert.fail(JSON.stringify({ cause: error instanceof Error ? error.message : String(error),
      messages, output: output.join("").slice(-8_000), childError: childError?.message, childExit }));
  }
  const source = messages.find((message) => message?.kind === "a21_settled_before_provider_request");
  assert.ok(source, JSON.stringify({ messages, output, childError: childError?.message, childExit }));
  const started = messages.find((message) => message?.kind === "a21_worker_started");
  for (const owned of [started, source]) {
    assert.equal(owned?.nonce, nonce);
    assert.equal(owned?.pid, child.pid);
    assert.equal(owned?.cwd, cwd);
    assert.equal(owned?.scriptPath, scriptPath);
  }
  assert.equal(source.markerPath, markerPath);
  assert.equal(source.hostFailed, Boolean(checkpointFault), JSON.stringify({ hostError: source.hostError }));
  if (checkpointFault) assert.equal(source.hostError?.code, "checkpoint.commit_failed",
    `the real Host callback must observe the injected Core commit failure: ${JSON.stringify(source.hostError)}`);
  else assert.equal(source.hostError, undefined, "the source Host callback must have succeeded before the pure crash");
  const observed = createSqliteRunStore(cwd);
  let sourceAuthorityTables;
  try {
    assert.equal(observed.getRun(source.runId)?.status, "running");
    assert.deepEqual(readA21SettledCommand(observed, source.runId, source.toolCallId), source.settlement,
      "a second SQLite connection must read the actual completed dedicated journal and tool_end before crash");
    assert.equal(observed.listHostCommandWriteBlockers(cwd).length, 0);
    assert.equal(observed.getLatestRunCompactionStart(source.runId), undefined);
    assert.equal(observed.getLatestRunCompactionCheckpoint(source.runId), undefined);
    const authorityDatabase = new DatabaseSync(observed.paths.databasePath, { readOnly: true });
    try {
      sourceAuthorityTables = authorityDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('run_progress_checkpoints', 'run_progress_checkpoint_heads') ORDER BY name")
        .all().map((row) => row.name);
      assert.deepEqual(sourceAuthorityTables, ["run_progress_checkpoint_heads", "run_progress_checkpoints"]);
      const count = (table) => Number(authorityDatabase.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`)
        .get(source.runId).n);
      assert.equal(count("run_progress_checkpoints"), checkpointFault ? 0 : 1);
      assert.equal(count("run_progress_checkpoint_heads"), checkpointFault ? 0 : 1);
      assert.equal(observed.listArtifacts(source.runId).filter(artifact =>
        artifact.contentType === "application/vnd.ling.run-progress-model-view+json").length, checkpointFault ? 0 : 1,
      "a final-head failure must atomically roll back the sealed artifact as well");
    } finally { authorityDatabase.close(); }
    const run = observed.getRun(source.runId);
    const assessment = observed.readRunProgressCheckpointForRecovery({ runId: run.id,
      sourceFence: toRuntimeAttemptFence(observed.getWorkUnitAttempt(source.attemptId)),
      expectedLineage: captureRunProgressCheckpointLineage(observed, run).lineage });
    if (checkpointFault) assert.deepEqual(assessment, { kind: "blocked", code: "checkpoint.missing" });
    else {
      assert.equal(assessment.kind, "verified", JSON.stringify(assessment));
      assert.deepEqual(assessment.modelView, source.modelView);
      assert.equal(assessment.checkpoint.sourceEventSeq, source.settlement.sourceEventSeq);
      assert.equal(assessment.witness.headRevision, 1);
    }
  } finally { observed.close(); }
  assert.equal(await readFile(markerPath, "utf8"), "a21-effect\n");
  assert.equal(child.connected, true);
  assert.equal(childExit, undefined);
  assert.equal(child.kill("SIGKILL"), true, "only the verified dedicated worker may be crashed");
  await waitForCondition(() => childExit !== undefined, "the owned worker crash was not observed", 5_000);
  assert.equal(childExit.signal, "SIGKILL");
  stores = new RunStoreRegistry(createSqliteRunStore);
  supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } } }));
  const activeRuns = new ActiveRunRegistry();
  const store = stores.getStore(cwd);
  supervisor.getRuntime(cwd, store);
  return { cwd, ambient, source, sourceAuthorityTables, stores, supervisor, activeRuns, store };
}

async function createActiveCompactionProgressFixture(t, suffix) {
  const cwd = await mkdtemp(join(tmpdir(), `ling-harness-progress-${suffix}-`));
  const seeded = await seedRecoverableHarnessRun(cwd, suffix, "committed");
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, seeded, store };
}

async function waitForCondition(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(message);
}
