import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, parseGoalSupervisionPolicy } from "@ling-stack/core";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { maybeQueueGoalContinuation } from "../dist/features/runs/interventions.js";
import { TaskSupervisor } from "../dist/features/runs/task-supervisor.js";

const now = "2026-11-16T00:00:00.000Z", later = "2026-11-16T00:01:00.000Z";
test("restart supervision continues beyond three only under explicit bounds and stops for pause and time budget", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-task-supervisor-"));
  const store = createSqliteRunStore(cwd), activeRuns = new ActiveRunRegistry();
  const thread = store.createLingThread({ kind: "conversation", title: "Long task", objective: "Finish declared acceptance" }, now);
  const goal = store.createLingThreadGoal({ threadId: thread.id, objective: "Continue", supervisionPolicy: parseGoalSupervisionPolicy({ maxContinuations: 12, maxTimeSeconds: 60 }) }, now);
  const run = store.createRun({ id: "long-task-source", cwd, threadId: thread.id, taskId: "long-task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, requestSnapshot: {}, providerSnapshot: {}, createdAt: now });
  store.markRunStarted(run.id, now); store.markRunSucceeded(run.id, later);
  store.updateLingThread(thread.id, { lastRunId: run.id }, later);
  store.updateLingThreadGoal(goal.id, { lastRunId: run.id, continuationDepth: 3 }, later);
  store.createArtifact({ runId: run.id, path: "proof.json", type: "json", sealedPayload: { progress: "verified" }, createdAt: later });
  const stores = new RunStoreRegistry(() => store, { recoverOnOpen: false }); stores.getStore(cwd);
  let queued = 0;
  const supervisor = new TaskSupervisor(stores, async () => assert.fail("no rerun is pending"), async (_store, source) => {
    if (maybeQueueGoalContinuation({ terminalRun: source, store, activeRuns })) queued++;
  });
  t.after(async () => { supervisor.stopAll(); await supervisor.waitForIdle(); stores.closeAll(); await rm(cwd, { recursive: true, force: true }); });
  supervisor.start(cwd); await supervisor.waitForIdle();
  assert.equal(queued, 1); assert.equal(store.getLingThreadGoal(thread.id)?.continuationDepth, 4);
  supervisor.poke(cwd); await supervisor.waitForIdle(); assert.equal(queued, 1);
  const pending = store.listRunInterventions({ sourceRunId: run.id })[0];
  store.updateRunInterventionStatus({ interventionId: pending.id, status: "failed", failureReason: "goal_supervision_authority_changed", now: later });
  store.updateLingThreadGoal(goal.id, { status: "paused" }, later);
  assert.equal(maybeQueueGoalContinuation({ terminalRun: store.getRun(run.id)!, store, activeRuns }), undefined);
  store.updateLingThreadGoal(goal.id, { status: "active", timeUsedSeconds: 60 }, later);
  assert.equal(maybeQueueGoalContinuation({ terminalRun: store.getRun(run.id)!, store, activeRuns }), undefined);
  assert.equal(store.getLingThreadGoal(thread.id)?.lastContinuationStopReason, "time_budget");
  store.updateLingThreadGoal(goal.id, { timeUsedSeconds: 59 }, later);
  assert.equal(maybeQueueGoalContinuation({ terminalRun: store.getRun(run.id)!, store, activeRuns })?.id, pending.id);
  assert.equal(store.getLingThreadGoal(thread.id)?.continuationDepth, 4);
});

test("startup supervision wakes queued user interventions whose source Run is already terminal", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-task-supervisor-intervention-"));
  const store = createSqliteRunStore(cwd);
  const thread = store.createLingThread({ kind: "conversation", title: "Queued input", objective: "Resume queued input" }, now);
  const run = store.createRun({ id: "queued-input-source", cwd, threadId: thread.id, taskId: "queued-input", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, requestSnapshot: {}, providerSnapshot: {}, createdAt: now });
  store.markRunStarted(run.id, now); store.markRunSucceeded(run.id, later);
  store.updateLingThread(thread.id, { lastRunId: run.id }, later);
  store.createRunIntervention({ sourceRunId: run.id, mode: "queue_followup", instruction: "Continue after restart", requestedBy: "local-user", idempotencyKey: "restart-queued-input" }, later);
  const stores = new RunStoreRegistry(() => store, { recoverOnOpen: false }); stores.getStore(cwd);
  let recovered = 0;
  const supervisor = new TaskSupervisor(stores, async () => assert.fail("no rerun is pending"), async () => undefined,
    async (sourceStore, sourceRunId) => {
      assert.equal(sourceStore.getRun(sourceRunId)?.status, "succeeded");
      recovered += 1;
    });
  t.after(async () => { supervisor.stopAll(); await supervisor.waitForIdle(); stores.closeAll(); await rm(cwd, { recursive: true, force: true }); });
  supervisor.start(cwd);
  await supervisor.waitForIdle();
  assert.equal(recovered, 1);
});
