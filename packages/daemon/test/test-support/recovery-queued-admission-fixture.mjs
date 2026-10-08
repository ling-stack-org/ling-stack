import assert from "node:assert/strict";
import { runnerContinuationIdempotencyKey } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { createDetachedRunExecutionSink, executeExistingRunContinuation, executeRunRequest } from "../../dist/features/runs/orchestrator.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";
import { createRecoveryDiscoveryFixture, waitForRecovery } from "./recovery-discovery-fixture.mjs";

/** Enter the production prepareNew -> admission conflict -> durable defer path, not synthetic queued rows. */
export async function createQueuedAdmissionFixture(t, taskMode) {
  const fixture = await createRecoveryDiscoveryFixture(t, `queued-${taskMode}`);
  const { cwd, store, stores, activeRuns, supervisor, preset } = fixture;
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "Queued admission fixture", boundPath: cwd,
    defaultProviderPresetId: preset.id, allowedTools: ["read", "write"],
    runtimePolicy: { queueOnConflict: true, maxConcurrentRuns: 3 } }, now);
  const sourceTask = store.createTask({ channelId: channel.id, title: "Source", prompt: "Capture source evidence." }, now);
  const blockerTask = store.createTask({ channelId: channel.id, title: "Blocker", prompt: "Hold the fixture write lease." }, now);
  const targetTask = taskMode === "virtual" ? { id: "manual_resume_fixture", channelId: channel.id,
    title: "Virtual continuation", prompt: "Continue the accepted source." }
    : store.createTask({ channelId: channel.id, title: "Queued Task", prompt: "Continue the accepted source." }, now);
  let releaseBlocker;
  const blockerReleased = new Promise((resolve) => { releaseBlocker = resolve; });
  let blockerStarted = false;
  const calls = [];
  const completions = [];
  const errors = [];
  class AdmissionRunner extends PiRunnerAdapter {
    async runTask(options) {
      assert.ok(options.preparedInput, "production admission must freeze Pi input before dispatch");
      calls.push({ taskId: options.task.id, runId: options.runId, attemptId: options.runnerAttemptId });
      if (options.task.id === blockerTask.id) { blockerStarted = true; await blockerReleased; }
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "Fixture completed." }] };
    }
  }
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Admission fixture", status: "enabled", adapter: new AdmissionRunner() }]);
  const sink = () => ({ ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) });
  const dispatch = (request) => {
    const completion = executeRunRequest(request, sink(), runners, stores, activeRuns, supervisor,
      { resolve: () => ({ configured: false }) }, {});
    completions.push(completion);
    return completion;
  };
  fixture.onBeforeClose(async () => { releaseBlocker(); await Promise.all(completions); });
  // Match the public parser and Task route: database state is not frozen model input.
  const request = (task, tools) => ({ cwd, workspaceCwd: cwd, providerPresetId: preset.id, tools,
    task: { id: task.id, title: task.title, prompt: task.prompt, channelId: task.channelId },
    idempotencyKey: `admission-${task.id}`, createdByActor: "local-user" });
  const sourceRunId = await dispatch(request(sourceTask, ["read"]));
  assert.ok(sourceRunId, JSON.stringify(errors));
  const sourceRun = store.getRun(sourceRunId);
  const sourceUnit = store.getWorkUnit(sourceRun.workUnitId);
  const sourceAttempt = store.getWorkUnitAttempt(sourceUnit.activeAttemptId);
  const blockerCompletion = dispatch(request(blockerTask, ["write"]));
  await waitForRecovery(() => blockerStarted, `blocker did not start: ${JSON.stringify(errors)}`);
  const targetRunId = await dispatch({ ...request(targetTask, ["write"]), parentRunId: sourceRunId,
    continuationReason: "manual_resume" });
  assert.ok(targetRunId, JSON.stringify(errors));
  const targetRun = store.getRun(targetRunId);
  const targetUnit = store.getWorkUnit(targetRun.workUnitId);
  const continuation = store.findRunnerContinuationByIdempotencyKey(runnerContinuationIdempotencyKey({
    runId: targetRun.id, sourceAttemptId: sourceAttempt.id, origin: "manual_resume", generation: 0,
  }));
  assert.ok(continuation);
  assert.equal(continuation.state, "prepared");
  assert.ok(continuation.nextAttemptAt);
  assert.equal(targetUnit.status, "queued");
  assert.equal(store.getWorkUnitAttempt(continuation.targetAttemptId).status, "created");
  assert.equal(calls.some((call) => call.runId === targetRun.id), false);
  releaseBlocker();
  await blockerCompletion;
  const execution = (input) => {
    const completion = executeExistingRunContinuation(input, sink(), runners, stores, activeRuns, supervisor,
      { resolve: () => ({ configured: false }) }, {});
    completions.push(completion);
    return completion;
  };
  async function createSiblingSource() {
    const task = store.createTask({ channelId: channel.id, title: "Sibling", prompt: "Continue the same root separately." }, now);
    const runId = await dispatch({ ...request(task, ["read"]), parentRunId: sourceRunId, continuationReason: "manual_resume" });
    assert.ok(runId, JSON.stringify(errors));
    assert.equal(store.getRun(runId).status, "succeeded");
    return store.getRun(runId);
  }
  return { ...fixture, sourceRun, sourceUnit, sourceAttempt, targetRun, targetUnit, targetTask, continuation, createSiblingSource,
    calls, errors, completions, execution, admissionFacts: {
      targetKind: targetUnit.kind, targetTaskStatus: store.getTask(targetRun.taskId)?.status ?? "absent",
      targetThreadKind: store.getLingThread(targetRun.threadId)?.kind, targetRunStatus: targetRun.status,
      continuationOrigin: continuation.origin, continuationState: continuation.state,
      parentMatchesSource: targetRun.parentRunId === sourceRun.id,
      sourceAttemptMatches: continuation.sourceAttemptId === sourceAttempt.id,
      targetAttemptStatus: store.getWorkUnitAttempt(continuation.targetAttemptId).status,
    } };
}
