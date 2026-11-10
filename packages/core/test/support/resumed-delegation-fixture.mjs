import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toRuntimeAttemptFence } from "../../dist/index.js";
import { SqliteDelegationLifecycleStore } from "../../dist/storage/sqlite/delegation-lifecycle-store.js";
import { createBudgetHarness } from "./delegation-budget-fixture.mjs";

export const capabilityNow = () => new Date().toISOString();

/** Real SQLite lifecycle and Host no-launch receipts; no SDK or packaged-client claim. */
export async function resumedDelegationFixture(t, { delegated = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-resumed-capability-")), at = capabilityNow();
  const f = createBudgetHarness(cwd, { now: at, later: at });
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.freeze(); f.start();
  const observations = new WeakMap(), preparations = new WeakMap();
  const lifecycle = new SqliteDelegationLifecycleStore({ database: f.db }, {
    getRun: id => f.store.getRun(id), getWorkUnit: id => f.store.getWorkUnit(id),
    getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id), getDelegationStep: id => f.store.getDelegationStep(id),
    getDelegationBudgetReservation: id => f.writer.getDelegationBudgetReservation(id),
    getArtifact: id => f.store.getArtifact(id), createArtifactWithinTransaction: input => f.ports.createArtifactWithinTransaction(input),
    createWorkUnitAttemptWithinTransaction: input => f.store.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction(input),
    transitionRunStatus: input => f.store.transitionRunStatus(input), transitionWorkUnitStatus: input => f.store.transitionWorkUnitStatus(input),
    updateWorkUnitAttemptStatus: input => f.store.updateWorkUnitAttemptStatus(input), appendRuntimeEvent: input => f.store.appendRuntimeEvent(input),
    getHostAttemptCompletion: source => f.store.getHostAttemptCompletion(source), appendTerminalRuntimeAudit: input => f.store.appendTerminalRuntimeAudit(input),
    releaseResourceLeasesForAttempt: (...args) => f.store.releaseResourceLeasesForAttempt(...args),
    releaseRuntimeSemaphoreSlotsForAttempt: (...args) => f.store.releaseRuntimeSemaphoreSlotsForAttempt(...args),
    assertDispatchAuthorityWithinTransaction: input => f.writer.assertDelegatedChildDispatchAuthorityWithinTransaction(input),
    readRunnerStartObservation: token => { assert.ok(observations.has(token)); return observations.get(token); },
    readExecutionPreparation: token => { assert.ok(preparations.has(token)); return structuredClone(preparations.get(token)); },
  });
  const accept = claimed => {
    const sourceFence = toRuntimeAttemptFence(claimed.attempt), token = {};
    if (!lifecycle.getDelegatedChildPreparation(claimed.reservation.id)) {
      const preparation = Object.freeze({});
      preparations.set(preparation, { schemaVersion: 1, kind: "delegation.execution.v1", stepId: claimed.step.id,
        reservationId: claimed.reservation.id, rootRunId: claimed.step.rootRunId, parentRunId: claimed.step.parentRunId,
        childRunId: claimed.run.id, sourceFence, runnerId: "pi", preparedAt: capabilityNow(),
        requestSnapshot: { cwd, task: claimed.run.taskSnapshot, parentRunId: claimed.step.parentRunId,
          teammateId: claimed.run.teammateId, workflowStepId: claimed.run.workflowStepId, threadId: claimed.run.threadId,
          providerPresetId: claimed.run.providerPresetId, runnerId: "pi" },
        runnerExecutionInput: { schemaVersion: 1, runnerId: "pi", input: { cwd, task: claimed.run.taskSnapshot,
          provider: { provider: claimed.run.providerName, model: claimed.run.providerModel } },
          preparedInput: { taskId: claimed.run.taskId, fingerprint: "a".repeat(64) } },
        effectivePolicySnapshot: { mode: "workspace_write", workspacePolicyUpdatedAt: at, toolDecisions: {},
          allowedWritePaths: [cwd], riskNotes: [] } });
      lifecycle.commitDelegatedChildPreparation({ reservationId: claimed.reservation.id, sourceFence,
        preparation, now: capabilityNow() });
    }
    observations.set(token, { childRunId: claimed.run.id, sourceFence, runnerId: "pi",
      observationId: `accepted:${sourceFence.attemptId}`, observedAt: capabilityNow() });
    return lifecycle.commitDelegatedChildStart({ reservationId: claimed.reservation.id, sourceFence, observation: token, now: capabilityNow() });
  };
  const child = delegated ? f.spawn({ now: capabilityNow() }) : undefined;
  const first = child ? accept(lifecycle.claimDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: 0,
    runtimeInstanceId: "runtime", now: capabilityNow() })) : { run: f.store.getRun("root"), workUnit: f.unit, attempt: f.attempt };
  const oldFence = toRuntimeAttemptFence(first.attempt), oldSource = { runId: first.run.id, ...oldFence };
  const tool = (source, type, name = "bash", id = "reused-call") => f.store.appendExecutionEvent(source.runId, source,
    type, { toolCallId: id, toolName: name, ...(type === "tool_end" ? { isError: false } : {}) }, capabilityNow());
  const command = (source, id = "reused-call") => {
    const ticket = f.store.prepareHostCommandExecution({ runId: source.runId, sourceFence: source, toolCallId: id, cwd,
      command: { kind: "shell", command: "echo no physical dispatch", shell: "bash" } });
    f.store.settleHostCommandExecution(ticket, { kind: "not_started" });
  };
  tool(oldSource, "tool_start");
  const oldOperation = f.store.admitHostOperation({ operationId: "historical-no-start", source: oldSource,
    kind: "command", toolCallId: "reused-call" });
  f.store.settleHostOperation(oldOperation, { kind: "known_no_start" });
  command(oldSource); tool(oldSource, "tool_end");
  await f.store.trackHostAttemptCompletion(oldSource, Promise.resolve(), () => ["reused-call"]);
  let current;
  if (child) {
    lifecycle.requestDelegatedChildInterrupt({ reservationId: child.reservation.id, parentFence: f.fence,
      callId: "interrupt", now: capabilityNow() });
    const interrupted = lifecycle.commitDelegatedChildInterrupted({ reservationId: child.reservation.id, sourceFence: oldFence, now: capabilityNow() });
    current = accept(lifecycle.resumeDelegatedChild({ reservationId: child.reservation.id,
      expectedStepRevision: interrupted.step.revision, runtimeInstanceId: "runtime-2", parentFence: f.fence,
      callId: "resume-reused-call", now: capabilityNow() }));
  } else {
    f.db.prepare("UPDATE work_unit_attempts SET status='cancelled',ended_at=? WHERE id=?").run(capabilityNow(), first.attempt.id);
    const attempt = f.store.createWorkUnitAttempt({ workUnitId: first.workUnit.id, attemptNumber: 2,
      runtimeInstanceId: "runtime-2", runnerId: "pi", status: "started", now: capabilityNow() });
    current = { run: f.store.getRun("root"), workUnit: f.store.getWorkUnit(first.workUnit.id), attempt };
  }
  const fence = toRuntimeAttemptFence(current.attempt), source = { runId: current.run.id, ...fence };
  return { ...f, child, lifecycle, oldFence, oldSource, oldOperation, oldAttempt: first.attempt,
    run: current.run, unit: current.workUnit, attempt: current.attempt, fence, source, tool, command };
}
