import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  captureRunnerContinuationReplayPackage,
  captureRunnerNativeResumeHandle,
  createRunnerContinuationReplayArtifact,
  createRunnerNativeResumeHandleArtifact,
  createRunnerRegistry,
  executeRunnerContinuationReconstruction,
  RunnerNativeResumeRejectedError,
  runnerPolicySnapshotFingerprint,
} from "../dist/index.js";
import {
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  resolveRuntimePaths,
  toRuntimeAttemptFence,
} from "../../core/dist/index.js";

const now = "2026-09-13T00:00:00.000Z";
const later = "2026-09-13T00:01:00.000Z";
const expires = "2026-09-13T00:05:00.000Z";
const policy = {
  mode: "workspace_write",
  authorizationMode: "smart",
  workspaceAccessMode: "workspace_write",
  toolDecisions: { read: "allow", grep: "allow", find: "allow", ls: "allow", bash: "ask", edit: "ask", write: "ask" },
  allowedWritePaths: [],
  workspacePolicyUpdatedAt: now,
  riskNotes: [],
};

async function fixture(t, runnerId, capabilityRevision) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-harness-reconstruction-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "Harness reconstruction", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Resume safely", prompt: "Continue from immutable evidence." }, now);
  const sourceUnit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "source-run", idempotencyKey: "source-unit", status: "succeeded", createdByActor: "system",
    runnerId, effectiveRunnerId: runnerId, request: {}, now });
  const sourceAttempt = store.createWorkUnitAttempt({ id: "attempt-source", workUnitId: sourceUnit.id, attemptNumber: 1,
    runtimeInstanceId: "runtime-source", runnerId, effectiveRunnerId: runnerId, status: "succeeded", now });
  const sourceRun = store.createRun({ id: "source-run", cwd, taskId: task.id, workUnitId: sourceUnit.id,
    providerName: "test", providerModel: "test-model", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {},
    contextViewId: "context-source", contextViewCreatedAt: now, createdAt: now });
  store.linkRunToWorkUnit(sourceRun.id, sourceUnit.id, now);
  store.markRunSucceeded(sourceRun.id, now);

  const targetUnit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "target-run", idempotencyKey: "target-unit", status: "queued", createdByActor: "system",
    runnerId, effectiveRunnerId: runnerId, request: {}, now });
  const targetRun = store.createRun({ id: "target-run", cwd, taskId: task.id, workUnitId: targetUnit.id,
    parentRunId: sourceRun.id, providerName: "test", providerModel: "test-model", taskSnapshot: task,
    providerSnapshot: {}, requestSnapshot: {}, contextViewId: "context-target", contextViewCreatedAt: now, createdAt: now });
  store.linkRunToWorkUnit(targetRun.id, targetUnit.id, now);

  const execution = preparedExecution(runnerId, cwd, task);
  const replayPackage = captureRunnerContinuationReplayPackage({
    runId: targetRun.id,
    rootRunId: sourceRun.id,
    workUnitId: targetUnit.id,
    sourceRunId: sourceRun.id,
    sourceWorkUnitId: sourceUnit.id,
    origin: "queued_followup",
    workspaceCwd: cwd,
    contextViewId: "context-target",
    contextProjectionVersion: "continuity-v2:test",
    contextSourceRefs: [{ type: "run", id: sourceRun.id }, { type: "context_snapshot", id: "context-target" }],
    sourceAttempt,
    runnerId,
    runnerCapabilityRevision: capabilityRevision,
    policySnapshot: policy,
    execution,
    assistantEvidence: [{ itemId: "assistant-source", text: "The durable fact is in the artifact." }],
    toolEvidence: [{ actionId: "action-read", toolCallId: "tool-read", status: "succeeded", resultArtifactIds: [] }],
    artifactRefs: [],
  });
  const replayArtifact = createRunnerContinuationReplayArtifact({ store, replayPackage, artifactId: "artifact-replay", createdAt: now });
  const baseContinuation = {
    id: "continuation-target",
    runId: targetRun.id,
    workUnitId: targetUnit.id,
    sourceFence: toRuntimeAttemptFence(sourceAttempt),
    expectedTargetAttemptId: null,
    origin: "queued_followup",
    strategy: "deterministic_replay",
    runnerId,
    runnerCapabilityRevision: capabilityRevision,
    contextViewId: "context-target",
    contextSnapshotArtifactId: replayArtifact.id,
    idempotencyKey: "continuation:target",
    generation: 0,
    targetAttempt: { id: "attempt-target", runtimeInstanceId: "runtime-target", runnerId, effectiveRunnerId: runnerId },
    now,
  };
  return {
    cwd, get store() { return store; }, set store(value) { store = value; }, task, sourceRun, sourceUnit, sourceAttempt,
    targetRun, targetUnit, replayPackage, baseContinuation,
  };
}

test("deterministic replay uses the identical SQLite-sealed package after daemon reopen", async (t) => {
  const f = await fixture(t, "pi", "pi:0.1.0:resume-v1");
  const prepared = f.store.prepareContinuationAndAttempt(f.baseContinuation);
  const observations = [];
  const runner = registeredRunner("pi", "pi:0.1.0:resume-v1", {
    async runTask(options) {
      observations.push({ prepared: options.preparedInput.fingerprint, prompt: options.task.prompt,
        runId: options.runId, attemptId: options.runnerAttemptId });
      return { taskId: options.task.id, events: [], messages: ["replayed"] };
    },
  }, false);
  const first = await executeRunnerContinuationReconstruction({ store: f.store, continuation: prepared.continuation,
    runner, targetFence: toRuntimeAttemptFence(prepared.attempt), workspaceCwd: f.cwd, policySnapshot: policy,
    liveOptions: liveOptions(f) });
  assert.equal(first.ok, true);
  assert.equal(first.strategy, "deterministic_replay");
  assert.equal(first.replayFingerprint, f.replayPackage.fingerprint);
  assert.equal(JSON.stringify(f.replayPackage).includes("runtime-only-key"), false);

  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  const persisted = f.store.getRunnerContinuation(prepared.continuation.id);
  const second = await executeRunnerContinuationReconstruction({ store: f.store, continuation: persisted,
    runner, targetFence: toRuntimeAttemptFence(f.store.getWorkUnitAttempt(prepared.attempt.id)), workspaceCwd: f.cwd,
    policySnapshot: policy, liveOptions: liveOptions(f) });
  assert.equal(second.ok, true);
  assert.equal(second.replayFingerprint, first.replayFingerprint);
  assert.deepEqual(observations[0], observations[1]);
});

test("verified native resume receives target fencing, abort and Host approval bridge", async (t) => {
  const revision = "native-test:resume-v1";
  const f = await fixture(t, "native-test", revision);
  const handle = captureRunnerNativeResumeHandle({ sourceRunId: f.sourceRun.id, rootRunId: f.sourceRun.id,
    sourceWorkUnitId: f.sourceUnit.id, sourceAttemptId: f.sourceAttempt.id, workspaceCwd: f.cwd,
    runnerId: "native-test", runnerCapabilityRevision: revision,
    policySnapshotFingerprint: runnerPolicySnapshotFingerprint(policy), opaqueHandle: "session-opaque-1", issuedAt: now });
  const handleArtifact = createRunnerNativeResumeHandleArtifact({ store: f.store, handle, artifactId: "artifact-handle" });
  const prepared = f.store.prepareContinuationAndAttempt({ ...f.baseContinuation, strategy: "native_resume",
    runnerHandleRef: handleArtifact.id });
  const approvals = [];
  const controller = new AbortController();
  const runner = registeredRunner("native-test", revision, {
    async runTask() { throw new Error("deterministic fallback was not expected"); },
    async resumeTask(input) {
      assert.equal(input.schemaVersion, 1);
      assert.equal(input.handleRef, "session-opaque-1");
      assert.equal(input.attemptId, prepared.attempt.id);
      assert.equal(input.options.signal, controller.signal);
      const approval = await input.options.onApprovalRequired({ toolCallId: "tool-1", toolName: "bash",
        input: { command: "pwd" }, task: input.options.task, cwd: input.options.cwd, defaultApproval: "ask" });
      approvals.push(approval);
      return { taskId: input.options.task.id, events: [], messages: ["native"] };
    },
  }, true);
  const result = await executeRunnerContinuationReconstruction({ store: f.store, continuation: prepared.continuation,
    runner, targetFence: toRuntimeAttemptFence(prepared.attempt), workspaceCwd: f.cwd, policySnapshot: policy,
    liveOptions: { ...liveOptions(f), signal: controller.signal,
      onApprovalRequired: async () => ({ approved: true, approvalId: "approval-host" }) } });
  assert.equal(result.ok, true);
  assert.equal(result.strategy, "native_resume");
  assert.deepEqual(approvals, [{ approved: true, approvalId: "approval-host" }]);
});

test("native rejection falls back once through one durable replay generation", async (t) => {
  const revision = "native-reject:resume-v1";
  const f = await fixture(t, "native-reject", revision);
  const handle = captureRunnerNativeResumeHandle({ sourceRunId: f.sourceRun.id, rootRunId: f.sourceRun.id,
    sourceWorkUnitId: f.sourceUnit.id, sourceAttemptId: f.sourceAttempt.id, workspaceCwd: f.cwd,
    runnerId: "native-reject", runnerCapabilityRevision: revision,
    policySnapshotFingerprint: runnerPolicySnapshotFingerprint(policy), opaqueHandle: "rejected-session", issuedAt: now });
  const handleArtifact = createRunnerNativeResumeHandleArtifact({ store: f.store, handle });
  const prepared = f.store.prepareContinuationAndAttempt({ ...f.baseContinuation, strategy: "native_resume",
    runnerHandleRef: handleArtifact.id });
  const fence = toRuntimeAttemptFence(prepared.attempt);
  assert.equal(f.store.claimRunnerContinuation({ continuationId: prepared.continuation.id, expectedRevision: 0,
    claimOwner: "daemon", claimToken: "claim-reject", claimExpiresAt: expires, now }).ok, true);
  assert.equal(f.store.startRunnerContinuation({ continuationId: prepared.continuation.id, expectedRevision: 1,
    claimOwner: "daemon", claimToken: "claim-reject", targetFence: fence, now }).ok, true);
  let replayCount = 0;
  const runner = registeredRunner("native-reject", revision, {
    async runTask(options) {
      replayCount += 1;
      return { taskId: options.task.id, events: [], messages: ["fallback"] };
    },
    async resumeTask() { throw new RunnerNativeResumeRejectedError("continuation.handle_rejected"); },
  }, true);
  const rejected = await executeRunnerContinuationReconstruction({ store: f.store,
    continuation: f.store.getRunnerContinuation(prepared.continuation.id), runner, targetFence: fence,
    workspaceCwd: f.cwd, policySnapshot: policy, liveOptions: liveOptions(f) });
  assert.deepEqual(rejected, { ok: false, failureCode: "continuation.handle_rejected", fallbackAllowed: true });
  const pending = f.store.finishRunnerContinuation({ continuationId: prepared.continuation.id, expectedRevision: 2,
    claimOwner: "daemon", claimToken: "claim-reject", targetFence: fence, nextState: "recovery_pending",
    failureCode: rejected.failureCode, now: later });
  assert.equal(pending.ok, true);
  const replayPrepared = f.store.reprepareContinuationAndAttempt({ continuationId: prepared.continuation.id,
    expectedRevision: 3, expectedGeneration: 0, claimOwner: "daemon", claimToken: "claim-reject",
    abandonedTargetFence: fence, targetAttempt: { id: "attempt-target-replay", runtimeInstanceId: "runtime-target-replay",
      runnerId: "native-reject", effectiveRunnerId: "native-reject" }, now: later });
  assert.equal(replayPrepared.continuation.strategy, "deterministic_replay");
  const replayed = await executeRunnerContinuationReconstruction({ store: f.store, continuation: replayPrepared.continuation,
    runner, targetFence: toRuntimeAttemptFence(replayPrepared.attempt), workspaceCwd: f.cwd, policySnapshot: policy,
    liveOptions: liveOptions(f) });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.strategy, "deterministic_replay");
  assert.equal(replayCount, 1);

  const repeatedNative = await executeRunnerContinuationReconstruction({ store: f.store,
    continuation: { ...replayPrepared.continuation, strategy: "native_resume" }, runner,
    targetFence: toRuntimeAttemptFence(replayPrepared.attempt), workspaceCwd: f.cwd, policySnapshot: policy,
    liveOptions: liveOptions(f) });
  assert.deepEqual(repeatedNative, { ok: false, failureCode: "continuation.handle_rejected", fallbackAllowed: false });
});

test("unverified native resume fails closed before invoking the adapter", async (t) => {
  const revision = "native-unverified:resume-v1";
  const f = await fixture(t, "native-unverified", revision);
  const prepared = f.store.prepareContinuationAndAttempt({ ...f.baseContinuation, strategy: "native_resume",
    runnerHandleRef: "missing-handle" });
  let resumeCalls = 0;
  const runner = createRunnerRegistry([{ id: "native-unverified", displayName: "Unverified", status: "enabled",
    adapter: { async runTask() { throw new Error("not expected"); }, async resumeTask() { resumeCalls += 1; throw new Error("not expected"); } },
    resumeCapabilities: { nativeResume: true, hostApprovalContinuation: [] },
    nativeResumeConformance: { revision, readinessPassed: true, conformancePassed: false,
      abortPropagationVerified: false, approvalBridgeVerified: false } }]).list()[0];
  const result = await executeRunnerContinuationReconstruction({ store: f.store, continuation: prepared.continuation,
    runner, targetFence: toRuntimeAttemptFence(prepared.attempt), workspaceCwd: f.cwd, policySnapshot: policy,
    liveOptions: liveOptions(f) });
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, "continuation.runner_not_conformant");
  assert.equal(result.fallbackAllowed, true);
  assert.equal(result.blockers.includes("resume_conformance_not_passed"), true);
  assert.equal(resumeCalls, 0);
});

test("foreign native handle lineage falls back without reaching the runner", async (t) => {
  const revision = "native-foreign:resume-v1";
  const f = await fixture(t, "native-foreign", revision);
  const handle = captureRunnerNativeResumeHandle({ sourceRunId: f.sourceRun.id, rootRunId: f.sourceRun.id,
    sourceWorkUnitId: f.sourceUnit.id, sourceAttemptId: f.sourceAttempt.id, workspaceCwd: f.cwd,
    runnerId: "native-foreign", runnerCapabilityRevision: revision,
    policySnapshotFingerprint: "foreign-policy-fingerprint", opaqueHandle: "foreign-session", issuedAt: now });
  const artifact = createRunnerNativeResumeHandleArtifact({ store: f.store, handle });
  const prepared = f.store.prepareContinuationAndAttempt({ ...f.baseContinuation, strategy: "native_resume",
    runnerHandleRef: artifact.id });
  let calls = 0;
  const runner = registeredRunner("native-foreign", revision, {
    async runTask() { throw new Error("not expected"); },
    async resumeTask() { calls += 1; throw new Error("not expected"); },
  }, true);
  const result = await executeRunnerContinuationReconstruction({ store: f.store, continuation: prepared.continuation,
    runner, targetFence: toRuntimeAttemptFence(prepared.attempt), workspaceCwd: f.cwd, policySnapshot: policy,
    liveOptions: liveOptions(f) });
  assert.deepEqual(result, { ok: false, failureCode: "continuation.handle_rejected", fallbackAllowed: true });
  assert.equal(calls, 0);
});

test("stale native handle capability revision falls back without reaching the runner", async (t) => {
  const revision = "native-current:resume-v2";
  const f = await fixture(t, "native-current", revision);
  const handle = captureRunnerNativeResumeHandle({ sourceRunId: f.sourceRun.id, rootRunId: f.sourceRun.id,
    sourceWorkUnitId: f.sourceUnit.id, sourceAttemptId: f.sourceAttempt.id, workspaceCwd: f.cwd,
    runnerId: "native-current", runnerCapabilityRevision: "native-current:resume-v1",
    policySnapshotFingerprint: runnerPolicySnapshotFingerprint(policy), opaqueHandle: "stale-session", issuedAt: now });
  const artifact = createRunnerNativeResumeHandleArtifact({ store: f.store, handle });
  const prepared = f.store.prepareContinuationAndAttempt({ ...f.baseContinuation, strategy: "native_resume",
    runnerHandleRef: artifact.id });
  let calls = 0;
  const runner = registeredRunner("native-current", revision, {
    async runTask() { throw new Error("not expected"); },
    async resumeTask() { calls += 1; throw new Error("not expected"); },
  }, true);
  const result = await executeRunnerContinuationReconstruction({ store: f.store, continuation: prepared.continuation,
    runner, targetFence: toRuntimeAttemptFence(prepared.attempt), workspaceCwd: f.cwd, policySnapshot: policy,
    liveOptions: liveOptions(f) });
  assert.deepEqual(result, { ok: false, failureCode: "continuation.handle_rejected", fallbackAllowed: true });
  assert.equal(calls, 0);
});

test("aborted reconstruction never enters deterministic or native runner code", async (t) => {
  const f = await fixture(t, "pi", "pi:0.1.0:resume-v1");
  const prepared = f.store.prepareContinuationAndAttempt(f.baseContinuation);
  let calls = 0;
  const runner = registeredRunner("pi", "pi:0.1.0:resume-v1", {
    async runTask() { calls += 1; throw new Error("not expected"); },
  }, false);
  const controller = new AbortController();
  controller.abort(new Error("cancelled-before-replay"));
  await assert.rejects(() => executeRunnerContinuationReconstruction({ store: f.store,
    continuation: prepared.continuation, runner, targetFence: toRuntimeAttemptFence(prepared.attempt),
    workspaceCwd: f.cwd, policySnapshot: policy, liveOptions: { ...liveOptions(f), signal: controller.signal } }),
  /cancelled-before-replay/u);
  assert.equal(calls, 0);
});

test("replay capture rejects credential-like content instead of persisting it", async (t) => {
  const f = await fixture(t, "pi", "pi:0.1.0:resume-v1");
  assert.throws(() => captureRunnerContinuationReplayPackage({
    runId: f.targetRun.id, rootRunId: f.sourceRun.id, workUnitId: f.targetUnit.id,
    sourceRunId: f.sourceRun.id, sourceWorkUnitId: f.sourceUnit.id, origin: "queued_followup",
    workspaceCwd: f.cwd, contextViewId: "context-target", contextProjectionVersion: "continuity-v2:test",
    contextSourceRefs: [], sourceAttempt: f.sourceAttempt, runnerId: "pi",
    runnerCapabilityRevision: "pi:0.1.0:resume-v1", policySnapshot: policy,
    execution: preparedExecution("pi", f.cwd, f.task),
    assistantEvidence: [{ itemId: "unsafe", text: "credential sk-1234567890-secret" }],
  }), /contains secret material/u);
});

test("replay reconstruction rejects an artifact whose outer digest was recomputed after payload tampering", async (t) => {
  const f = await fixture(t, "pi", "pi:0.1.0:resume-v1");
  const prepared = f.store.prepareContinuationAndAttempt(f.baseContinuation);
  const tampered = structuredClone(f.replayPackage);
  tampered.contextProjectionVersion = "continuity-v2:tampered";
  const database = new DatabaseSync(resolveRuntimePaths(f.cwd).databasePath);
  try {
    database.prepare(`
      UPDATE artifacts
      SET sealed_payload_json = ?, content_sha256 = ?
      WHERE id = ?
    `).run(JSON.stringify(tampered), hash(tampered), f.baseContinuation.contextSnapshotArtifactId);
  } finally {
    database.close();
  }
  let calls = 0;
  const runner = registeredRunner("pi", "pi:0.1.0:resume-v1", {
    async runTask() { calls += 1; throw new Error("not expected"); },
  }, false);
  await assert.rejects(() => executeRunnerContinuationReconstruction({ store: f.store,
    continuation: prepared.continuation, runner, targetFence: toRuntimeAttemptFence(prepared.attempt),
    workspaceCwd: f.cwd, policySnapshot: policy, liveOptions: liveOptions(f) }),
  (error) => error?.code === "continuation.context_snapshot_missing");
  assert.equal(calls, 0);
});

function registeredRunner(id, revision, adapter, nativeResume) {
  return createRunnerRegistry([{ id, displayName: id, status: "enabled", adapter,
    resumeCapabilities: { nativeResume, hostApprovalContinuation: [] },
    nativeResumeConformance: { revision, readinessPassed: true, conformancePassed: true,
      abortPropagationVerified: true, approvalBridgeVerified: true } }]).list()[0];
}

function liveOptions(f) {
  return {
    cwd: f.cwd,
    task: f.task,
    provider: { provider: "test", model: "test-model", api: "openai-responses", apiKey: "runtime-only-key" },
  };
}

function preparedExecution(runnerId, cwd, task) {
  const preparedBody = {
    schemaVersion: 1,
    boundary: "pi-model-context",
    taskId: task.id,
    systemPrompt: "System instructions",
    userPrompt: `Channel: ${task.channelId}\n\nTask: ${task.title}\n\n${task.prompt}`,
    model: { id: "test-model", provider: "test", api: "openai-responses" },
    thinkingLevel: "medium",
    tools: [],
  };
  const preparedInput = { ...preparedBody, fingerprint: hash(preparedBody) };
  return {
    schemaVersion: 1,
    runnerId,
    input: {
      cwd,
      task,
      provider: { provider: "test", model: "test-model", api: "openai-responses" },
      systemPrompt: "System instructions",
    },
    toolHydrationEnabled: false,
    preparedInput,
  };
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
