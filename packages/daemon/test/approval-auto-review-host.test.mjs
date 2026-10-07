import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { reviewPendingApprovalAutomatically } from "../dist/features/runs/approval-auto-review-host.js";
import { createApprovalAutoReviewCoordinator } from "../dist/features/runs/approval-auto-review-coordinator.js";
import { AttemptLocalWriterGroup } from "../dist/runtime/attempt-local-writers.js";

const now = "2026-09-12T08:00:00.000Z";
const fence = { workUnitId: "source-unit", attemptId: "source-attempt", runtimeInstanceId: "runtime-1", fencingToken: "1" };
const run = {
  id: "run-1", status: "waiting_for_approval", cwd: "/workspace/project", taskId: "task-1", teammateId: "engineer",
  workflowStepId: "step-1", providerName: "provider", providerModel: "model", taskSnapshot: {}, providerSnapshot: {},
  requestSnapshot: {}, eventLogPath: "/tmp/events.jsonl", threadId: "thread-1", workUnitId: fence.workUnitId,
  createdAt: now, updatedAt: now,
};
const approval = {
  id: "approval-1", runId: run.id, taskId: run.taskId, workflowStepId: run.workflowStepId, toolCallId: "tool-1",
  actionType: "bash", risk: "medium", title: "Approve shell command", description: "pnpm test",
  payload: { type: "bash", cwd: run.cwd, command: "pnpm test", riskFlags: [] }, status: "pending", createdAt: now,
};
const policy = {
  mode: "workspace_write", authorizationMode: "smart", workspaceAccessMode: "workspace_write",
  toolDecisions: { read: "allow", grep: "allow", find: "allow", ls: "allow", bash: "ask", edit: "ask", write: "ask" },
  allowedWritePaths: [run.cwd], workspacePolicyUpdatedAt: now, riskNotes: [],
};
const turn = {
  id: "turn-1", workspaceId: "workspace_default", threadId: run.threadId, kind: "workflow_step", status: "running",
  title: "Run checks", userInstruction: "Only run the scoped test.", taskId: run.taskId, teammateId: run.teammateId,
  workflowStepId: run.workflowStepId, activeRunId: run.id, lastRunId: run.id, createdByActor: "local-user",
  createdAt: now, updatedAt: now,
};
const thread = {
  id: run.threadId, workspaceId: "workspace_default", kind: "workflow_step", taskId: run.taskId,
  teammateId: run.teammateId, workflowStepId: run.workflowStepId, title: "Checks", objective: "Run tests safely",
  status: "running", activeRunId: run.id, lastRunId: run.id, conversationMode: { mode: "default", updatedAt: now },
  createdAt: now, updatedAt: now, surfaceKind: "channel_child", relationKind: "workflow_step", nextItemSequence: 1,
};

function createFixture({ verdict = "approve", casOk = true, recoverable = false } = {}) {
  const workUnits = new Map();
  const attempts = new Map();
  const runtimeEvents = [];
  let casInput;
  let runnerCalls = 0;
  const store = {
    paths: { cwd: run.cwd },
    getApprovalPolicy: () => ({ updatedAt: now }),
    getLingTurnForRun: () => turn,
    getLingThread: () => thread,
    isCurrentRunExecutionOwner: () => true,
    isRecoverableApprovalReviewOwner: () => recoverable,
    listLingTurnRuns: () => [{ turnId: turn.id, runId: run.id, attemptNumber: 1, role: "primary", createdAt: now }],
    listConversationItemsForTurn: () => [],
    readUserInputTranscript: () => [],
    createWorkUnit: (input) => {
      const unit = { ...input, id: "review-unit", status: "queued", priority: 0, attemptCount: 0, createdAt: input.now, updatedAt: input.now };
      workUnits.set(unit.id, unit);
      return unit;
    },
    getWorkUnit: (id) => workUnits.get(id),
    findWorkUnitByIdempotency: (input) => [...workUnits.values()].find((unit) =>
      unit.kind === input.kind && unit.ownerType === input.ownerType && unit.ownerId === input.ownerId
      && unit.idempotencyKey === input.idempotencyKey),
    createWorkUnitAttempt: (input) => {
      const id = `review-attempt-${attempts.size + 1}`;
      const attempt = { ...input, id, fencingToken: String(attempts.size + 1), effectiveRunnerId: input.effectiveRunnerId, status: "created", createdAt: input.now };
      attempts.set(attempt.id, attempt);
      const unit = workUnits.get(input.workUnitId);
      workUnits.set(unit.id, { ...unit, attemptCount: input.attemptNumber, activeAttemptId: attempt.id });
      return attempt;
    },
    getWorkUnitAttempt: (id) => attempts.get(id),
    listWorkUnitAttempts: (workUnitId) => [...attempts.values()].filter((attempt) => attempt.workUnitId === workUnitId),
    transitionWorkUnitStatus: (input) => {
      const unit = workUnits.get(input.workUnitId);
      const status = input.event === "retry" ? "queued" : input.event === "claim" ? "claimed" : input.event === "runner_started" ? "running" : unit.status;
      workUnits.set(unit.id, {
        ...unit,
        status,
        activeAttemptId: input.activeAttemptId === null ? undefined : input.activeAttemptId ?? unit.activeAttemptId,
        errorCode: input.errorCode === null ? undefined : input.errorCode ?? unit.errorCode,
        errorMessage: input.errorMessage === null ? undefined : input.errorMessage ?? unit.errorMessage,
      });
      return { ok: true, from: unit.status, to: status };
    },
    updateWorkUnitAttemptStatus: (input) => {
      const attempt = attempts.get(input.attemptId);
      const updated = { ...attempt, ...input };
      attempts.set(attempt.id, updated);
      return updated;
    },
    appendRuntimeEvent: (input) => {
      runtimeEvents.push(input);
      return { ...input, id: `event-${runtimeEvents.length}`, seq: runtimeEvents.length };
    },
    listRuntimeEvents: () => runtimeEvents.map((event, index) => ({ ...event, id: `event-${index + 1}`, seq: index + 1 })),
    transitionWorkUnitAttemptTerminal: (input) => {
      const unit = workUnits.get(input.workUnitId);
      const attempt = attempts.get(input.attemptId);
      const status = input.event === "runner_succeeded" ? "succeeded" : "failed";
      workUnits.set(unit.id, { ...unit, status, endedAt: input.now, errorCode: input.errorCode, errorMessage: input.errorMessage });
      attempts.set(attempt.id, { ...attempt, status: input.attemptStatus, endedAt: input.now });
      return true;
    },
    resolveApprovalBySystemReviewer: (input) => {
      casInput = input;
      return casOk
        ? { ok: true, approval: { ...approval, status: input.decision === "approve" ? "approved" : "denied", resolvedBy: "system-reviewer", decisionReason: input.reason } }
        : { ok: false, code: "approval_execution_stale" };
    },
  };
  const runner = {
    runTask: async (options) => {
      runnerCalls += 1;
      options.onEvent?.({
        type: "message_end", role: "assistant",
        text: JSON.stringify({ schemaVersion: 1, decision: verdict, reason: verdict === "manual" ? "Need a human." : "Scoped decision." }),
      });
      return { taskId: options.task.id, events: [], messages: [] };
    },
  };
  return {
    store,
    runner,
    runtimeSupervisor: { getRuntime: () => ({ runtimeInstanceId: "runtime-review" }) },
    workUnits,
    attempts,
    runtimeEvents,
    getCasInput: () => casInput,
    getRunnerCalls: () => runnerCalls,
  };
}

async function review(fixture, extra = {}) {
  return reviewPendingApprovalAutomatically({
    store: fixture.store,
    runtimeSupervisor: fixture.runtimeSupervisor,
    runner: fixture.runner,
    provider: { provider: "provider", model: "model", apiKey: "secret-key" },
    providerPresetId: "preset-1",
    run,
    approval,
    sourceFence: fence,
    effectivePolicySnapshot: policy,
    extraSecrets: ["secret-key"],
    ...extra,
  });
}

async function recoveredReview(fixture) {
  return reviewPendingApprovalAutomatically({
    store: fixture.store,
    runtimeSupervisor: fixture.runtimeSupervisor,
    runner: fixture.runner,
    provider: { provider: "provider", model: "model", apiKey: "secret-key" },
    providerPresetId: "preset-1",
    run,
    approval,
    sourceFence: fence,
    sourceAuthority: "recoverable_suspension",
    effectivePolicySnapshot: policy,
    extraSecrets: ["secret-key"],
  });
}

test("automatic review Host commits a model verdict only through the fenced Store CAS", async () => {
  const fixture = createFixture();
  const result = await review(fixture);
  assert.equal(result.status, "resolved");
  assert.equal(result.approval.status, "approved");
  assert.equal(fixture.workUnits.get("review-unit").status, "succeeded");
  assert.equal(fixture.attempts.get("review-attempt-1").status, "succeeded");
  assert.equal(fixture.getCasInput().sourceFence.attemptId, fence.attemptId);
  assert.equal(fixture.getCasInput().decision, "approve");

  const persistedRequest = fixture.workUnits.get("review-unit").request;
  const persistedJson = JSON.stringify(persistedRequest);
  assert.equal(persistedRequest.approvalId, approval.id);
  assert.match(persistedRequest.evidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(persistedJson, /secret-key|Only run the scoped test|pnpm test/);
});

test("automatic review recovery retries one interrupted WorkUnit but does not rerun a settled manual verdict", async () => {
  const retryFixture = createFixture({ recoverable: true });
  const first = await review(retryFixture);
  assert.equal(first.status, "resolved");
  retryFixture.workUnits.set("review-unit", {
    ...retryFixture.workUnits.get("review-unit"),
    status: "stale",
    errorCode: "runtime_stale",
  });
  const recovered = await recoveredReview(retryFixture);
  assert.equal(recovered.status, "resolved");
  assert.equal(retryFixture.workUnits.get("review-unit").attemptCount, 2);
  assert.equal(retryFixture.getRunnerCalls(), 2);

  const manualFixture = createFixture({ verdict: "manual", recoverable: true });
  const manual = await review(manualFixture);
  assert.equal(manual.status, "manual");
  const cached = await recoveredReview(manualFixture);
  assert.equal(cached.status, "manual");
  assert.equal(cached.code, "reviewer_manual");
  assert.equal(manualFixture.getRunnerCalls(), 1);
});

test("automatic review Host keeps approval pending on manual verdict or stale CAS", async () => {
  const manualFixture = createFixture({ verdict: "manual" });
  const manualResult = await review(manualFixture);
  assert.equal(manualResult.status, "manual");
  assert.equal(manualResult.code, "reviewer_manual");
  assert.equal(manualFixture.getCasInput(), undefined);
  assert.equal(manualFixture.workUnits.get("review-unit").status, "succeeded");

  const staleFixture = createFixture({ casOk: false });
  const staleResult = await review(staleFixture);
  assert.equal(staleResult.status, "manual");
  assert.equal(staleResult.code, "approval_execution_stale");
  assert.equal(staleFixture.workUnits.get("review-unit").status, "failed");
});

test("automatic review Host passes captured local lifetime through prompt manual fallback to actual Runner cleanup", async () => {
  const fixture = createFixture();
  const group = new AttemptLocalWriterGroup({ ...fence, runId: run.id });
  const abort = new AbortController();
  const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, deadlineMs: 1000 });
  let completeRunner;
  const underlying = new Promise(resolve => { completeRunner = resolve; });
  let captured;
  fixture.runner.runTask = options => {
    captured = options;
    assert.equal(group.getSnapshot().writers.length, 2, "outer Host callback and actual Runner own distinct lifetime tickets");
    return underlying;
  };
  const pending = group.wrapAsync("outer-approval-host", () => review(fixture, { localWriters: group, signal: abort.signal, coordinator }))();
  abort.abort();
  assert.equal((await pending).code, "cancelled");
  const eventsAfterFallback = fixture.runtimeEvents.length;
  assert.equal(fixture.getCasInput(), undefined);
  assert.equal(group.getSnapshot().writers.length, 1, "Host result does not release the underlying reviewer");
  group.close();
  await assert.rejects(group.waitForIdle(0), /have not drained/);
  captured.onEvent({ type: "message_end", role: "assistant", text: '{"schemaVersion":1,"decision":"approve","reason":"Too late."}' });
  completeRunner({ events: [], messages: [] });
  await group.waitForIdle(100);
  await tick();
  assert.deepEqual(group.getSnapshot().writers, []);
  assert.equal(fixture.getCasInput(), undefined, "late model output cannot acquire approval authority");
  assert.equal(fixture.runtimeEvents.length, eventsAfterFallback, "late cleanup performs no Host Store writes");
});
