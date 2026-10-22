import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyConversationModeToEffectiveRunPolicySnapshot, captureRunProgressCheckpointLineage, createSqliteRunStore,
  delegationPreparedExecutionDigest, resolveSessionRunPolicy, toRuntimeAttemptFence,
} from "@ling-stack/core";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { createDelegatedRunDispatchAuthority } from "../dist/features/harness/delegations/delegated-run-dispatch.js";
import { assessDelegatedRunRecovery } from "../dist/features/harness/delegations/delegated-run-recovery.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

const createdAt = "2026-10-20T00:00:01.000Z", preparedAt = "2026-10-20T00:00:02.000Z";
const stoppedAt = "2026-10-20T00:00:03.000Z", resumedAt = "2026-10-20T00:00:04.000Z";
const at = "2026-10-20T00:00:05.000Z";

/**
 * Helper/parser contract test. The Core checkpoint reader is an explicit stub;
 * Core delegation-binding transaction tests and orchestrator tests separately
 * prove its persisted authority. SDK preparation and restored Session are real.
 */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegated-recovery-"));
  const policyStore = createSqliteRunStore(cwd);
  t.after(async () => { policyStore.close(); await rm(cwd, { recursive: true, force: true }); });
  const runner = new ToolFreePiRunner();
  const provider = { provider: "delegated-recovery-fixture", model: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", reasoning: false };
  const task = { id: "child-task", title: "Recover read", prompt: "Report the already completed read without executing it again." };
  const options = { cwd, agentDir: join(cwd, "agent"), task, provider, tools: ["read"], thinkingLevel: "off",
    initialToolSurface: { mediaGeneration: false, toolHydration: false, userInput: false } };
  const preparedInput = await runner.prepareTaskInput(options);
  const execution = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
  const workspacePolicy = policyStore.getApprovalPolicy();
  const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({ workspacePolicy,
    authorizationMode: "smart", workspaceAccessMode: "workspace_write", channelBoundPath: cwd }).snapshot, "default");
  const first = { id: "attempt-1", workUnitId: "child-unit", attemptNumber: 1, runtimeInstanceId: "runtime-1",
    fencingToken: "1", runnerId: "pi", effectiveRunnerId: "pi", status: "created", createdAt };
  const run = { id: "child", workUnitId: first.workUnitId, parentRunId: "root", threadId: "thread", cwd,
    taskId: task.id, taskSnapshot: task, providerName: provider.provider, providerModel: provider.model,
    status: "queued", contextViewId: "frozen-context", contextViewCreatedAt: preparedAt };
  const unit = { id: first.workUnitId, workspaceId: workspacePolicy.workspaceId, linkedRunId: run.id,
    activeAttemptId: first.id, status: "claimed", ownerType: "delegation_step", ownerId: "step" };
  const step = { id: "step", state: "spawning", rootRunId: "root", parentRunId: "root" };
  const child = { run, workUnit: unit, attempt: first, step, replayed: false,
    reservation: { id: "reservation", state: "reserved", deadlineAt: "2026-10-20T01:00:00.000Z" } };
  const request = { cwd, task, parentRunId: "root", threadId: run.threadId, provider,
    runnerId: "pi", tools: ["read"], authorizationMode: "smart", workspaceAccessMode: "workspace_write" };
  const authority = createDelegatedRunDispatchAuthority();
  const token = authority.capturePreparation({ child, request, execution, policy, now: preparedAt });
  const payload = authority.readExecutionPreparation(token), digest = delegationPreparedExecutionDigest(payload);
  const artifact = { id: "preparation", runId: run.id, type: "json", path: "sqlite:delegation-execution",
    sealedPayload: payload, contentSha256: digest };
  const prepared = { artifactId: artifact.id, digest, payload };
  Object.assign(first, { status: "cancelled", abortRequestedAt: stoppedAt, endedAt: stoppedAt, errorCode: "delegation_interrupted" });
  const target = { ...first, id: "attempt-2", attemptNumber: 2, runtimeInstanceId: "runtime-2", fencingToken: "2",
    status: "created", createdAt: resumedAt, abortRequestedAt: undefined, endedAt: undefined, errorCode: undefined };
  child.attempt = target; unit.activeAttemptId = target.id; step.state = "resuming"; step.childRunId = run.id; run.status = "running";
  run.requestSnapshot = { ...request, runnerExecutionInput: execution, effectivePolicySnapshot: policy };
  const attempts = new Map([[first.id, first], [target.id, target]]), artifacts = new Map([[artifact.id, artifact]]);
  const completion = { schemaVersion: 1, source: { runId: run.id, ...toRuntimeAttemptFence(first) },
    registeredAt: preparedAt, drainedAt: stoppedAt, effectCoverage: "pi_tracked_tools_v1" };
  const view = [{ role: "user", content: preparedInput.userPrompt, timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "prior-read", name: "read", arguments: { path: "already-read.txt" } }],
      timestamp: 2, stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "prior-read", toolName: "read", content: [{ type: "text", text: "Sealed source result." }],
      isError: false, timestamp: 3 }];
  const reads = [], controls = {};
  const store = {
    readSnapshot: callback => callback(), getRun: id => id === run.id ? run : undefined,
    getWorkUnit: id => id === unit.id ? unit : undefined, getWorkUnitAttempt: id => attempts.get(id),
    getDelegationStep: id => id === step.id ? step : undefined,
    listWorkUnitAttempts: () => [...attempts.values()], getArtifact: id => artifacts.get(id),
    getHostAttemptCompletion: () => completion, listResourceLeases: () => [], listRuntimeSemaphoreSlots: () => [],
    getApprovalPolicy: () => workspacePolicy, getLingThread: () => ({ id: run.threadId, workspaceId: workspacePolicy.workspaceId,
      conversationMode: { mode: "default" } }), getLatestWorkspaceProvenanceWatermark: () => "owned-watermark",
    getLatestRunCompactionStart: () => undefined,
    readRunProgressCheckpointForRecovery(input) {
      reads.push(input);
      if (controls.result) return controls.result;
      const checkpoint = { id: "checkpoint", runId: run.id, sourceFence: toRuntimeAttemptFence(first), sourceEventSeq: 7,
        modelViewSha256: "b".repeat(64), lineage: input.expectedLineage };
      return { kind: "verified", checkpoint, modelView: view,
        witness: { checkpointId: checkpoint.id, headRevision: 1, sourceFence: checkpoint.sourceFence,
          sourceEventSeq: checkpoint.sourceEventSeq, modelViewSha256: checkpoint.modelViewSha256, lineage: checkpoint.lineage } };
    },
  };
  const assess = (changes = {}) => assessDelegatedRunRecovery({ store, child, prepared, policySnapshot: policy, now: at, ...changes });
  return { cwd, runner, options, preparedInput, execution, policy, child, run, unit, first, target, step, artifact, artifacts,
    prepared, attempts, completion, view, store, reads, controls, assess };
}

test("same-child recovery verifies original preparation and exact Core delegation binding", async t => {
  const f = await fixture(t), result = f.assess();
  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(result.sourceAttempt.id, f.first.id);
  assert.equal(result.prepared.artifactId, f.prepared.artifactId);
  assert.deepEqual(result.execution, f.execution);
  assert.deepEqual(result.ordinaryProgressRecovery.modelView, f.view);
  assert.deepEqual(f.reads, [{ runId: f.run.id, sourceFence: toRuntimeAttemptFence(f.first),
    expectedLineage: captureRunProgressCheckpointLineage(f.store, f.run, f.policy).lineage,
    delegationBinding: { reservationId: f.child.reservation.id, targetFence: toRuntimeAttemptFence(f.target) } }]);
  f.view.at(-1).content[0].text = "caller mutation";
  assert.equal(result.ordinaryProgressRecovery.modelView.at(-1).content[0].text, "Sealed source result.");
});

test("verified helper view restores the actual SDK Session without replaying its historical read", { timeout: 20_000 }, async t => {
  const f = await fixture(t), result = f.assess(), events = [], contexts = [];
  assert.equal(result.kind, "verified", JSON.stringify(result));
  let transportCalls = 0, effects = 0;
  const completed = await f.runner.runTask({ ...f.options, preparedInput: result.execution.preparedInput,
    runId: f.run.id, runnerAttemptId: f.target.id, ordinaryProgressRecovery: result.ordinaryProgressRecovery,
    onEvent: event => events.push(event), onToolBefore: () => { effects++; throw new Error("historical read replayed"); },
    onTaskContinuationBoundary: (_boundary, view) => { if (view) contexts.push(view); },
  }, () => { transportCalls++; return "Finished using the sealed read result."; });
  assert.equal(transportCalls, 1);
  assert.equal(effects, 0);
  assert.equal(events.some(event => ["tool_start", "tool_end"].includes(event.type)), false);
  assert.ok(contexts.some(view => JSON.stringify(view) === JSON.stringify(result.ordinaryProgressRecovery.modelView)));
  assert.equal(completed.messages.at(-1).role, "assistant");
});

test("missing checkpoint and Core evidence failures remain structured blocked", async t => {
  const f = await fixture(t);
  f.controls.result = { kind: "not_needed" };
  assert.deepEqual(f.assess(), { kind: "blocked", code: "checkpoint.missing" });
  for (const code of ["checkpoint.snapshot_unavailable", "checkpoint.effect_unknown", "checkpoint.source_watermark_changed"]) {
    f.controls.result = { kind: "blocked", code };
    assert.deepEqual(f.assess(), { kind: "blocked", code });
  }
});

test("tampered or absent original preparation cannot reach the checkpoint reader", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.assess({ prepared: undefined }), { kind: "blocked", code: "delegation.preparation_changed" });
  f.artifact.sealedPayload.requestSnapshot.task.prompt = "Injected replacement task";
  assert.deepEqual(f.assess(), { kind: "blocked", code: "delegation.preparation_changed" });
  assert.equal(f.reads.length, 0);
});

test("mutable stored execution and policy cannot substitute for the original child input", async t => {
  const f = await fixture(t);
  f.run.requestSnapshot = structuredClone(f.run.requestSnapshot);
  f.run.requestSnapshot.runnerExecutionInput.input.tools = [];
  assert.deepEqual(f.assess(), { kind: "blocked", code: "delegation.preparation_changed" });
  f.run.requestSnapshot.runnerExecutionInput = f.execution;
  f.run.requestSnapshot.effectivePolicySnapshot = { ...f.policy, allowedWritePaths: [] };
  assert.deepEqual(f.assess(), { kind: "blocked", code: "checkpoint.permission_drift" });
  assert.equal(f.reads.length, 0);
});

test("undrained prior owner, stale target or exhausted deadline cannot restore a Session", async t => {
  const f = await fixture(t);
  f.completion.drainedAt = undefined;
  assert.deepEqual(f.assess(), { kind: "blocked", code: "delegation.recovery_required" });
  f.completion.drainedAt = stoppedAt;
  f.unit.activeAttemptId = f.first.id;
  assert.deepEqual(f.assess(), { kind: "blocked", code: "delegation.source_attempt_stale" });
  f.unit.activeAttemptId = f.target.id;
  assert.deepEqual(f.assess({ now: f.child.reservation.deadlineAt }), { kind: "blocked", code: "delegation.deadline_exceeded" });
  assert.equal(f.reads.length, 0);
});

test("checkpoint with a foreign source fence or changed accepted prompt is refused", async t => {
  const f = await fixture(t);
  const verified = f.store.readRunProgressCheckpointForRecovery({ expectedLineage: captureRunProgressCheckpointLineage(f.store, f.run, f.policy).lineage });
  f.controls.result = { ...verified, witness: { ...verified.witness, sourceFence: toRuntimeAttemptFence(f.target) } };
  assert.deepEqual(f.assess(), { kind: "blocked", code: "checkpoint.lineage_mismatch" });
  f.controls.result = { ...verified, modelView: [{ role: "user", content: "replacement instruction", timestamp: 1 }, ...f.view.slice(1)] };
  assert.deepEqual(f.assess(), { kind: "blocked", code: "checkpoint.lineage_mismatch" });
});
