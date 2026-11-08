/// <reference lib="es2023.array" />

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, resolveStoragePaths,
  type AcquireRuntimeSemaphoreSlotInput, type RuntimeInstance } from "../../core/dist/index.js";
import { testDatabase } from "../../core/test/support/sqlite-test-database.ts";
import type { ResolvedDaemonConfig } from "../dist/config.js";
import type { ResolvedRuntimeConcurrencyPolicy, RuntimeConcurrencyFeatureConfig } from "../dist/runtime/concurrency-policy.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

const prefix = "ling-runtime-concurrency-supervisor-";
const defaults = { enabled: false, maxConcurrentRuns: 4, maxReadOnlyRuns: 4, maxWorkspaceWriteRuns: 2,
  maxRunsPerProvider: 4, maxRunsPerRunner: 4, isolatedWriteMaxConcurrentSteps: 2 };
const explicit = { enabled: true, maxConcurrentRuns: 8, maxReadOnlyRuns: 6, maxWorkspaceWriteRuns: 3,
  maxRunsPerProvider: 5, maxRunsPerRunner: 7, isolatedWriteMaxConcurrentSteps: 3 };
const raised = { enabled: true, maxConcurrentRuns: 12, maxReadOnlyRuns: 10, maxWorkspaceWriteRuns: 4,
  maxRunsPerProvider: 11, maxRunsPerRunner: 9, isolatedWriteMaxConcurrentSteps: 4 };
const lowered = { enabled: true, maxConcurrentRuns: 1, maxReadOnlyRuns: 1, maxWorkspaceWriteRuns: 1,
  maxRunsPerProvider: 1, maxRunsPerRunner: 1, isolatedWriteMaxConcurrentSteps: 2 };
const limits = (policy: ResolvedRuntimeConcurrencyPolicy) => {
  const { enabled, isolatedWriteMaxConcurrentSteps, ...persisted } = policy;
  return persisted;
};

/** Real isolated stores and owner sidecars; no listener, Provider or Runner is started. */
async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, prefix));
  const cwd = join(root, "workspace"), stores: ReturnType<typeof createSqliteRunStore>[] = [], supervisors: RuntimeSupervisor[] = [];
  t.after(async () => {
    try { for (const supervisor of supervisors.toReversed()) supervisor.releaseAll(); }
    finally {
      try { for (const store of stores.toReversed()) if (testDatabase(store).isOpen) store.close(); }
      finally {
        assert.equal(dirname(root), parent);
        assert.ok(basename(root).startsWith(prefix));
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  await mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { userRootDir: join(root, "ling-home"),
    workspaceStateLocation: "user-data-dir" }).workspace;
  assert.ok(!relative(root, paths.rootDir).startsWith(".."));
  const open = () => {
    const store = createSqliteRunStore(cwd, paths);
    stores.push(store);
    assert.equal(testDatabase(store).prepare("SELECT name FROM schema_migrations WHERE version=214").get()?.name,
      "runtime_concurrency_policies", "the fixture requires the installed concurrency policy migration");
    assert.equal(testDatabase(store).prepare("SELECT name FROM schema_migrations WHERE version=215").get()?.name,
      "runtime_concurrency_policy_activation", "the fixture requires the persisted activation state");
    return store;
  };
  const config = (concurrency?: RuntimeConcurrencyFeatureConfig) => ({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    runners: {}, runtimeTools: {}, channels: {}, sandbox: {}, harness: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true },
    ...(concurrency === undefined ? {} : { concurrency }) });
  const supervisor = (input = config()) => {
    // Startup-only fixtures omit unrelated resolved daemon features.
    const supervisor = new RuntimeSupervisor(input as ResolvedDaemonConfig);
    supervisors.push(supervisor);
    return supervisor;
  };
  const store = open(), peer = open(), lockPath = join(paths.rootDir, "runtime.lock");
  const f = { cwd, paths, lockPath, open, config, supervisor, store, peer,
    policy: (store = peer) => store.getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID),
    rows: (tables: string[]) => Object.fromEntries(tables.map(table =>
      [table, testDatabase(peer).prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    lock: () => readFileSync(lockPath, "utf8"),
  };
  return f;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function assertPolicy(f: Fixture, runtime: RuntimeInstance, expected: ResolvedRuntimeConcurrencyPolicy, revision: number) {
  const policy = { workspaceId: DEFAULT_WORKSPACE_ID, runtimeInstanceId: runtime.runtimeInstanceId,
    revision, enabled: expected.enabled, limits: limits(expected), installedAt: runtime.startedAt };
  for (const store of [f.store, f.peer]) assert.deepEqual(f.policy(store), policy);
  assert.equal(JSON.parse(f.lock()).runtimeInstanceId, runtime.runtimeInstanceId);
  return policy;
}

/** Probe the actual SQLite writer lease, never the diagnostic PID or isTransaction. */
function assertOwnerLease(f: Fixture, held: boolean) {
  const sidecar = `${f.lockPath}.coordination.sqlite`;
  assert.ok(existsSync(sidecar));
  const database = new DatabaseSync(sidecar);
  let began = false;
  try {
    database.exec("PRAGMA busy_timeout=0");
    const begin = () => { database.exec("BEGIN IMMEDIATE"); began = true; };
    // SQLite busy errors carry a numeric errcode outside the standard Error shape.
    if (held) assert.throws(begin, (error: unknown) => typeof (error as { errcode?: unknown } | undefined)?.errcode === "number"
      && ((error as { errcode: number }).errcode & 0xff) === 5);
    else begin();
  } finally {
    if (began) database.exec("ROLLBACK");
    database.close();
  }
}

function assertStartupReleased(f: Fixture) {
  assert.equal(existsSync(f.lockPath), false, "no failed-startup projection may remain published");
  assertOwnerLease(f, false);
}

function failOnce(store: Fixture["store"], method: "installRuntimeConcurrencyPolicy" | "listWorkUnits" | "expireRuntimeSemaphoreSlots",
  failure: Error, after = false) {
  let armed = true;
  return new Proxy(store, { get(target, name) {
    const value: unknown = Reflect.get(target, name, target);
    if (name !== method) return typeof value === "function" ? value.bind(target) : value;
    return (...args: unknown[]) => {
      if (armed && !after) { armed = false; throw failure; }
      const result: unknown = (value as (...args: unknown[]) => unknown).apply(target, args);
      if (armed) { armed = false; throw failure; }
      return result;
    };
  } });
}

for (const [name, input, expected] of [
  ["omitted defaults", undefined, defaults], ["empty defaults", {}, defaults],
  ["explicit limits", explicit, explicit],
  ["partial limits", { maxConcurrentRuns: 9, maxRunsPerRunner: 2 },
    { ...defaults, maxConcurrentRuns: 9, maxRunsPerRunner: 2 }],
] satisfies readonly [string, RuntimeConcurrencyFeatureConfig | undefined, ResolvedRuntimeConcurrencyPolicy][]) {
  test(`startup installs ${name} under the real workspace owner`, async t => {
    const f = await fixture(t), supervisor = f.supervisor(f.config(input));
    assert.equal(f.policy(), undefined);
    const runtime = supervisor.getRuntime(f.cwd, f.store);
    assertPolicy(f, runtime, expected, 1);
    assert.deepEqual(supervisor.getConcurrencyPolicy(), expected);
    assert.ok(Object.isFrozen(supervisor.getConcurrencyPolicy()));
    assertOwnerLease(f, true);
    assert.strictEqual(supervisor.getRuntime(f.cwd, f.peer), runtime);
    assertPolicy(f, runtime, expected, 1);
  });
}

test("constructor captures concurrency before startup and ignores later input mutation or replacement", async t => {
  const f = await fixture(t), input = { ...explicit }, config = f.config(input);
  const supervisor = f.supervisor(config);
  assert.notStrictEqual(supervisor.getConcurrencyPolicy(), input);
  assert.equal(Object.isFrozen(input), false);
  Object.assign(input, raised);
  config.concurrency = { ...lowered };
  const runtime = supervisor.getRuntime(f.cwd, f.store);
  assertPolicy(f, runtime, explicit, 1);
  Object.assign(input, lowered);
  // @ts-expect-error A captured policy must ignore even a later malformed replacement.
  config.concurrency = null;
  assert.deepEqual(supervisor.getConcurrencyPolicy(), explicit);
  assert.throws(() => {
    // @ts-expect-error The readonly policy must remain immutable at runtime.
    supervisor.getConcurrencyPolicy().maxConcurrentRuns = 64;
  }, TypeError);
  assert.strictEqual(supervisor.getRuntime(f.cwd, f.open()), runtime);
  assertPolicy(f, runtime, explicit, 1);
});

test("default and numeric-only startup keep legacy admission; explicit restart toggles preserve existing slots", async t => {
  const f = await fixture(t);
  const numeric = { maxConcurrentRuns: 1, maxReadOnlyRuns: 1, maxWorkspaceWriteRuns: 1,
    maxRunsPerProvider: 1, maxRunsPerRunner: 1 };
  const initial = f.supervisor(f.config(numeric)), runtime = initial.getRuntime(f.cwd, f.store);
  assertPolicy(f, runtime, { ...defaults, ...numeric }, 1);
  const acquiredAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const prepare = (name: string): AcquireRuntimeSemaphoreSlotInput[] => {
    const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
      ownerId: `activation-task-${name}`, idempotencyKey: `activation-unit-${name}`, createdByActor: "system", request: {}, now: acquiredAt });
    const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", now: acquiredAt });
    return ([{ resourceType: "provider", resourceKey: "activation-provider" }, { resourceType: "runner", resourceKey: "pi" }] satisfies
      Pick<AcquireRuntimeSemaphoreSlotInput, "resourceType" | "resourceKey">[])
      .map(entry => ({ ...entry, workspaceId: DEFAULT_WORKSPACE_ID, workUnitId: unit.id, attemptId: attempt.id,
        runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
        ownerType: "work_unit_attempt" as const, ownerId: attempt.id, limit: 4, acquiredAt, expiresAt }));
  };
  for (let index = 0; index < 3; index++) assert.equal(f.store.acquireRuntimeSemaphoreSlots(prepare(`original-${index}`)).status, "acquired");
  const candidate = prepare("candidate"), tables = ["work_units", "work_unit_attempts", "runtime_semaphore_slots", "resource_leases"];
  const before = f.rows(tables);
  initial.releaseAll();
  const enabled = f.supervisor(f.config({ ...numeric, enabled: true }));
  assertPolicy(f, enabled.getRuntime(f.cwd, f.store), { ...defaults, ...numeric, enabled: true }, 2);
  assert.deepEqual(f.rows(tables), before, "enabling cannot erase legacy owners to fit a smaller policy");
  assert.equal(f.peer.acquireRuntimeSemaphoreSlots(candidate).status, "full");
  assert.deepEqual(f.rows(tables), before);
  enabled.releaseAll();
  const disabled = f.supervisor(f.config(numeric));
  assertPolicy(f, disabled.getRuntime(f.cwd, f.store), { ...defaults, ...numeric }, 3);
  assert.deepEqual(f.rows(tables), before, "disabling changes policy, not execution facts");
  assert.equal(f.peer.acquireRuntimeSemaphoreSlots(candidate).status, "acquired");
  assert.equal(f.peer.acquireRuntimeSemaphoreSlots(prepare("legacy-fifth")).status, "full", "legacy four-slot limits still apply");
  assert.equal(f.peer.listRuntimeSemaphoreSlots({ status: "active", limit: 100 }).length, 8);
});

test("fresh Store handles on the same root read the installed revision without reinstalling", async t => {
  const f = await fixture(t), supervisor = f.supervisor(f.config(explicit));
  const runtime = supervisor.getRuntime(f.cwd, f.store), expected = assertPolicy(f, runtime, explicit, 1);
  const before = f.rows(["runtime_concurrency_policies"]), bytes = f.lock();
  for (let index = 0; index < 2; index++) {
    const store = f.open();
    assert.notStrictEqual(testDatabase(store), testDatabase(f.store));
    assert.equal(store.paths.rootDir, f.paths.rootDir);
    assert.deepEqual(f.policy(store), expected);
    assert.strictEqual(supervisor.getRuntime(f.cwd, store), runtime);
  }
  assert.deepEqual(f.rows(["runtime_concurrency_policies"]), before);
  assert.equal(f.lock(), bytes);
});

const policyDrift: [string, string, SQLInputValue[]][] = [
  ["missing policy", "DELETE FROM runtime_concurrency_policies WHERE workspace_id=?", []],
  ["foreign runtime", "UPDATE runtime_concurrency_policies SET runtime_instance_id=? WHERE workspace_id=?", ["foreign-runtime"]],
  ["activation", "UPDATE runtime_concurrency_policies SET enabled=? WHERE workspace_id=?", [0]],
  ...Object.entries({ maxConcurrentRuns: "max_concurrent_runs", maxReadOnlyRuns: "max_read_only_runs",
    maxWorkspaceWriteRuns: "max_workspace_write_runs", maxRunsPerProvider: "max_runs_per_provider",
    maxRunsPerRunner: "max_runs_per_runner" }).map(([field, column]) =>
    [field, `UPDATE runtime_concurrency_policies SET ${column}=? WHERE workspace_id=?`,
      [explicit[field as Exclude<keyof typeof explicit, "enabled">] - 1]] as [string, string, SQLInputValue[]]),
];
for (const [name, sql, args] of policyDrift) {
  test(`cached runtime rejects ${name} through both existing and fresh Store handles`, async t => {
    const f = await fixture(t), supervisor = f.supervisor(f.config(explicit));
    supervisor.getRuntime(f.cwd, f.store);
    testDatabase(f.peer).prepare(sql).run(...args, DEFAULT_WORKSPACE_ID);
    const fresh = f.open(), before = f.rows(["runtime_concurrency_policies"]), bytes = f.lock();
    for (const store of [f.store, f.peer, fresh]) {
      assert.throws(() => supervisor.getRuntime(f.cwd, store), { message: "runtime_concurrency_policy_changed" });
    }
    assert.deepEqual(f.rows(["runtime_concurrency_policies"]), before, "cached reads cannot repair or reinstall policy");
    assert.equal(f.lock(), bytes);
    assertOwnerLease(f, true);
  });
}

test("a second Supervisor cannot replace policy or reconcile a live owner's Attempt", async t => {
  const f = await fixture(t), owner = f.supervisor(), contender = f.supervisor(f.config(raised));
  const runtime = owner.getRuntime(f.cwd, f.store), now = new Date().toISOString();
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
    ownerId: "concurrency-live-task", idempotencyKey: "concurrency-live-unit", status: "running",
    createdByActor: "system", request: {}, now });
  f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", status: "started", now });
  const tables = ["runtime_concurrency_policies", "work_units", "work_unit_attempts", "runtime_events"];
  const before = f.rows(tables), bytes = f.lock();
  assert.throws(() => contender.getRuntime(f.cwd, f.peer), (error: unknown) =>
    (error as { code?: unknown } | undefined)?.code === "runtime_already_running");
  contender.releaseAll();
  assert.deepEqual(f.rows(tables), before);
  assert.equal(f.lock(), bytes);
  assert.strictEqual(owner.getRuntime(f.cwd, f.peer), runtime);
  assertOwnerLease(f, true);
});

test("released owners permit raised and lowered revisions without rewriting historical policy or authority", async t => {
  const f = await fixture(t), now = new Date().toISOString();
  const channel = f.store.createChannel({ name: "Historical read-only channel", boundPath: f.cwd,
    allowedTools: ["read"], runtimePolicy: { maxConcurrentRuns: 1 } }, now);
  const workflow = f.store.createChannelWorkflow({ channelId: channel.id, title: "Historical workflow",
    objective: "Retain accepted authority", status: "ready", createdBy: "local-user" }, now);
  const step = f.store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Read only", prompt: "Read the input",
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer", metadata: { policy: {
      onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: false,
    } } }, now);
  const task = f.store.createTask({ channelId: channel.id, title: "Historical task", prompt: "Read only" }, now);
  const run = f.store.createRun({ id: "concurrency-historical-run", cwd: f.cwd, taskId: task.id, channelId: channel.id,
    workflowStepId: step.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: task,
    providerSnapshot: {}, requestSnapshot: { cwd: f.cwd, tools: ["read"], workflowStepId: step.id,
      participantAuthority: step.participantAuthority }, createdAt: now });
  f.store.createApprovalRequest({ runId: run.id, taskId: task.id, channelId: channel.id,
    toolCallId: "concurrency-historical-bash", actionType: "bash", risk: "medium", title: "Pending write approval",
    description: "Do not grant permission through operational concurrency limits",
    payload: { type: "bash", cwd: f.cwd, command: "printf fixture", riskFlags: [] } }, now);
  const tables = ["channels", "channel_workflows", "channel_workflow_steps", "tasks", "run_sessions",
    "approval_requests", "approval_checkpoints"];
  const history = f.rows(tables), runtimeIds = new Set();
  for (const table of tables) assert.ok(history[table].length, `${table} must contain real historical facts`);
  for (const [index, policy] of [defaults, raised, lowered, lowered].entries()) {
    const supervisor = f.supervisor(f.config(policy)), runtime = supervisor.getRuntime(f.cwd, f.store);
    assert.equal(runtimeIds.has(runtime.runtimeInstanceId), false);
    runtimeIds.add(runtime.runtimeInstanceId);
    const installed = assertPolicy(f, runtime, policy, index + 1);
    assert.deepEqual(f.rows(tables), history);
    assert.deepEqual(f.store.getChannel(channel.id)!.allowedTools, ["read"]);
    assert.equal(f.store.getChannel(channel.id)!.runtimePolicy.maxConcurrentRuns, 1);
    assert.deepEqual(f.store.getChannelWorkflowStep(step.id)!.participantAuthority, step.participantAuthority);
    supervisor.releaseAll();
    assertStartupReleased(f);
    assert.deepEqual(f.policy(), installed, "releasing ownership cannot delete the persisted revision");
    assert.deepEqual(f.rows(tables), history);
  }
});

test("a real SQLite policy-install failure releases ownership and the same Supervisor can retry", async t => {
  const f = await fixture(t), supervisor = f.supervisor(f.config(explicit));
  testDatabase(f.store).exec(`CREATE TRIGGER concurrency_install_fault BEFORE INSERT ON runtime_concurrency_policies
    BEGIN SELECT RAISE(ABORT,'concurrency policy install fault'); END`);
  try {
    assert.throws(() => supervisor.getRuntime(f.cwd, f.store), /concurrency policy install fault/u);
    assert.equal(f.policy(), undefined);
    assertStartupReleased(f);
  } finally { testDatabase(f.store).exec("DROP TRIGGER concurrency_install_fault"); }
  const runtime = supervisor.getRuntime(f.cwd, f.peer);
  assertPolicy(f, runtime, explicit, 1);
  assertOwnerLease(f, true);
});

for (const [name, method, after] of [
  ["committed install", "installRuntimeConcurrencyPolicy", true],
  ["early reconcile", "listWorkUnits", false],
  ["late reconcile", "expireRuntimeSemaphoreSlots", true],
] as const) {
  test(`${name} failure clears the owner and uncached startup retries with a fresh revision`, async t => {
    const f = await fixture(t), supervisor = f.supervisor(f.config(explicit));
    const failure = new Error(`injected ${name} failure`), store = failOnce(f.store, method, failure, after);
    assert.throws(() => supervisor.getRuntime(f.cwd, store), error => error === failure);
    const committed = f.policy()!;
    assert.equal(committed.revision, 1, "the real policy transaction already committed before this failure");
    assert.deepEqual(committed.limits, limits(explicit));
    assertStartupReleased(f);
    const runtime = supervisor.getRuntime(f.cwd, store);
    assert.notEqual(runtime.runtimeInstanceId, committed.runtimeInstanceId, "failed startup cannot leave a cached runtime");
    assertPolicy(f, runtime, explicit, 2);
    assert.strictEqual(supervisor.getRuntime(f.cwd, f.open()), runtime);
    assertOwnerLease(f, true);
  });
}
