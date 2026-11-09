import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowStepExecutionSafety, workflowStepSafetyPlanDigest } from "../dist/index.js";
import { createBudgetHarness } from "./support/delegation-budget-fixture.mjs";
import { workflowAdmissionFixture } from "./support/workflow-step-admission-fixture.mjs";
import type { InstallRuntimeConcurrencyPolicyInput, RuntimeConcurrencyLimits } from "../dist/runtime-concurrency-policy.js";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Fixture = Awaited<ReturnType<typeof workflowAdmissionFixture>>;
type Owner = ReturnType<Fixture["outsider"]>;

const limits = { maxConcurrentRuns: 1, maxReadOnlyRuns: 1, maxWorkspaceWriteRuns: 1,
  maxRunsPerProvider: 1, maxRunsPerRunner: 1 };

function install(f: Fixture, enabled: boolean, overrides: Partial<RuntimeConcurrencyLimits> = {}) {
  const previous = f.peer.getRuntimeConcurrencyPolicy(f.channel.workspaceId);
  const revision = previous?.revision ?? 0;
  const result = f.store.installRuntimeConcurrencyPolicy({ workspaceId: f.channel.workspaceId,
    runtimeInstanceId: `activation-runtime-${revision + 1}`, expectedRevision: revision,
    enabled, limits: { ...limits, ...overrides }, installedAt: f.at(20 + revision) });
  assert.equal(result.status, "installed");
  assert.equal(result.policy.enabled, enabled);
  assert.equal(result.policy.revision, revision + 1);
  assert.deepEqual(f.peer.getRuntimeConcurrencyPolicy(f.channel.workspaceId), result.policy);
  return result.policy;
}

function inputs(f: Fixture, owner: Owner, { provider = "activation-provider", runner = "pi", limit = 4 } = {}) {
  return [{ resourceType: "provider" as const, resourceKey: provider, limit },
    { resourceType: "runner" as const, resourceKey: runner, limit }].map(entry => f.slotInput(owner, entry));
}

function noWrites<T>(f: Fixture, action: () => T): T {
  const before = f.snapshot();
  const policy = testDatabase(f.peer).prepare("SELECT * FROM runtime_concurrency_policies ORDER BY workspace_id").all();
  try { return action(); }
  finally {
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(testDatabase(f.peer).prepare("SELECT * FROM runtime_concurrency_policies ORDER BY workspace_id").all(), policy);
    assert.equal(testDatabase(f.store).isTransaction, false);
    assert.equal(testDatabase(f.peer).isTransaction, false);
  }
}

test("activation is a persisted, immutable policy property with revision and duplicate fencing", async t => {
  const f = await workflowAdmissionFixture(t), first = install(f, false);
  const input = { workspaceId: first.workspaceId, runtimeInstanceId: first.runtimeInstanceId,
    expectedRevision: first.revision, enabled: false, limits: first.limits, installedAt: f.at(60) };
  assert.deepEqual(noWrites(f, () => f.peer.installRuntimeConcurrencyPolicy(input)), { status: "duplicate", policy: first });
  assert.deepEqual(noWrites(f, () => f.peer.installRuntimeConcurrencyPolicy({ ...input, enabled: true })), { status: "changed" });
  assert.deepEqual(noWrites(f, () => f.peer.installRuntimeConcurrencyPolicy({ ...input,
    runtimeInstanceId: "stale-activation-owner", expectedRevision: 0, enabled: true })), { status: "changed" });
  assert.throws(() => {
    // @ts-expect-error Persisted policies must also reject mutation at runtime.
    first.enabled = true;
  }, TypeError);
  f.reopen("peer");
  assert.deepEqual(f.peer.getRuntimeConcurrencyPolicy(first.workspaceId), first);
  const enabled = install(f, true), disabled = install(f, false);
  assert.equal(enabled.revision, 2);
  assert.equal(disabled.revision, 3);
  f.reopen();
  assert.deepEqual(f.store.getRuntimeConcurrencyPolicy(first.workspaceId), disabled);
});

test("invalid activation values and accessors cannot silently opt in or modify policy", async t => {
  const f = await workflowAdmissionFixture(t), policy = install(f, false);
  const input = { workspaceId: policy.workspaceId, runtimeInstanceId: "invalid-activation",
    expectedRevision: policy.revision, limits, installedAt: f.at(60) };
  for (const enabled of [undefined, null, 0, 1, "true", "false", {}, [], new Boolean(false)]) {
    noWrites(f, () => assert.throws(() => f.peer.installRuntimeConcurrencyPolicy({ ...input,
      enabled: enabled as InstallRuntimeConcurrencyPolicyInput["enabled"] }), TypeError));
  }
  let invoked = false;
  noWrites(f, () => assert.throws(() => f.peer.installRuntimeConcurrencyPolicy(Object.defineProperty(input, "enabled", {
    get() { invoked = true; return true; },
  })), TypeError));
  assert.equal(invoked, false);
});

test("disabled policy retains legacy Provider/Runner limits instead of imposing new total or write ceilings", async t => {
  const f = await workflowAdmissionFixture(t);
  install(f, false);
  for (let index = 0; index < 4; index++) {
    const owner = f.outsider(`legacy-${index}`);
    assert.equal(f.peer.acquireRuntimeSemaphoreSlots(inputs(f, owner)).status, "acquired");
  }
  const fifth = f.outsider("legacy-fifth");
  assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(inputs(f, fifth))).status, "full");
  const independent = f.outsider("legacy-independent");
  assert.equal(f.peer.acquireRuntimeSemaphoreSlots(inputs(f, independent,
    { provider: "independent-provider", runner: "independent-runner" })).status, "acquired");
  assert.equal(f.count("runtime_semaphore_slots"), 10);
  f.reopen("peer");
  const next = f.outsider("legacy-reopened");
  assert.equal(f.peer.acquireRuntimeSemaphoreSlots(inputs(f, next,
    { provider: "reopened-provider", runner: "reopened-runner" })).status, "acquired");
});

test("disabling a large operational limit does not increase a frozen legacy resource limit", async t => {
  const f = await workflowAdmissionFixture(t);
  install(f, false, { maxConcurrentRuns: 64, maxRunsPerProvider: 64, maxRunsPerRunner: 64 });
  const first = f.outsider("semantic-first"), second = f.outsider("semantic-second");
  assert.equal(f.store.acquireRuntimeSemaphoreSlots(inputs(f, first, { limit: 1 })).status, "acquired");
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(inputs(f, second, { limit: 1 }))).status, "full");
  assert.equal(f.count("runtime_semaphore_slots"), 2);
});

for (const dimension of ["maxConcurrentRuns", "maxWorkspaceWriteRuns", "maxRunsPerProvider", "maxRunsPerRunner"]) {
  test(`enable/disable preserves exact owners while toggling ${dimension} for new admission`, async t => {
    const f = await workflowAdmissionFixture(t);
    const ceilings = { maxConcurrentRuns: 64, maxReadOnlyRuns: 64, maxWorkspaceWriteRuns: 4,
      maxRunsPerProvider: 64, maxRunsPerRunner: 64, [dimension]: 1 };
    install(f, false, ceilings);
    const holder = f.outsider(`holder-${dimension}`), candidate = f.outsider(`candidate-${dimension}`);
    assert.equal(f.store.acquireRuntimeSemaphoreSlots(inputs(f, holder)).status, "acquired");
    const scope = f.scope(`resource-${dimension}`);
    f.lease(scope);
    const before = f.snapshot();
    install(f, true, ceilings);
    assert.deepEqual(f.snapshot(), before, "activation cannot mutate original execution or resource ownership");
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(inputs(f, candidate))).status, "full");
    install(f, false, ceilings);
    assert.deepEqual(f.snapshot(), before, "disabling the policy cannot release or rewrite active resources");
    f.reopen("peer");
    assert.equal(f.peer.acquireRuntimeSemaphoreSlots(inputs(f, candidate)).status, "acquired");
    install(f, true, ceilings);
    const third = f.outsider(`third-${dimension}`);
    assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(inputs(f, third))).status, "full");
    assert.equal(f.count("runtime_semaphore_slots"), 4, "both legacy owners remain visible after re-enabling a smaller limit");
  });
}

test("preparing reservations retain authority across activation and transfer without re-admitting capacity", async t => {
  const f = await workflowAdmissionFixture(t);
  install(f, false);
  const scope = (name: string) => f.scope(name, { plan: f.plan({ resourceKeys: [`repository:activation-${name}`] }) });
  const first = scope("preparing-first"), second = scope("preparing-second");
  const firstStart = f.begin(first), secondStart = f.begin(second);
  const before = f.snapshot();
  install(f, true);
  assert.deepEqual(f.snapshot(), before);
  const blocked = scope("preparing-blocked"), request = f.input(blocked);
  assert.equal(noWrites(f, () => f.peer.beginChannelWorkflowStepStart(request)).status, "conflict");
  const prepared = f.prepare(first, firstStart, "activation-transfer");
  assert.equal(f.transfer(first, firstStart, prepared).status, "transferred");
  assert.equal(f.admission(second, secondStart)!.status, "preparing");
  const retained = f.snapshot();
  install(f, false);
  assert.deepEqual(f.snapshot(), retained);
  assert.equal(f.peer.beginChannelWorkflowStepStart(request).status, "begun");
});

test("disabling a higher operational cap retains an exact preparing handoff above the legacy cap", async t => {
  const f = await workflowAdmissionFixture(t);
  install(f, true, { maxConcurrentRuns: 64, maxReadOnlyRuns: 64, maxWorkspaceWriteRuns: 4,
    maxRunsPerProvider: 64, maxRunsPerRunner: 64 });
  const scope = f.scope("high-cap-handoff", { plan: f.plan({ entries: [
    { resourceType: "provider", resourceKey: "activation-provider", limit: 4 },
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
  const start = f.begin(scope);
  for (let index = 0; index < 4; index++) {
    assert.equal(f.store.acquireRuntimeSemaphoreSlots(inputs(f, f.outsider(`high-cap-${index}`))).status, "acquired");
  }
  const prepared = f.prepare(scope, start, "high-cap-handoff"), retained = f.snapshot();
  install(f, false);
  assert.deepEqual(f.snapshot(), retained);
  f.reopen("peer");
  const candidate = f.outsider("after-high-cap-disabled");
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(inputs(f, candidate))).status, "full");
  assert.equal(f.transfer(scope, start, prepared, {}, f.peer).status, "transferred");
  assert.equal(noWrites(f, () => f.transfer(scope, start, prepared)).status, "duplicate");
  assert.equal(f.count("runtime_semaphore_slots"), 12);
  assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(inputs(f, candidate))).status, "full");
});

test("dynamic reservations survive disable/re-enable and capacity failures create no waiting child", async t => {
  const f = await workflowAdmissionFixture(t);
  const host = createBudgetHarness(f.cwd, { store: f.store, now: f.at(0), later: f.at(1), budget: { tokenBudget: 1_000 } });
  host.freeze(); host.start();
  install(f, false);
  for (let index = 0; index < 3; index++) {
    assert.equal(host.spawn({ spawnCallId: `activation-child-${index}`, requestedBudget: { tokenBudget: 10 }, now: f.at(2) }).reservation.state,
      "reserved");
  }
  const reservations = () => testDatabase(f.peer).prepare("SELECT * FROM delegation_budget_reservations ORDER BY id").all();
  const before = reservations();
  install(f, true);
  noWrites(f, () => assert.throws(() => host.spawn({ spawnCallId: "activation-full", now: f.at(3) }),
    { code: "delegation.capacity_exhausted" }));
  assert.deepEqual(reservations(), before);
  const ordinary = f.outsider("alongside-reservations");
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(inputs(f, ordinary))).status, "full");
  install(f, false);
  assert.deepEqual(reservations(), before);
  assert.equal(f.peer.acquireRuntimeSemaphoreSlots(inputs(f, ordinary)).status, "acquired");
  install(f, true);
  assert.deepEqual(reservations(), before);
  assert.equal(f.count("delegation_steps"), 3);
});
