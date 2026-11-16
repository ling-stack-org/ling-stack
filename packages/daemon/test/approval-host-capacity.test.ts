import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { approvalSideEffectFingerprintV1, createApprovalResumeBasisV1, SqliteRunStore,
  toRuntimeAttemptFence, type HostOperationSource } from "../../core/dist/index.js";
import { createRuntimeHostCapacityStoreBinding, type RuntimeHostCapacityDispatchReference }
  from "../../core/dist/runtime-host-capacity-store-bridge.js";
import { hostCapacityFixture } from "../../core/test/support/runtime-host-capacity-fixture.ts";
import { runtimeRunQueueFixture } from "../../core/test/support/runtime-run-queue-fixture.ts";
import { testDatabase } from "../../core/test/support/sqlite-test-database.ts";
import { resolveConfig } from "../dist/config.js";
import { ApprovalResumeCoordinator } from "../dist/features/runs/approval-resume-coordinator.js";
import { appendApprovalDecisionEvent } from "../dist/features/runs/approvals.js";
import { acquireRunRuntimeSemaphores, prepareRunConcurrency } from "../dist/features/runs/concurrency.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRuntimeHostCapacityAdmission } from "../dist/runtime/run-queue.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

type Options = ConstructorParameters<typeof ApprovalResumeCoordinator>[0];
type CallbackInput = Parameters<NonNullable<Options["executeExistingRunContinuation"]>>[0];

async function fixture(t: TestContext, { harness = false, maximum = 4, unavailable = false, command }: {
  harness?: boolean; maximum?: number; unavailable?: boolean; command?: string;
} = {}) {
  let bound: SqliteRunStore | undefined;
  t.after(() => { if (bound && testDatabase(bound).isOpen) bound.close(); });
  const host = hostCapacityFixture(t, { maximum }), queue = await runtimeRunQueueFixture(t, { clockStart: Date.now() - 30_000 });
  const capacity = createRuntimeHostCapacityStoreBinding();
  const store = bound = new SqliteRunStore({ cwd: queue.cwd, paths: queue.paths, runtimeHostCapacityBinding: capacity.binding });
  const admission = createRuntimeHostCapacityAdmission({ host: host.host, workspace: capacity.workspace });
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: queue.cwd,
    concurrency: { enabled: true } }), undefined, undefined, unavailable ? undefined : admission);
  const runtime = supervisor.getRuntime(queue.cwd, store);
  const current = queue.prepare("approval-host", { tools: ["bash"],
    runOverrides: { contextViewId: "approval-host-context", contextViewCreatedAt: queue.at(2) },
    requestOverrides: harness ? { harnessFeatureSnapshot: { schemaVersion: 1, continuations: "enforce",
      toolBroker: "off", evaluations: "off", evaluationModelGate: "shadow", delegations: "off", delegationMaxDepth: 3 } } : {} });
  const { run, unit, attempt, fence } = current, now = new Date().toISOString();
  assert.ok(store.transitionTaskStatus({ taskId: run.taskId, expectedStatus: "todo", event: "claim", actor: "system", now }).ok);
  assert.ok(store.transitionTaskStatus({ taskId: run.taskId, expectedStatus: "claimed", event: "start_run", actor: "system", currentRunId: run.id, now }).ok);
  store.markRunStarted(run.id, now);
  assert.ok(store.transitionWorkUnitStatus({ ...fence, activeAttemptId: attempt.id, expectedStatus: "queued", event: "claim", actor: "system", now }).ok);
  assert.ok(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", now }).ok);
  assert.ok(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "approval_requested", actor: "system", now }).ok);
  assert.ok(store.updateWorkUnitAttemptStatus({ ...fence, status: "waiting_for_approval", now }));
  assert.ok(store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "approval_requested", actor: "system", now }).ok);
  const output = join(queue.cwd, "approval-output.txt");
  const payload = { type: "bash" as const, cwd: queue.cwd, command: command ?? `printf approval-host > '${output}'`, riskFlags: [] };
  const pendingApproval = store.createApprovalRequest({ runId: run.id, taskId: run.taskId, channelId: run.channelId,
    toolCallId: "approval-host-tool", actionType: "bash", risk: "medium", title: "Approved command", description: payload.command, payload }, now);
  const initial = store.getApprovalCheckpointForApproval(pendingApproval.id);
  assert.ok(initial && pendingApproval.toolCallId);
  assert.ok(store.updateApprovalCheckpointStatus(initial.id, { status: "pending", expectedStatus: "pending",
    expectedRevision: initial.revision, resumeBasis: createApprovalResumeBasisV1({ approvalId: pendingApproval.id,
      runId: run.id, workUnitId: unit.id, priorAttemptId: attempt.id, toolCallId: pendingApproval.toolCallId,
      actionType: "bash", sideEffectFingerprint: approvalSideEffectFingerprintV1({ actionType: "bash",
        toolCallId: pendingApproval.toolCallId, sideEffect: payload }) }) }, now));
  const approval = store.approveApprovalRequest(pendingApproval.id, { reason: "fixture approval" }, now);
  const checkpoint = store.getApprovalCheckpoint(initial.id);
  assert.ok(approval && checkpoint);
  // Model the approval route's durable post-commit decision projection before
  // exercising continuation admission and Host capacity behavior.
  appendApprovalDecisionEvent(store, approval);
  const runnerRegistry = createRunnerRegistry([{ id: "pi", displayName: "Pi", status: "enabled",
    adapter: { async runTask() { throw new Error("The fixture must not call the model SDK."); } },
    resumeCapabilities: { nativeResume: false, hostApprovalContinuation: ["bash"] } }]);
  const activeRuns = new ActiveRunRegistry();
  const coordinator = (overrides: Partial<Options> = {}) => new ApprovalResumeCoordinator({ activeRuns,
    runtimeSupervisor: supervisor, runnerRegistry, ...overrides });
  const journal = capacity.workspace(queue.workspaceId);
  const source = (): HostOperationSource => {
    const targetId = store.getApprovalCheckpoint(checkpoint.id)?.runnerResumeHandle?.attemptId;
    const target = targetId && store.getWorkUnitAttempt(targetId);
    assert.ok(target);
    return { runId: run.id, ...toRuntimeAttemptFence(target) };
  };
  const snapshot = () => Object.fromEntries(["approval_checkpoints", "run_sessions", "work_units", "work_unit_attempts",
    "runtime_events", "run_events", "runner_continuations", "resource_leases", "runtime_semaphore_slots",
    "runtime_host_capacity_intents", "runtime_host_capacity_releases", "host_attempt_completions"].map(table => [table, queue.rows(table)]));
  return { queue, store, host, admission, supervisor, runtime, current, approval, checkpoint, activeRuns,
    coordinator, journal, source, snapshot, output };
}

test("full Host capacity retains approved checkpoint and never creates a replacement Attempt", async t => {
  const f = await fixture(t, { maximum: 1 }), occupied = f.queue.prepare("occupied");
  const held = f.admission.reserve({ workspaceId: f.queue.workspaceId,
    source: { runId: occupied.run.id, ...occupied.fence }, now: new Date().toISOString() });
  assert.equal(held.status, "reserved");
  const before = f.store.getApprovalCheckpoint(f.checkpoint.id);
  const result = f.coordinator().resumeAfterApproval(f);
  assert.deepEqual(result, { status: "blocked", runId: f.current.run.id, reason: "approval_resume_host_capacity_full" });
  assert.deepEqual(f.store.getApprovalCheckpoint(f.checkpoint.id), before);
  assert.equal(f.store.listWorkUnitAttempts(f.current.unit.id).length, 1);
  assert.equal(f.activeRuns.get(f.current.run.id), undefined);
  assert.equal(existsSync(f.output), false);
});

test("enabled concurrency cannot fall back to an unbudgeted approval dispatcher", async t => {
  const f = await fixture(t, { unavailable: true }), before = f.snapshot();
  assert.deepEqual(f.coordinator().resumeAfterApproval(f), { status: "blocked", runId: f.current.run.id,
    reason: "approval_resume_host_capacity_unavailable" });
  assert.deepEqual(f.snapshot(), before);
});

test("Harness receives the bound Host reference after reservation and atomic claim through the supervisor getter", async t => {
  const f = await fixture(t, { harness: true }), order: string[] = [], received: CallbackInput[] = [];
  const reserve = f.admission.reserveApprovalResumePending.bind(f.admission);
  t.mock.method(f.admission, "reserveApprovalResumePending", (input: Parameters<typeof reserve>[0]) => {
    order.push("reserve");
    assert.equal(f.store.listWorkUnitAttempts(f.current.unit.id).length, 1);
    return reserve(input);
  });
  const claim = f.store.commitApprovalResumeClaim.bind(f.store);
  t.mock.method(f.store, "commitApprovalResumeClaim", (input: Parameters<typeof claim>[0]) => { order.push("claim"); return claim(input); });
  const coordinator = f.coordinator({ executeExistingRunContinuation: async input => {
    order.push("callback"); received.push(input);
    assert.equal(input.preparedExecution.attempt.status, "created");
    assert.deepEqual(f.journal.getAttemptIntent(f.source())?.source, f.source());
    return input.runId;
  } });
  const result = coordinator.resumeAfterApproval(f);
  assert.equal(result.status, "started", JSON.stringify(result));
  await f.activeRuns.waitForIdle();
  assert.deepEqual(order, ["reserve", "claim", "callback"]);
  assert.equal(received.length, 1);
  const observed = f.admission.getAttemptReference({ workspaceId: f.queue.workspaceId, source: f.source() });
  assert.deepEqual(received[0]!.hostCapacity, observed?.reference);
  assert.equal(observed?.dispatched, false, "the coordinator must not consume the Harness gate");
});

test("a Harness callback startup failure releases no_dispatch without calling the SDK", async t => {
  const f = await fixture(t, { harness: true });
  const result = f.coordinator({ executeExistingRunContinuation: () => { throw new Error("startup rejected"); } }).resumeAfterApproval(f);
  assert.equal(result.status, "blocked");
  assert.equal(f.store.getApprovalCheckpoint(f.checkpoint.id)?.status, "resume_failed");
  assert.deepEqual(f.host.host.counts(), { held: 0, released: 1, total: 1 });
  assert.equal(f.queue.rows("runtime_host_capacity_releases")[0]?.kind, "no_dispatch");
  assert.equal(existsSync(f.output), false);
});

test("Bash checks the entire local resource group while still created before consuming the Host gate", async t => {
  const f = await fixture(t);
  let gates = 0;
  const consume = f.admission.consumeDispatch.bind(f.admission);
  t.mock.method(f.admission, "consumeDispatch", (input: Parameters<typeof consume>[0]) => {
    gates++;
    assert.equal(f.store.getWorkUnitAttempt(input.source.attemptId)?.status, "created");
    assert.equal(f.store.getWorkUnitAttempt(input.source.attemptId)?.startedAt, undefined);
    assert.equal(f.store.listEvents(f.current.run.id, { limit: 1000 }).some(event => event.type === "tool_start"), false);
    const leases = f.store.listResourceLeases({ attemptId: input.source.attemptId, status: "active" });
    assert.deepEqual(leases.map(row => row.resourceType).sort(), ["bound_path", "task"]);
    const slots = f.store.listRuntimeSemaphoreSlots({ ownerId: input.source.attemptId, status: "active" });
    assert.deepEqual(slots.map(row => row.resourceType).sort(), ["channel_parallel", "provider", "runner"]);
    assert.equal(slots.find(row => row.resourceType === "provider")?.resourceKey, "approval-resume-local-bash");
    assert.equal(slots.find(row => row.resourceType === "runner")?.resourceKey, "pi");
    return consume(input);
  });
  assert.equal(f.coordinator().resumeAfterApproval(f).status, "started");
  await f.activeRuns.waitForIdle();
  assert.equal(gates, 1);
  const source = f.source(), record = f.journal.getAttemptIntent(source);
  assert.ok(record?.dispatchedAt);
  assert.ok(f.store.getWorkUnitAttempt(source.attemptId)?.startedAt);
  assert.ok(f.store.getHostAttemptCompletion(source)?.drainedAt, "the real Bash lifetime must be durably observed");
  assert.ok(f.queue.rows("host_operations").some(row => row.attempt_id === source.attemptId && row.tool_call_id === f.approval.toolCallId));
  assert.equal(f.host.host.counts().held, 1, "unverified process descendants must retain the Host reservation");
  assert.equal(f.journal.getRelease(record.intent.intentId), undefined);
});

test("a rejected Bash gate cannot start a tool and releases the unconsumed receipt", async t => {
  const f = await fixture(t);
  t.mock.method(f.admission, "consumeDispatch", () => false);
  assert.equal(f.coordinator().resumeAfterApproval(f).status, "started");
  await f.activeRuns.waitForIdle();
  assert.equal(f.store.getApprovalCheckpoint(f.checkpoint.id)?.status, "resume_failed");
  assert.equal(f.store.listEvents(f.current.run.id, { limit: 1000 }).some(event => event.type === "tool_start"), false);
  assert.equal(f.store.getWorkUnitAttempt(f.source().attemptId)?.startedAt, undefined);
  assert.deepEqual(f.host.host.counts(), { held: 0, released: 1, total: 1 });
  assert.equal(existsSync(f.output), false);
});

test("an ambiguous gate ACK preserves the created Attempt, gate and local resources across recovery", async t => {
  const f = await fixture(t), consume = f.admission.consumeDispatch.bind(f.admission);
  let gates = 0;
  t.mock.method(f.admission, "consumeDispatch", (input: Parameters<typeof consume>[0]) => {
    gates++;
    assert.equal(consume(input), true);
    throw new Error("gate acknowledgement lost");
  });
  assert.equal(f.coordinator().resumeAfterApproval(f).status, "started");
  await f.activeRuns.waitForIdle();
  const before = f.snapshot(), source = f.source();
  assert.equal(f.store.getApprovalCheckpoint(f.checkpoint.id)?.status, "resume_pending");
  assert.equal(f.store.getWorkUnitAttempt(source.attemptId)?.status, "created");
  assert.equal(f.admission.getAttemptReference({ workspaceId: f.queue.workspaceId, source })?.dispatched, true);
  assert.ok(f.store.listResourceLeases({ attemptId: source.attemptId, status: "active" }).length);
  const recovered = f.coordinator().resumeAfterApproval(f);
  assert.deepEqual(recovered, { status: "blocked", runId: f.current.run.id, reason: "approval_resume_dispatch_unconfirmed" });
  assert.deepEqual(f.snapshot(), before);
  assert.equal(gates, 1);
  assert.equal(existsSync(f.output), false);
  assert.equal(f.host.host.counts().held, 1);
});

test("a Harness rejection after gate consumption is not terminalized or redispatched", async t => {
  const f = await fixture(t, { harness: true });
  let calls = 0;
  const coordinator = f.coordinator({ executeExistingRunContinuation: async input => {
    calls++;
    assert.ok(input.hostCapacity);
    const source = f.source(), attempt = f.store.getWorkUnitAttempt(source.attemptId), unit = f.store.getWorkUnit(source.workUnitId);
    assert.ok(attempt && unit);
    const prepared = prepareRunConcurrency({ store: f.store, runId: input.runId, workUnit: unit, attempt,
      runRequest: { cwd: f.queue.cwd, task: f.current.task, tools: ["bash"] }, now: new Date().toISOString() });
    acquireRunRuntimeSemaphores({ store: f.store, workUnit: unit, attempt, channel: prepared.channel,
      providerKey: f.current.run.providerPresetId!, runnerId: "pi", now: new Date().toISOString() });
    assert.equal(f.admission.consumeDispatch({ workspaceId: f.queue.workspaceId, source,
      reference: input.hostCapacity, now: new Date().toISOString() }), true);
    throw new Error("SDK acknowledgement unknown");
  } });
  const result = coordinator.resumeAfterApproval(f);
  assert.equal(result.status, "started", JSON.stringify(result));
  await f.activeRuns.waitForIdle();
  const before = f.snapshot();
  assert.equal(f.store.getApprovalCheckpoint(f.checkpoint.id)?.status, "resume_pending");
  assert.equal(f.store.getRun(f.current.run.id)?.status, "running");
  assert.equal(f.coordinator().resumeAfterApproval(f).status, "blocked");
  assert.deepEqual(f.snapshot(), before);
  assert.equal(calls, 1);
  assert.equal(f.host.host.counts().held, 1);
});

test("an undispatched Host recovery observes its original intent without replacing the Attempt", async t => {
  const f = await fixture(t, { harness: true });
  const result = f.coordinator({ executeExistingRunContinuation: async input => input.runId }).resumeAfterApproval(f);
  assert.equal(result.status, "started", JSON.stringify(result));
  await f.activeRuns.waitForIdle();
  const before = f.snapshot();
  assert.deepEqual(f.coordinator().resumeAfterApproval(f), { status: "blocked", runId: f.current.run.id,
    reason: "approval_resume_host_recovery_pending" });
  assert.deepEqual(f.snapshot(), before);
});
