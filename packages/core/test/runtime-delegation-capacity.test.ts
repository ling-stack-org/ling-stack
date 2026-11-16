import assert from "node:assert/strict";
import { once } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, parseWorkflowStepExecutionSafety,
  toRuntimeAttemptFence, workflowStepSafetyPlanDigest } from "../dist/index.js";
import { SqliteDelegationLifecycleStore } from "../dist/storage/sqlite/delegation-lifecycle-store.js";
import { SqliteRuntimeConcurrencyPolicyStore } from "../dist/storage/sqlite/runtime-concurrency-policy-store.js";
import { createBudgetHarness, budgetProvider } from "./support/delegation-budget-fixture.mjs";
import { capabilityNow, resumedDelegationFixture } from "./support/resumed-delegation-fixture.mjs";
import { admissionSnapshot, workflowAdmissionFixture } from "./support/workflow-step-admission-fixture.mjs";
import type { RuntimeConcurrencyLimits } from "../dist/runtime-concurrency-policy.js";
import type { AcquireRuntimeSemaphoreSlotInput, RuntimeAttemptFenceV1, WorkUnitAttempt } from "../dist/runtime-supervisor-types.js";
import type { ClaimedDelegatedChild, DelegationLifecycleStorePorts } from "../dist/harness/delegation-lifecycle-types.js";
import type { DelegationAuthorityCapture, DelegationChildReceipt, PrepareDelegatedChildInput } from "../dist/harness/delegation-write-types.js";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Store = ReturnType<typeof createSqliteRunStore>;
type WorkflowFixture = Awaited<ReturnType<typeof workflowAdmissionFixture>>;
type HarnessWriter = ReturnType<typeof createBudgetHarness>["writer"];
type Harness = Pick<ReturnType<typeof createBudgetHarness>, "writer"> & {
  cwd: string;
  db: DatabaseSync;
  store: Store;
  root: NonNullable<ReturnType<Store["getRun"]>>;
  unit: ReturnType<Store["createWorkUnit"]>;
  attempt: WorkUnitAttempt;
  fence: RuntimeAttemptFenceV1;
  capture: DelegationAuthorityCapture;
  freeze(overrides?: Partial<Parameters<HarnessWriter["freezeRootDelegationBudget"]>[0]>): ReturnType<HarnessWriter["freezeRootDelegationBudget"]>;
  start(runId?: string): void;
  spawn(overrides?: Partial<PrepareDelegatedChildInput>): ReturnType<HarnessWriter["prepareDelegatedChild"]>;
  childReceipt(receipt: DelegationChildReceipt): unknown;
};
type Child = ReturnType<Harness["spawn"]>;
type Fixture = WorkflowFixture & { host: Harness; peerHost: Harness };
type StoreFixture = { store: Store; peer?: Store };
type SlotOwner = { attempt: WorkUnitAttempt; fence: RuntimeAttemptFenceV1; providerKey: string };
type HostSource = Parameters<Store["trackHostAttemptCompletion"]>[0];
type ResumedFixture = Pick<Harness, "cwd" | "db" | "store" | "root" | "unit" | "attempt" | "fence" | "capture"> &
  Pick<Awaited<ReturnType<typeof resumedDelegationFixture>>, "lifecycle"> & {
    child: Child;
    peer?: Store;
    run: NonNullable<ReturnType<Store["getRun"]>>;
    source: HostSource;
    tool(source: HostSource, type: "tool_start" | "tool_end", name?: string, id?: string): ReturnType<Store["appendExecutionEvent"]>;
    command(source: HostSource, id?: string): void;
  };
type RaceInput = {
  spawn: Partial<PrepareDelegatedChildInput>;
  acquireRuntimeSemaphoreSlots: Parameters<Store["acquireRuntimeSemaphoreSlots"]>[0];
  beginChannelWorkflowStepStart: Parameters<Store["beginChannelWorkflowStepStart"]>[0];
};
type RaceResult = {
  spawn: Child;
  acquireRuntimeSemaphoreSlots: ReturnType<Store["acquireRuntimeSemaphoreSlots"]>;
  beginChannelWorkflowStepStart: ReturnType<Store["beginChannelWorkflowStepStart"]>;
};
type RaceOperation = { [M in keyof RaceInput]: { method: M; input: RaceInput[M] } }[keyof RaceInput];
type RaceReply<M extends keyof RaceInput> = { type: "result"; result: RaceResult[M] } |
  { type: "rejected"; code: string | undefined; message: string };
type RaceReplies<Ops extends readonly RaceOperation[]> = { [I in keyof Ops]: RaceReply<Ops[I]["method"]> };

const providerKey = `${budgetProvider.providerId}:${budgetProvider.model}`;
const generousLimits = { maxConcurrentRuns: 64, maxReadOnlyRuns: 64, maxWorkspaceWriteRuns: 4,
  maxRunsPerProvider: 64, maxRunsPerRunner: 64 };
const dimensions = [
  { name: "total", limits: { maxConcurrentRuns: 2 }, provider: "other-provider", runner: "codex" },
  { name: "conservative write", limits: { maxWorkspaceWriteRuns: 2 }, provider: "other-provider", runner: "codex" },
  { name: "provider", limits: { maxRunsPerProvider: 2 }, provider: providerKey, runner: "codex" },
  { name: "runner", limits: { maxRunsPerRunner: 2 }, provider: "other-provider", runner: "pi" },
];
const extraTables = ["artifacts", "harness_artifact_pins", "delegation_root_budgets", "delegation_steps",
  "delegation_budget_reservations", "delegation_budget_charges", "delegation_messages", "runtime_concurrency_policies",
  "runtime_delegation_capacity_admissions"];
const policies = (store: Store) => new SqliteRuntimeConcurrencyPolicyStore({ database: testDatabase(store) });
const count = (f: StoreFixture, table: string) => Number(testDatabase(f.peer ?? f.store).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
const snapshot = (f: StoreFixture) => {
  const store = f.peer ?? f.store;
  return { ...admissionSnapshot(store), ...Object.fromEntries(extraTables.map(table => [table,
    testDatabase(store).prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) };
};
function noWrites<T>(f: StoreFixture, action: () => T): T {
  const before = snapshot(f);
  try { return action(); }
  finally {
    assert.deepEqual(snapshot(f), before);
    for (const store of [f.store, f.peer].filter((store): store is Store => Boolean(store))) assert.equal(testDatabase(store).isTransaction, false);
  }
}
function installPolicy(f: StoreFixture, overrides: Partial<RuntimeConcurrencyLimits> = {}, store = f.store, enabled = true) {
  const expectedRevision = policies(store).getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID)?.revision ?? 0;
  const result = policies(store).installRuntimeConcurrencyPolicy({ workspaceId: DEFAULT_WORKSPACE_ID,
    runtimeInstanceId: `delegation-capacity-policy-${expectedRevision + 1}`, expectedRevision, enabled,
    limits: { ...generousLimits, ...overrides }, installedAt: capabilityNow() });
  assert.equal(result.status, "installed", JSON.stringify(result));
  assert.equal(result.policy.revision, expectedRevision + 1);
  assert.deepEqual(policies(f.peer ?? f.store).getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), result.policy);
  return result.policy;
}
function harness(f: Pick<WorkflowFixture, "cwd" | "at">, store: Store): Harness {
  return createBudgetHarness(f.cwd, { store, now: f.at(0), later: f.at(0), budget: { tokenBudget: 1_000 } }) as Harness;
}
async function fixture(t: TestContext) {
  const f = await workflowAdmissionFixture(t) as Fixture;
  assert.equal(f.channel.workspaceId, DEFAULT_WORKSPACE_ID);
  f.host = harness(f, f.store);
  f.host.freeze(); f.host.start();
  f.peerHost = harness(f, f.peer);
  return f;
}
const spawnInput = (name: string, overrides: Partial<PrepareDelegatedChildInput> = {}) => ({ spawnCallId: name, objective: "Read the controlled SQLite fixture",
  requestedBudget: { tokenBudget: 10 }, now: capabilityNow(), ...overrides });
const spawn = (host: Harness, name: string, overrides: Partial<PrepareDelegatedChildInput> = {}) => host.spawn(spawnInput(name, overrides));
function lifecycle(host: Harness) {
  const store = host.store;
  const workUnits = Reflect.get(store, "runtimeWorkUnits") as Pick<DelegationLifecycleStorePorts, "createWorkUnitAttemptWithinTransaction">;
  const ports: Pick<DelegationLifecycleStorePorts, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getDelegationStep" |
    "getDelegationBudgetReservation" | "getArtifact" | "createWorkUnitAttemptWithinTransaction" |
    "transitionWorkUnitStatus" | "assertDispatchAuthorityWithinTransaction"> = {
    getRun: id => store.getRun(id), getWorkUnit: id => store.getWorkUnit(id),
    getWorkUnitAttempt: id => store.getWorkUnitAttempt(id), getDelegationStep: id => store.getDelegationStep(id),
    getDelegationBudgetReservation: id => host.writer.getDelegationBudgetReservation(id),
    getArtifact: id => store.getArtifact(id),
    createWorkUnitAttemptWithinTransaction: input => workUnits.createWorkUnitAttemptWithinTransaction(input),
    transitionWorkUnitStatus: input => store.transitionWorkUnitStatus(input),
    assertDispatchAuthorityWithinTransaction: input => host.writer.assertDelegatedChildDispatchAuthorityWithinTransaction(input),
  };
  // Claim and read-only recovery use this transaction-bound subset of lifecycle ports.
  return new SqliteDelegationLifecycleStore({ database: testDatabase(store) }, ports as DelegationLifecycleStorePorts);
}
function claim(host: Harness, child: Child) {
  return lifecycle(host).claimDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: 0,
    runtimeInstanceId: `capacity-runtime-${child.childRun.id}`, now: capabilityNow() });
}
function rootOwner(f: Pick<Fixture, "store" | "host"> | Pick<Harness, "store" | "root">) {
  const root = "host" in f ? f.host.root : f.root;
  const run = f.store.getRun(root.id)!, unit = f.store.getWorkUnit(run.workUnitId!)!;
  const attempt = f.store.getWorkUnitAttempt(unit.activeAttemptId!)!;
  return { run, unit, attempt, fence: toRuntimeAttemptFence(attempt), providerKey: run.providerPresetId ?? `${run.providerName}:${run.providerModel}` };
}
const childOwner = (current: Pick<ClaimedDelegatedChild, "run" | "workUnit" | "attempt">) => ({ run: current.run, unit: current.workUnit, attempt: current.attempt,
  fence: toRuntimeAttemptFence(current.attempt), providerKey: current.run.providerPresetId ?? `${current.run.providerName}:${current.run.providerModel}` });
function ordinary(f: StoreFixture, name: string, { provider = `capacity-provider-${name}`, runner = "pi" } = {}) {
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
    ownerId: `capacity-task-${name}`, runnerId: runner, effectiveRunnerId: runner, idempotencyKey: `capacity-unit-${name}`,
    createdByActor: "system", request: {}, now: capabilityNow() });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: `capacity-runtime-${name}`, runnerId: runner, effectiveRunnerId: runner, now: capabilityNow() });
  return { unit, attempt, fence: toRuntimeAttemptFence(attempt), providerKey: provider };
}
function slots(current: SlotOwner): AcquireRuntimeSemaphoreSlotInput[] {
  const acquiredAt = capabilityNow();
  return [{ resourceType: "provider" as const, resourceKey: current.providerKey },
    { resourceType: "runner" as const, resourceKey: current.attempt.effectiveRunnerId ?? current.attempt.runnerId }]
    .map((entry): AcquireRuntimeSemaphoreSlotInput => ({ ...entry, workspaceId: DEFAULT_WORKSPACE_ID, ...current.fence, limit: 4,
      ownerType: "work_unit_attempt", ownerId: current.attempt.id, acquiredAt,
      expiresAt: new Date(Date.parse(acquiredAt) + 3_600_000).toISOString() }));
}
const exactSlots = (f: StoreFixture, current: Pick<SlotOwner, "fence">) => testDatabase(f.peer ?? f.store).prepare(`SELECT * FROM runtime_semaphore_slots
  WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? AND status='active' ORDER BY id`)
  .all(current.fence.workUnitId, current.fence.attemptId, current.fence.runtimeInstanceId, current.fence.fencingToken);
function acquire<Owner extends SlotOwner>(f: StoreFixture, current: Owner, store = f.store) {
  const result = store.acquireRuntimeSemaphoreSlots(slots(current));
  assert.equal(result.status, "acquired", JSON.stringify(result));
  assert.equal(exactSlots(f, current).length, 2);
  return result;
}
function full(f: StoreFixture, current: SlotOwner, store = f.peer ?? f.store) {
  assert.equal(noWrites(f, () => store.acquireRuntimeSemaphoreSlots(slots(current))).status, "full");
  assert.equal(testDatabase(f.peer ?? f.store).prepare("SELECT COUNT(*) AS n FROM runtime_semaphore_slots WHERE attempt_id=?")
    .get(current.attempt.id)!.n, 0);
}
function spawnFull(f: StoreFixture, host: Harness, name: string) {
  noWrites(f, () => assert.throws(() => spawn(host, name), { code: "delegation.capacity_exhausted" }));
}
function settle(host: Harness, child: Child, kind: DelegationChildReceipt["kind"]) {
  return host.writer.settleDelegatedChild({ reservationId: child.reservation.id,
    receipt: host.childReceipt({ kind, childRunId: child.childRun.id }), now: capabilityNow() });
}

async function race<const Ops extends readonly RaceOperation[]>(t: TestContext,
  f: Pick<WorkflowFixture, "cwd" | "paths" | "at">, operations: Ops): Promise<RaceReplies<Ops>> {
  const source = `const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { createSqliteRunStore } = await import(workerData.moduleUrl);
      const { createBudgetHarness } = await import(workerData.fixtureUrl);
      const store = createSqliteRunStore(workerData.cwd, workerData.paths);
      const host = createBudgetHarness(workerData.cwd, { store, ...workerData.harnessOptions });
      parentPort.once("message", () => {
        try {
          const result = workerData.method === "spawn" ? host.spawn(workerData.input) : store[workerData.method](workerData.input);
          parentPort.postMessage({ type: "result", result });
        } catch (error) { parentPort.postMessage({ type: "rejected", code: error.code, message: String(error) }); }
        finally { store.close(); }
      });
      parentPort.postMessage({ type: "ready" });
    })().catch(error => parentPort.postMessage({ type: "error", message: String(error) }));`;
  const workers = operations.map(operation => new Worker(source, { eval: true, workerData: { ...operation,
    cwd: f.cwd, paths: f.paths, moduleUrl: import.meta.resolve("../dist/index.js"),
    fixtureUrl: new URL("./support/delegation-budget-fixture.mjs", import.meta.url).href,
    harnessOptions: { now: f.at(0), later: f.at(0), budget: { tokenBudget: 1_000 } } } }));
  try {
    await Promise.all(workers.map(async worker => {
      const [message] = await once(worker, "message", { signal: t.signal }) as [{ type: string }];
      assert.equal(message.type, "ready", JSON.stringify(message));
    }));
    const pending = workers.map(worker => once(worker, "message", { signal: t.signal }));
    workers.forEach(worker => worker.postMessage("go"));
    const results = (await Promise.all(pending)).map(([message]) => message as RaceReply<keyof RaceInput> | { type: "error"; message: string });
    for (const result of results) assert.notEqual(result.type, "error", JSON.stringify(result));
    return results as RaceReplies<Ops>;
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

test("legacy delegated children retain admission until a workspace policy is actually installed", async t => {
  const f = await fixture(t), parent = rootOwner(f);
  acquire(f, parent);
  assert.equal(policies(f.store).getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), undefined);
  for (let index = 0; index < 5; index++) assert.equal(spawn(f.host, `legacy-${index}`).reservation.state, "reserved");
  assert.equal(count(f, "runtime_semaphore_slots"), 2);
  assert.equal(count(f, "delegation_budget_reservations"), 5);
  const before = snapshot(f);
  installPolicy(f, { maxConcurrentRuns: 2 });
  const { runtime_concurrency_policies: ignored, ...after } = snapshot(f);
  const { runtime_concurrency_policies: absent, ...prior } = before;
  assert.deepEqual(after, prior);
  spawnFull(f, f.peerHost, "legacy-now-full");
  full(f, ordinary(f, "legacy-ordinary", { runner: "codex" }));
});

for (const dimension of dimensions) {
  test(`parent plus an unclaimed child jointly exhaust ${dimension.name}, with no half spawn on the peer`, async t => {
    const f = await fixture(t);
    installPolicy(f, dimension.limits);
    const parent = rootOwner(f);
    acquire(f, parent);
    const child = spawn(f.host, `reserved-${dimension.name}`);
    assert.equal(child.reservation.state, "reserved");
    assert.equal(child.childWorkUnit.activeAttemptId, undefined);
    assert.equal(f.store.listWorkUnitAttempts(child.childWorkUnit.id).length, 0);
    assert.equal(count(f, "runtime_semaphore_slots"), 2, "a queued child has no execution slot but still consumes capacity");
    spawnFull(f, f.peerHost, `full-${dimension.name}`);
    full(f, ordinary(f, `blocked-${dimension.name}`, dimension));
    const policy = policies(f.store).getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID);
    f.peerHost = harness(f, f.reopen("peer"));
    assert.deepEqual(policies(f.peer).getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), policy);
    spawnFull(f, f.peerHost, `reopened-full-${dimension.name}`);
    assert.equal(count(f, "delegation_steps"), 1);
    assert.equal(count(f, "delegation_budget_reservations"), 1);
  });
}

test("a readonly objective does not turn dynamic reservations into a Host-verified readonly class", async t => {
  const f = await fixture(t);
  installPolicy(f, { maxConcurrentRuns: 8, maxReadOnlyRuns: 1, maxWorkspaceWriteRuns: 2 });
  for (let index = 0; index < 2; index++) spawn(f.host, `readonly-text-${index}`, { objective: "Read only; never write or use the network." });
  assert.equal(count(f, "runtime_semaphore_slots"), 0);
  assert.equal(count(f, "delegation_budget_reservations"), 2, "unverified dynamic children use write, not the one-place readonly class");
  spawnFull(f, f.peerHost, "readonly-text-full");
  full(f, ordinary(f, "readonly-text-ordinary", { runner: "codex" }));
});

test("exact reserved claim and partial Provider/Runner handoff neither double-count nor open a capacity gap", async t => {
  const f = await fixture(t);
  installPolicy(f, { maxConcurrentRuns: 2, maxRunsPerProvider: 2, maxRunsPerRunner: 2 });
  acquire(f, rootOwner(f));
  const child = spawn(f.host, "handoff"), candidate = ordinary(f, "handoff-rival", { runner: "codex" });
  full(f, candidate);
  const claimed = claim(f.peerHost, child), current = childOwner(claimed), inputs = slots(current);
  assert.equal(claimed.attempt.attemptNumber, 1);
  assert.equal(exactSlots(f, current).length, 0);
  full(f, candidate);
  assert.ok(f.peer.acquireRuntimeSemaphoreSlot(inputs[0]));
  full(f, candidate);
  assert.ok(f.store.acquireRuntimeSemaphoreSlot(inputs[1]));
  full(f, candidate);
  assert.equal(exactSlots(f, current).length, 2);
  const replay = noWrites(f, () => claim(f.peerHost, child));
  assert.equal(replay.replayed, true);
  assert.equal(replay.attempt.id, current.attempt.id);
  installPolicy(f, { maxConcurrentRuns: 3, maxRunsPerProvider: 3, maxRunsPerRunner: 3 });
  acquire(f, candidate, f.peer);
  full(f, ordinary(f, "handoff-fourth", { runner: "claude" }));
  assert.equal(count(f, "delegation_budget_reservations"), 1);
});

test("lowered total, write, Provider and Runner caps retain an already-reserved exact child handoff", async t => {
  const f = await fixture(t);
  installPolicy(f, { maxConcurrentRuns: 2, maxWorkspaceWriteRuns: 2, maxRunsPerProvider: 2, maxRunsPerRunner: 2 });
  const parent = rootOwner(f);
  acquire(f, parent);
  const child = spawn(f.host, "lowered-handoff"), before = snapshot(f);
  installPolicy(f, { maxConcurrentRuns: 1, maxWorkspaceWriteRuns: 1, maxRunsPerProvider: 1, maxRunsPerRunner: 1 }, f.peer);
  const { runtime_concurrency_policies: ignored, ...after } = snapshot(f);
  const { runtime_concurrency_policies: priorPolicy, ...prior } = before;
  assert.deepEqual(after, prior);
  const claimed = claim(f.peerHost, child), current = childOwner(claimed);
  acquire(f, current, f.peer);
  assert.equal(exactSlots(f, parent).length, 2);
  assert.equal(claimed.reservation.deadlineAt, child.reservation.deadlineAt);
  assert.equal(claimed.reservation.requestDigest, child.reservation.requestDigest);
  assert.equal(noWrites(f, () => spawn(f.peerHost, "lowered-handoff")).replayed, true);
  spawnFull(f, f.host, "lowered-fresh");
  full(f, ordinary(f, "lowered-ordinary", { runner: "codex" }));
});

for (const enabled of [true, false]) {
  test(`${enabled ? "enabled" : "legacy"} child reservations keep their original capacity authority after disabling`, async t => {
    const f = await fixture(t), policy = installPolicy(f, {}, f.store, enabled);
    const children = [spawn(f.host, "disabled-first"), spawn(f.host, "disabled-second")];
    const receipts = () => testDatabase(f.peer).prepare("SELECT * FROM runtime_delegation_capacity_admissions ORDER BY reservation_id").all();
    const accepted = receipts();
    assert.equal(accepted.length, enabled ? 2 : 0);
    for (const receipt of accepted) {
      assert.equal(receipt.policy_revision, policy.revision);
      assert.equal(receipt.workspace_id, DEFAULT_WORKSPACE_ID);
      assert.equal(receipt.provider_key, providerKey);
      assert.equal(receipt.runner_id, "pi");
      assert.equal(receipt.attempt_number, 1);
    }
    installPolicy(f, {}, f.store, false);
    f.peerHost = harness(f, f.reopen("peer"));
    const first = childOwner(claim(f.peerHost, children[0])), second = childOwner(claim(f.host, children[1]));
    const narrowed = (owner: SlotOwner) => slots(owner).map(input => ({ ...input, limit: 1 }));
    assert.equal(f.peer.acquireRuntimeSemaphoreSlots(narrowed(first)).status, "acquired");
    if (enabled) assert.equal(f.store.acquireRuntimeSemaphoreSlots(narrowed(second)).status, "acquired");
    else assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(narrowed(second))).status, "full");
    assert.deepEqual(receipts(), accepted, "disable and exact claims cannot manufacture new operational authority");
    const rival = ordinary(f, "disabled-reservation-rival", { provider: providerKey });
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(narrowed(rival))).status, "full");
  });
}

test("an enabled partial slot handoff seals only the exact legacy child lifetime before disable", async t => {
  const f = await fixture(t), child = spawn(f.host, "legacy-partial"), current = childOwner(claim(f.host, child));
  const holder = ordinary(f, "legacy-partial-holder");
  acquire(f, holder);
  const policy = installPolicy(f), inputs = slots(current).map(input => ({ ...input, limit: 1 }));
  assert.equal(count(f, "runtime_delegation_capacity_admissions"), 0);
  assert.ok(f.peer.acquireRuntimeSemaphoreSlot(inputs[0]));
  const receipt = testDatabase(f.store).prepare("SELECT * FROM runtime_delegation_capacity_admissions WHERE reservation_id=?")
    .get(child.reservation.id)!;
  assert.equal(receipt.attempt_number, current.attempt.attemptNumber);
  assert.equal(receipt.policy_revision, policy.revision);
  installPolicy(f, {}, f.store, false);
  assert.ok(f.store.acquireRuntimeSemaphoreSlot(inputs[1]));
  assert.equal(exactSlots(f, current).length, 2);
  assert.equal(count(f, "runtime_delegation_capacity_admissions"), 1);
  const rival = ordinary(f, "partial-rival");
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(slots(rival)
    .map(input => ({ ...input, limit: 1 })))).status, "full");
});

test("four admitted children and a readonly preparing owner hand off above legacy four after disable", async t => {
  const f = await fixture(t);
  installPolicy(f);
  const scope = f.scope("disabled-five", { plan: f.plan({ entries: [
    { resourceType: "provider", resourceKey: providerKey, limit: 4 },
    { resourceType: "runner", resourceKey: "pi", limit: 4 },
    { resourceType: "channel_parallel", resourceKey: f.channel.id, limit: 4 },
  ] }) });
  const declaration: NonNullable<typeof scope.step.metadata> = { ...scope.step.metadata, sideEffectClass: "analysis_readonly", requiredTools: ["read"],
    requestedRunnerId: "pi", parallelPolicy: { autoParallel: true, maxParallelSiblings: 4, resourceKeys: [] } };
  const plan: Parameters<typeof workflowStepSafetyPlanDigest>[0] = { schemaVersion: 1, profile: "pi_host_readonly_v1", workflowId: scope.workflow.id,
    workflowStepId: scope.step.id, workspaceRoot: f.cwd, executionRoot: f.cwd,
    safety: parseWorkflowStepExecutionSafety(declaration)!, tools: ["read", "grep", "find", "ls"],
    runnerId: "pi", networkAccess: false, writeRoots: [] };
  scope.step = f.store.updateChannelWorkflowStep(scope.step.id,
    { metadata: { ...declaration, safetyPlan: { ...plan, digest: workflowStepSafetyPlanDigest(plan) } } }, f.at(0))!;
  const start = f.begin(scope), children = Array.from({ length: 4 }, (_, index) => spawn(f.host, `five-${index}`));
  assert.equal(count(f, "runtime_delegation_capacity_admissions"), 4);
  installPolicy(f, {}, f.store, false);
  f.peerHost = harness(f, f.reopen("peer"));
  const rival = ordinary(f, "disabled-five-rival", { provider: providerKey });
  full(f, rival);
  for (const child of children) acquire(f, childOwner(claim(f.peerHost, child)), f.peer);
  const prepared = f.prepare(scope, start, "disabled-five");
  assert.equal(f.transfer(scope, start, prepared, {}, f.peer).status, "transferred");
  full(f, rival);
  assert.equal(count(f, "runtime_semaphore_slots"), 12);
  assert.equal(count(f, "runtime_delegation_capacity_admissions"), 4);
});

test("receipt persistence failures roll back child identity, reservations and partial slot handoffs", async t => {
  const f = await fixture(t);
  installPolicy(f);
  const trigger = `CREATE TRIGGER reject_capacity_receipt BEFORE INSERT ON runtime_delegation_capacity_admissions
    BEGIN SELECT RAISE(ABORT,'injected capacity receipt fault'); END`;
  testDatabase(f.store).exec(trigger);
  noWrites(f, () => assert.throws(() => spawn(f.host, "receipt-fault"), /injected capacity receipt fault/));
  testDatabase(f.store).exec("DROP TRIGGER reject_capacity_receipt");
  installPolicy(f, {}, f.store, false);
  const child = spawn(f.host, "legacy-receipt-fault"), current = childOwner(claim(f.host, child));
  installPolicy(f);
  testDatabase(f.store).exec(trigger);
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(slots(current))).status, "changed");
  assert.equal(exactSlots(f, current).length, 0);
  assert.equal(count(f, "runtime_delegation_capacity_admissions"), 0);
  testDatabase(f.store).exec("DROP TRIGGER reject_capacity_receipt");
  acquire(f, current);
  assert.equal(count(f, "runtime_delegation_capacity_admissions"), 1);
});

for (const enabledResume of [true, false]) {
  test(`a drained child ${enabledResume ? "renews" : "cannot reuse"} its operational receipt for a successor`, async t => {
    const f = await resumedDelegationFixture(t) as ResumedFixture;
    installPolicy(f);
    acquire(f, { run: f.run, unit: f.unit, attempt: f.attempt, fence: f.fence, providerKey });
    const receipt = f.db.prepare("SELECT * FROM runtime_delegation_capacity_admissions WHERE reservation_id=?")
      .get(f.child.reservation.id)!;
    assert.equal(receipt.attempt_number, f.attempt.attemptNumber);
    const toolCallId = "receipt-stop";
    f.tool(f.source, "tool_start", "bash", toolCallId);
    const operation = f.store.admitHostOperation({ operationId: toolCallId, source: f.source, kind: "command", toolCallId });
    f.store.settleHostOperation(operation, { kind: "known_no_start" });
    f.command(f.source, toolCallId);
    f.tool(f.source, "tool_end", "bash", toolCallId);
    await f.store.trackHostAttemptCompletion(f.source, Promise.resolve(), () => [toolCallId]);
    f.lifecycle.requestDelegatedChildInterrupt({ reservationId: f.child.reservation.id,
      parentFence: f.capture.sourceFence, callId: "receipt-interrupt", now: capabilityNow() });
    const stopped = f.lifecycle.commitDelegatedChildInterrupted({ reservationId: f.child.reservation.id,
      sourceFence: f.fence, now: capabilityNow() });
    if (!enabledResume) installPolicy(f, {}, f.store, false);
    const holder = ordinary(f, "receipt-successor-holder");
    acquire(f, holder);
    const resumed = f.lifecycle.resumeDelegatedChild({ reservationId: f.child.reservation.id,
      expectedStepRevision: stopped.step.revision, runtimeInstanceId: "receipt-successor-runtime",
      parentFence: f.capture.sourceFence, callId: "receipt-resume", now: capabilityNow() });
    const current = childOwner(resumed), inputs = slots(current).map(input => ({ ...input, limit: 1 }));
    if (enabledResume) installPolicy(f, {}, f.store, false);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM runtime_delegation_capacity_admissions WHERE reservation_id=? AND attempt_number=?")
      .get(f.child.reservation.id, current.attempt.attemptNumber)!.n, enabledResume ? 1 : 0);
    if (enabledResume) assert.equal(f.store.acquireRuntimeSemaphoreSlots(inputs).status, "acquired");
    else assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(inputs)).status, "full");
  });
}

for (const dimension of dimensions) {
  test(`unknown retains ${dimension.name} across reopen, while proven no_dispatch releases it exactly once`, async t => {
    const f = await fixture(t);
    installPolicy(f, dimension.limits);
    acquire(f, rootOwner(f));
    const child = spawn(f.host, `unknown-${dimension.name}`), unresolved = settle(f.host, child, "unknown");
    assert.equal(unresolved.state, "unresolved");
    assert.equal(unresolved.settledAt, undefined);
    f.peerHost = harness(f, f.reopen("peer"));
    assert.deepEqual(f.peerHost.writer.getDelegationBudgetReservation(child.reservation.id), unresolved);
    spawnFull(f, f.peerHost, `unknown-full-${dimension.name}`);
    const candidate = ordinary(f, `unknown-ordinary-${dimension.name}`, dimension);
    full(f, candidate);
    const released = settle(f.peerHost, child, "no_dispatch");
    assert.equal(released.state, "released");
    assert.equal(f.peer.getWorkUnit(child.childWorkUnit.id)!.attemptCount, 0);
    assert.equal(f.peer.getRun(child.childRun.id)!.status, "queued");
    assert.deepEqual(noWrites(f, () => settle(f.host, child, "no_dispatch")), released);
    acquire(f, candidate, f.peer);
    spawnFull(f, f.host, `replacement-full-${dimension.name}`);
  });
}

test("a claimed uncertain child cannot manufacture no_dispatch to free its reserved workspace place", async t => {
  const f = await fixture(t);
  installPolicy(f, { maxConcurrentRuns: 2 });
  acquire(f, rootOwner(f));
  const child = spawn(f.host, "claimed-no-dispatch"), claimed = claim(f.host, child);
  assert.equal(claimed.attempt.status, "created");
  noWrites(f, () => assert.throws(() => settle(f.host, child, "no_dispatch"), { code: "delegation.settlement_incomplete" }));
  assert.equal(lifecycle(f.host).classifyDelegatedChildRecovery(child.reservation.id).kind, "dispatch_outcome_unknown");
  spawnFull(f, f.peerHost, "claimed-no-dispatch-full");
});

for (const dimension of dimensions) {
  test(`a genuinely interrupted child releases ${dimension.name}, and full resume creates no Attempt or control`, async t => {
    const f = await resumedDelegationFixture(t) as ResumedFixture;
    f.peer = createSqliteRunStore(f.cwd, f.store.paths);
    t.after(() => f.peer!.close());
    installPolicy(f, dimension.limits);
    const parent = rootOwner(f), current = { run: f.run, unit: f.unit, attempt: f.attempt, fence: f.fence, providerKey };
    acquire(f, parent); acquire(f, current, f.peer);
    const candidate = ordinary(f, `interrupt-rival-${dimension.name}`, dimension);
    const toolCallId = `capacity-stop-${dimension.name}`;
    f.tool(f.source, "tool_start", "bash", toolCallId);
    const operation = f.store.admitHostOperation({ operationId: toolCallId, source: f.source,
      kind: "command", toolCallId });
    f.store.settleHostOperation(operation, { kind: "known_no_start" });
    f.command(f.source, toolCallId);
    f.tool(f.source, "tool_end", "bash", toolCallId);
    let drain!: () => void;
    // Controlled Host no-launch evidence; the original lifetime must still drain before release.
    const completion = f.store.trackHostAttemptCompletion(f.source, new Promise<void>(resolve => { drain = resolve; }), () => [toolCallId]);
    try {
      assert.equal(f.lifecycle.requestDelegatedChildInterrupt({ reservationId: f.child.reservation.id,
        parentFence: f.capture.sourceFence, callId: `capacity-interrupt-${dimension.name}`, now: capabilityNow() }).step.state, "interrupting");
      noWrites(f, () => assert.throws(() => f.lifecycle.commitDelegatedChildInterrupted({ reservationId: f.child.reservation.id,
        sourceFence: f.fence, now: capabilityNow() }), { code: "delegation.recovery_required" }));
      full(f, candidate);
      assert.equal(exactSlots(f, current).length, 2);
    } finally { drain(); await completion; }
    const completed = f.peer.getHostAttemptCompletion(f.source)!;
    assert.ok(completed.drainedAt);
    assert.equal(completed.effectCoverage, "pi_tracked_tools_v1");
    const stopped = f.lifecycle.commitDelegatedChildInterrupted({ reservationId: f.child.reservation.id,
      sourceFence: f.fence, now: capabilityNow() });
    assert.equal(stopped.step.state, "interrupted");
    assert.equal(stopped.attempt!.status, "cancelled");
    assert.equal(stopped.reservation.state, "reserved", "logical budget ownership remains while physical capacity is released");
    assert.equal(stopped.run.status, "running");
    assert.equal(exactSlots(f, current).length, 0);
    assert.equal(exactSlots(f, parent).length, 2);
    acquire(f, candidate, f.peer);
    const input = { reservationId: f.child.reservation.id, expectedStepRevision: stopped.step.revision,
      runtimeInstanceId: `capacity-resume-${dimension.name}`, parentFence: f.capture.sourceFence,
      callId: `capacity-resume-${dimension.name}`, now: capabilityNow() };
    const attemptsBefore = f.store.listWorkUnitAttempts(f.unit.id).length, controlsBefore = count(f, "delegation_messages");
    noWrites(f, () => assert.throws(() => f.lifecycle.resumeDelegatedChild(input), { code: "delegation.capacity_exhausted" }));
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, attemptsBefore);
    assert.equal(count(f, "delegation_messages"), controlsBefore);
    assert.equal(f.peer.releaseRuntimeSemaphoreSlotsForAttempt(candidate.fence, capabilityNow(), "controlled fixture stop"), 2);
    const resumed = f.lifecycle.resumeDelegatedChild({ ...input, now: capabilityNow() });
    assert.equal(resumed.replayed, false);
    assert.equal(resumed.attempt.attemptNumber, current.attempt.attemptNumber + 1);
    assert.equal(resumed.run.id, f.run.id);
    assert.equal(resumed.reservation.deadlineAt, f.child.reservation.deadlineAt);
    assert.equal(exactSlots(f, childOwner(resumed)).length, 0);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, attemptsBefore + 1);
    assert.equal(count(f, "delegation_messages"), controlsBefore + 1);
    full(f, ordinary(f, `resume-rival-${dimension.name}`, dimension));
    installPolicy(f, { maxConcurrentRuns: 1, maxWorkspaceWriteRuns: 1, maxRunsPerProvider: 1, maxRunsPerRunner: 1 });
    const replay = noWrites(f, () => f.lifecycle.resumeDelegatedChild({ ...input, now: capabilityNow() }));
    assert.equal(replay.replayed, true);
    assert.equal(replay.attempt.id, resumed.attempt.id);
  });
}

for (const first of ["preparing", "delegation"]) {
  test(`${first} and the other admission entry share the same workspace place without half writes`, async t => {
    const f = await fixture(t);
    installPolicy(f, { maxConcurrentRuns: 2 });
    acquire(f, rootOwner(f));
    const scope = f.scope(`mixed-${first}`), input = f.input(scope);
    if (first === "preparing") {
      const generation = f.begin(scope, input);
      spawnFull(f, f.peerHost, "preparing-blocks-spawn");
      assert.equal(f.release(scope, generation).status, "released");
      assert.equal(spawn(f.peerHost, "preparing-blocks-spawn").reservation.state, "reserved");
    } else {
      const child = spawn(f.peerHost, "spawn-blocks-preparing");
      const result = noWrites(f, () => f.store.beginChannelWorkflowStepStart(input));
      assert.equal(result.status, "conflict");
      assert.equal(result.code, "workflow_admission_resource_conflict");
      assert.equal(f.current(scope).taskId, undefined);
      assert.equal(settle(f.peerHost, child, "no_dispatch").state, "released");
      assert.equal(f.store.beginChannelWorkflowStepStart(input).status, "begun");
    }
  });
}

for (const dimension of dimensions) {
  test(`independent spawn Workers reserve only the final ${dimension.name} place`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    installPolicy(f, dimension.limits);
    acquire(f, rootOwner(f));
    const before = { runs: count(f, "run_sessions"), units: count(f, "work_units"), attempts: count(f, "work_unit_attempts") };
    const calls = [`race-left-${dimension.name}`, `race-right-${dimension.name}`], results = await race(t, f,
      calls.map(name => ({ method: "spawn" as const, input: spawnInput(name) })));
    assert.equal(results.filter(result => result.type === "result").length, 1);
    const loser = results.find(result => result.type !== "result")!, winner = results.find(result => result.type === "result")!.result;
    assert.equal(loser.type, "rejected");
    assert.equal(loser.code, "delegation.capacity_exhausted");
    assert.equal(winner.reservation.state, "reserved");
    assert.equal(count(f, "run_sessions"), before.runs + 1);
    assert.equal(count(f, "work_units"), before.units + 1);
    assert.equal(count(f, "work_unit_attempts"), before.attempts);
    assert.equal(count(f, "delegation_steps"), 1);
    assert.equal(count(f, "delegation_budget_reservations"), 1);
    assert.equal(count(f, "runtime_semaphore_slots"), 2);
    assert.equal(f.peer.getWorkUnit(winner.childWorkUnit.id)!.activeAttemptId, undefined);
    const call = calls[results.findIndex(result => result.type === "result")];
    assert.equal(noWrites(f, () => spawn(f.peerHost, call)).childRun.id, winner.childRun.id);
  });
}

test("spawn and ordinary batch Workers cannot both take the final workspace place", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  installPolicy(f, { maxConcurrentRuns: 2 });
  acquire(f, rootOwner(f));
  const candidate = ordinary(f, "spawn-batch-rival", { runner: "codex" });
  const results = await race(t, f, [{ method: "spawn", input: spawnInput("spawn-batch") },
    { method: "acquireRuntimeSemaphoreSlots", input: slots(candidate) }]);
  assert.equal(results[1].type, "result");
  const spawned = results[0].type === "result", acquired = results[1].result.status === "acquired";
  assert.notEqual(spawned, acquired);
  if (!spawned) assert.equal(results[0].code, "delegation.capacity_exhausted");
  assert.equal(results[1].result.status, acquired ? "acquired" : "full");
  assert.equal(count(f, "delegation_steps"), Number(spawned));
  assert.equal(count(f, "delegation_budget_reservations"), Number(spawned));
  assert.equal(exactSlots(f, candidate).length, 2 * Number(acquired));
  assert.equal(count(f, "runtime_semaphore_slots"), 2 + 2 * Number(acquired));
});

test("workflow preparing and spawn Workers reserve only one shared final workspace place", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  installPolicy(f, { maxConcurrentRuns: 2 });
  acquire(f, rootOwner(f));
  const scope = f.scope("spawn-preparing-race"), input = f.input(scope), tasksBefore = count(f, "tasks");
  const results = await race(t, f, [{ method: "spawn", input: spawnInput("spawn-preparing-race") },
    { method: "beginChannelWorkflowStepStart", input }]);
  assert.equal(results[1].type, "result");
  const spawned = results[0].type === "result", begun = results[1].result.status === "begun";
  assert.notEqual(spawned, begun);
  if (!spawned) assert.equal(results[0].code, "delegation.capacity_exhausted");
  assert.equal(results[1].result.status, begun ? "begun" : "conflict");
  assert.equal(count(f, "tasks"), tasksBefore + Number(begun));
  assert.equal(count(f, "workflow_step_admissions"), Number(begun));
  assert.equal(count(f, "workflow_step_admission_entries"), (scope.plan.entries.length + scope.plan.resourceKeys.length) * Number(begun));
  assert.equal(count(f, "delegation_steps"), Number(spawned));
  assert.equal(count(f, "delegation_budget_reservations"), Number(spawned));
  assert.equal(count(f, "runtime_semaphore_slots"), 2);
});
