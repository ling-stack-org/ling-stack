import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../dist/index.js";
import { SqliteDelegationLifecycleStore } from "../../dist/storage/sqlite/delegation-lifecycle-store.js";
import { SqliteRunSuspensionStore } from "../../dist/storage/sqlite/run-suspension-store.js";
import { SqliteRunSuspensionStopStore } from "../../dist/storage/sqlite/run-suspension-stop-store.js";
import { createBudgetHarness } from "./delegation-budget-fixture.mjs";
import { prepareSuspensionSource } from "./run-suspension-integration-fixture.mjs";

export const stopNow = () => new Date().toISOString();

/** Isolated real SQLite, original Host lifetime and real Core lifecycle. No SDK/physical OS stop claim. */
export async function suspensionStopFixture(t, { budget = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-suspension-stop-")), now = stopNow();
  const f = createBudgetHarness(cwd, { now, later: now });
  if (budget) f.freeze();
  f.start();
  let store = f.store, suspension, stops, lifecycle, fault;
  const starts = new WeakMap(), preparations = new WeakMap(), lifetimes = new Map(), sources = new Map();
  const methods = ["getRun", "getWorkUnit", "getWorkUnitAttempt", "getApprovalPolicy", "getLingThread", "getChannel", "getProviderPreset",
    "getAiTeammate", "listTeammateSkillBindings", "getSkillRegistryEntry", "getLatestWorkspaceProvenanceWatermark", "getArtifact",
    "readRunProgressCheckpointForRecovery", "getChannelWorkflowStep", "getChannelWorkflow", "getHostAttemptCompletion", "getDelegationCompletionEvidence",
    "transitionWorkUnitStatus", "updateWorkUnitAttemptStatus", "transitionRunStatus", "getDelegationStep", "listEvents",
    "listHarnessToolExecutions", "listHostCommandWriteBlockers", "listApprovalRequests"];
  const artifact = input => {
    const value = store.artifacts.createArtifactWithinTransaction(input);
    if (fault === input.path || fault === "all_artifacts") throw new Error("injected-stop-artifact");
    if (fault === "receipt_tail" && input.path === "sqlite:run-suspension-stop-receipt") store.appendEvent(input.runId, "assistant_text_delta", { text: "late write-port" });
    return value;
  };
  const ports = { ...Object.fromEntries(methods.map(name => [name, (...args) => store[name](...args)])), createArtifactWithinTransaction: artifact,
    getDelegationBudgetReservation: id => f.writer.getDelegationBudgetReservation(id),
    createWorkUnitAttemptWithinTransaction: input => store.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction(input),
    appendRuntimeEvent: input => store.appendRuntimeEvent(input),
    appendTerminalRuntimeAudit: input => { const value = store.appendTerminalRuntimeAudit(input); if (fault === "audit") throw new Error("injected-stop-audit"); return value; },
    findWorkUnitAttemptTerminalAudit: attempt => store.runtimeWorkUnits.findWorkUnitAttemptTerminalAudit(attempt),
    releaseResourceLeasesForAttempt: (...args) => store.releaseResourceLeasesForAttempt(...args),
    releaseRuntimeSemaphoreSlotsForAttempt: (...args) => { const value = store.releaseRuntimeSemaphoreSlotsForAttempt(...args); if (fault === "resources") throw new Error("injected-stop-resources"); return value; },
    assertDispatchAuthorityWithinTransaction: input => f.writer.assertDelegatedChildDispatchAuthorityWithinTransaction(input),
    readRunnerStartObservation: token => { assert.ok(starts.has(token)); return starts.get(token); },
    readExecutionPreparation: token => { assert.ok(preparations.has(token)); return structuredClone(preparations.get(token)); },
    getRunSuspension: id => suspension.getRunSuspension(id),
    requestDelegatedChildInterruptWithinTransaction: input => lifecycle.requestDelegatedChildInterruptWithinTransaction(input),
    commitDelegatedChildInterruptedWithinTransaction: (...args) => lifecycle.commitDelegatedChildInterruptedWithinTransaction(...args),
  };
  const wire = () => {
    lifecycle = new SqliteDelegationLifecycleStore({ database: store.database }, ports);
    suspension = new SqliteRunSuspensionStore({ database: store.database }, ports);
    stops = new SqliteRunSuspensionStopStore({ database: store.database }, ports);
  };
  wire();
  const source = (run = store.getRun(f.root.id), fence = f.fence) => {
    if (sources.has(run.id)) return sources.get(run.id);
    const prepared = prepareSuspensionSource({ ...f, store, root: run, fence }, stopNow());
    const value = { runId: run.id, fence, ...prepared };
    sources.set(run.id, value); return value;
  };
  const root = source();
  const track = (own = root, coverage = true) => {
    let resolve;
    const lifetime = new Promise(done => { resolve = done; }), entry = { coverage, resolve };
    entry.completion = store.trackHostAttemptCompletion({ runId: own.runId, ...own.fence }, lifetime, () => entry.coverage);
    lifetimes.set(own.runId, entry); return entry;
  };
  const drain = async (own = root) => { const entry = lifetimes.get(own.runId); assert.ok(entry); entry.resolve(); return entry.completion; };
  const seal = (own = root) => {
    const requested = suspension.requestRunSuspension({ ...own.input, now: stopNow() });
    const committed = store.commitRunProgressCheckpoint({ runId: own.runId, sourceFence: own.fence, expectedHead: { checkpointId: null, revision: 0 },
      sourceEventSeq: store.listEvents(own.runId).at(-1).seq, expectedLineage: own.lineage, modelView: own.view, now: stopNow() });
    assert.equal(committed.kind, "committed", JSON.stringify(committed));
    const verified = store.readRunProgressCheckpointForRecovery({ runId: own.runId, sourceFence: own.fence, expectedLineage: own.lineage });
    assert.equal(verified.kind, "verified", JSON.stringify(verified));
    const sealed = suspension.sealRunSuspension({ suspensionId: requested.id, sourceFence: own.fence, witness: { kind: "ordinary", checkpoint: verified.witness }, now: stopNow() });
    own.suspensionId = sealed.id; return sealed;
  };
  const begin = (own = root, changes = {}) => stops.beginRunSuspensionStop({ suspensionId: own.suspensionId, sourceFence: own.fence, now: stopNow(), ...changes });
  const commit = (own = root, changes = {}) => stops.commitRunSuspensionStopped({ suspensionId: own.suspensionId, sourceFence: own.fence, now: stopNow(), ...changes });
  const spawn = (changes = {}) => f.spawn({ now: stopNow(), ...changes });
  const start = child => {
    const claimed = lifecycle.claimDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: child.reservation.revision,
      runtimeInstanceId: "runtime", now: stopNow() });
    const fence = toRuntimeAttemptFence(claimed.attempt), preparation = {}, observation = {};
    preparations.set(preparation, { schemaVersion: 1, kind: "delegation.execution.v1", stepId: claimed.step.id, reservationId: claimed.reservation.id,
      rootRunId: claimed.step.rootRunId, parentRunId: claimed.step.parentRunId, childRunId: claimed.run.id, sourceFence: fence, runnerId: "pi", preparedAt: stopNow(),
      requestSnapshot: { cwd, task: claimed.run.taskSnapshot, parentRunId: claimed.step.parentRunId, teammateId: claimed.run.teammateId,
        workflowStepId: claimed.run.workflowStepId, threadId: claimed.run.threadId, providerPresetId: claimed.run.providerPresetId, runnerId: "pi" },
      runnerExecutionInput: { schemaVersion: 1, runnerId: "pi", input: { cwd, task: claimed.run.taskSnapshot,
        provider: { provider: claimed.run.providerName, model: claimed.run.providerModel } }, preparedInput: { taskId: claimed.run.taskId, fingerprint: "a".repeat(64) } },
      effectivePolicySnapshot: { mode: "workspace_write", workspacePolicyUpdatedAt: now, toolDecisions: {}, allowedWritePaths: [cwd], riskNotes: [] } });
    lifecycle.commitDelegatedChildPreparation({ reservationId: child.reservation.id, sourceFence: fence, preparation, now: stopNow() });
    starts.set(observation, { childRunId: claimed.run.id, sourceFence: fence, runnerId: "pi", observationId: `accepted:${child.stepId}`, observedAt: stopNow() });
    const started = lifecycle.commitDelegatedChildStart({ reservationId: child.reservation.id, sourceFence: fence, observation, now: stopNow() });
    return { ...started, own: source(started.run, fence), sourceFence: fence,
      capture: { ...f.capture, runId: started.run.id, sourceFence: fence, budget: undefined } };
  };
  const resources = (own = root) => {
    const fact = { ...own.fence, workspaceId: DEFAULT_WORKSPACE_ID, ownerType: "work_unit_attempt", ownerId: own.fence.attemptId,
      acquiredAt: stopNow(), expiresAt: new Date(Date.now() + 500).toISOString() };
    assert.ok(store.acquireResourceLease({ ...fact, resourceType: "channel", resourceKey: own.runId }));
    assert.ok(store.acquireRuntimeSemaphoreSlot({ ...fact, resourceType: "runner", resourceKey: own.runId, limit: 1 }));
  };
  const snapshot = () => ["run_sessions", "work_units", "work_unit_attempts", "state_transition_events", "runtime_events", "tasks", "ling_threads",
    "resource_leases", "runtime_semaphore_slots", "delegation_root_budgets", "delegation_budget_reservations", "delegation_budget_charges",
    "run_events", "control_plane_events", "run_suspensions", "run_suspension_stops", "artifacts", "delegation_steps", "delegation_messages", "harness_artifact_pins", "harness_artifact_pin_events"]
    .map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
  const reopen = () => { store.close(); store = createSqliteRunStore(cwd); wire(); };
  t.after(async () => { for (const entry of lifetimes.values()) entry.resolve(); await Promise.all([...lifetimes.values()].map(entry => entry.completion.catch(() => undefined)));
    store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { ...f, get store() { return store; }, get db() { return store.database; }, root, source, track, drain, seal, begin, commit, spawn, start, resources,
    get suspension() { return suspension; }, get stops() { return stops; }, get lifecycle() { return lifecycle; }, ports, snapshot, reopen,
    fault: value => { fault = value; }, lifetimes };
}
