import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";
import { createSqliteRunStoreFixture } from "./support/sqlite-run-store-fixture.mjs";
import { testDatabase } from "./support/sqlite-test-database.ts";

const now = "2026-11-17T00:00:00.000Z";
const teammateId = "teammate_builtin_engineer";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-workspace-binding-fence-"));
  const store = createSqliteRunStoreFixture(cwd);
  const other = createSqliteRunStore(cwd);
  testDatabase(other).exec("PRAGMA busy_timeout=0");
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const binding = { mode: "managed_worktree", status: "ready", worktreePath: join(cwd, "managed"),
    executionPath: join(cwd, "managed"), branchName: "ling/test", updatedAt: now } as const;
  const channel = store.createChannel({ name: "Engineering", boundPath: cwd, workspaceBinding: binding }, now);
  const thread = store.getOrCreateTeammateDirectThread(teammateId, now);
  store.updateTeammateDirectThreadWorkspace(thread.id, binding, now);
  return { cwd, store, other, binding, channel, thread };
}

test("owner mutations hold the SQLite writer before checking the lifecycle fence", async t => {
  const f = await fixture(t);
  const assertFence = f.store.assertWorkspaceSnapshotFence.bind(f.store);
  let checks = 0;
  f.store.assertWorkspaceSnapshotFence = (cwd) => {
    assertFence(cwd);
    assert.throws(() => f.other.acquireWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, "contender", now), /locked/);
    checks++;
  };
  const created = f.store.createChannel({ name: "Another", boundPath: f.binding.worktreePath }, now);
  f.store.updateChannel(f.channel.id, { name: "Renamed" }, now);
  f.store.updateTeammateDirectThreadWorkspace(f.thread.id, { ...f.binding, status: "not_created" }, now);
  assert.equal(f.store.deleteChannel(created.id), true);
  assert.equal(checks, 4);
  assert.equal(f.other.getWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID).ownerRequestId, undefined);
  assert.equal(f.other.getChannel(f.channel.id)?.name, "Renamed");
});

test("owner writes compose with a caller transaction and roll back together", async t => {
  const f = await fixture(t);
  const database = testDatabase(f.store);
  database.exec("BEGIN IMMEDIATE");
  const created = f.store.createChannel({ name: "Temporary", boundPath: f.cwd }, now);
  f.store.updateChannel(f.channel.id, { name: "Temporary name" }, now);
  f.store.updateTeammateDirectThreadWorkspace(f.thread.id, null, now);
  database.exec("ROLLBACK");
  assert.equal(f.store.getChannel(created.id), undefined);
  assert.equal(f.store.getChannel(f.channel.id)?.name, "Engineering");
  assert.equal(f.store.getOrCreateTeammateDirectThread(teammateId, now).workspaceBinding?.worktreePath, f.binding.worktreePath);
});

test("a durable lifecycle fence rejects binding changes, owner deletion and metadata rewrites", async t => {
  const f = await fixture(t);
  const epoch = f.store.acquireWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, "cleanup", now);
  assert.throws(() => f.other.createChannel({ name: "Late owner", boundPath: f.binding.worktreePath }, now), /fence/);
  assert.throws(() => f.other.updateChannel(f.channel.id, { workspaceBinding: null }, now), /fence/);
  assert.throws(() => f.other.updateChannel(f.channel.id, { name: "Late rename" }, now), /fence/);
  assert.throws(() => f.other.deleteChannel(f.channel.id), /fence/);
  assert.throws(() => f.other.updateTeammateDirectThreadWorkspace(f.thread.id, null, now), /fence/);
  assert.throws(() => f.other.hardDeleteAiTeammate(teammateId, {}, now), /fence/);
  assert.equal(f.other.getChannel(f.channel.id)?.name, "Engineering");
  assert.ok(f.other.getAiTeammate(teammateId));
  assert.equal(f.store.releaseWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, "cleanup", now, epoch), true);
});

for (const ownerKind of ["channel", "teammate"] as const) {
  test(`${ownerKind} lifecycle binding publication checks fence ownership and the current worktree identity`, async t => {
    const f = await fixture(t);
    const ownerId = ownerKind === "channel" ? f.channel.id : f.thread.id;
    const expectedEpoch = f.store.acquireWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, "cleanup", now);
    const input = { ownerKind, ownerId, binding: { ...f.binding, status: "not_created" as const },
      ownerRequestId: "cleanup", expectedEpoch, now };
    assert.throws(() => f.other.finalizeManagedWorktreeBindingWithinFence({ ...input, ownerRequestId: "other" }), /superseded/);
    assert.throws(() => f.other.finalizeManagedWorktreeBindingWithinFence({ ...input, expectedEpoch: expectedEpoch + 1 }), /superseded/);
    assert.equal(f.other.finalizeManagedWorktreeBindingWithinFence({ ...input, ownerId: "missing" }), false);
    assert.equal(f.other.finalizeManagedWorktreeBindingWithinFence({ ...input,
      binding: { ...input.binding, worktreePath: join(f.cwd, "other") } }), false);
    assert.equal(f.other.finalizeManagedWorktreeBindingWithinFence({ ...input,
      binding: { ...input.binding, branchName: "ling/other" } }), false);
    assert.equal(f.other.finalizeManagedWorktreeBindingWithinFence({ ...input,
      binding: { ...input.binding, mode: "external_path" } }), false);
    assert.equal(f.other.finalizeManagedWorktreeBindingWithinFence(input), true);
    const binding = ownerKind === "channel" ? f.store.getChannel(ownerId)?.workspaceBinding
      : f.store.getOrCreateTeammateDirectThread(teammateId, now).workspaceBinding;
    assert.equal(binding?.status, "not_created");
    assert.equal(f.store.getWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID).ownerRequestId, "cleanup");
    assert.ok(f.store.listChannelSessions(f.channel.id).defaultSession);
    assert.equal(f.store.releaseWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, "cleanup", now, expectedEpoch), true);
    assert.throws(() => f.other.finalizeManagedWorktreeBindingWithinFence(input), /superseded/);
    const local = { mode: "local", status: "ready", executionPath: f.cwd, updatedAt: now } as const;
    if (ownerKind === "channel") f.store.updateChannel(ownerId, { workspaceBinding: local }, now);
    else f.store.updateTeammateDirectThreadWorkspace(ownerId, local, now);
    const nextEpoch = f.store.acquireWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, "cleanup", now);
    assert.equal(f.other.finalizeManagedWorktreeBindingWithinFence({ ...input, expectedEpoch: nextEpoch }), false);
    assert.equal(f.store.releaseWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, "cleanup", now, nextEpoch), true);
  });
}

test("channel deletion preserves managed owners including bindings retained for recovery snapshots", async t => {
  const f = await fixture(t);
  for (const status of ["ready", "not_created", "missing", "blocked"] as const) {
    f.store.updateChannel(f.channel.id, { workspaceBinding: { ...f.binding, status } }, now);
    assert.throws(() => f.other.deleteChannel(f.channel.id), /managed worktree/);
    assert.ok(f.other.getChannel(f.channel.id));
  }
  f.store.updateChannel(f.channel.id, { workspaceBinding: null }, now);
  assert.equal(f.other.deleteChannel(f.channel.id), true);
  assert.equal(f.store.getChannel(f.channel.id), undefined);
});

test("hard delete preserves managed owners including bindings retained for recovery snapshots", async t => {
  const f = await fixture(t);
  for (const status of ["ready", "not_created", "missing", "blocked"] as const) {
    f.store.updateTeammateDirectThreadWorkspace(f.thread.id, { ...f.binding, status }, now);
    assert.throws(() => f.other.hardDeleteAiTeammate(teammateId, {}, now), /managed worktree/);
    assert.ok(f.other.getAiTeammate(teammateId));
    assert.equal(f.other.getOrCreateTeammateDirectThread(teammateId, now).id, f.thread.id);
  }
  f.store.updateTeammateDirectThreadWorkspace(f.thread.id, { mode: "local", status: "ready", executionPath: f.cwd, updatedAt: now }, now);
  assert.ok(f.other.hardDeleteAiTeammate(teammateId, {}, now));
  assert.equal(f.store.getAiTeammate(teammateId), undefined);
});

test("hard delete preserves a teammate with active runs and admits settled history", async t => {
  const f = await fixture(t);
  f.store.updateTeammateDirectThreadWorkspace(f.thread.id, null, now);
  const run = f.store.createRun({ id: "active-teammate-run", cwd: f.cwd, teammateId, taskId: "task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  assert.throws(() => f.other.hardDeleteAiTeammate(teammateId, {}, now), /active runs/);
  assert.equal(f.other.getRun(run.id)?.teammateId, teammateId);
  f.store.markRunCancelled(run.id, now);
  assert.ok(f.other.hardDeleteAiTeammate(teammateId, {}, now));
  assert.equal(f.store.getRun(run.id)?.teammateId, undefined);
});

test("hard delete preserves terminal-run ownership while its host command remains unsettled", async t => {
  const f = await fixture(t);
  f.store.updateTeammateDirectThreadWorkspace(f.thread.id, null, now);
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "host-run",
    idempotencyKey: "host-unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "runtime",
    runnerId: "pi", status: "started", now });
  const run = f.store.createRun({ id: "host-run", cwd: f.cwd, teammateId, workUnitId: unit.id, taskId: "task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  f.store.linkRunToWorkUnit(run.id, unit.id, now);
  f.store.markRunStarted(run.id, now);
  const ticket = f.store.prepareHostCommandExecution({ runId: run.id, sourceFence: toRuntimeAttemptFence(attempt),
    toolCallId: "command", cwd: f.cwd, command: { kind: "shell", command: "echo fixture", shell: "bash" } });
  f.store.markRunCancelled(run.id, now);
  assert.equal(f.other.listHostCommandWriteBlockers(f.cwd)[0]?.executionId, ticket.executionId);
  assert.throws(() => f.other.hardDeleteAiTeammate(teammateId, {}, now), /unsettled host commands/);
  assert.equal(f.other.getRun(run.id)?.teammateId, teammateId);
  assert.ok(f.other.getAiTeammate(teammateId));
});

test("hard delete admits settled yielded history", async t => {
  const f = await fixture(t);
  f.store.updateTeammateDirectThreadWorkspace(f.thread.id, null, now);
  const run = f.store.createRun({ id: "yielded-history", cwd: f.cwd, teammateId, taskId: "task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  f.store.markRunStarted(run.id, now);
  assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "runner_yielded", actor: "system", now }).ok, true);
  assert.deepEqual(f.store.listActiveRunScopes(), []);
  assert.ok(f.other.hardDeleteAiTeammate(teammateId, {}, now));
  assert.equal(f.store.getRun(run.id)?.teammateId, undefined);
});

test("hard delete preserves unfinished work after its Run yielded", async t => {
  const f = await fixture(t);
  f.store.updateTeammateDirectThreadWorkspace(f.thread.id, null, now);
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "waiting-run",
    teammateId, idempotencyKey: "waiting-unit", status: "waiting_for_input", createdByActor: "system", request: {}, now });
  const run = f.store.createRun({ id: "waiting-run", cwd: f.cwd, teammateId, workUnitId: unit.id, taskId: "task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  f.store.linkRunToWorkUnit(run.id, unit.id, now);
  f.store.markRunStarted(run.id, now);
  assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "runner_yielded", actor: "system", now }).ok, true);
  assert.throws(() => f.other.hardDeleteAiTeammate(teammateId, {}, now), /unfinished work/);
  assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: unit.id, expectedStatus: "waiting_for_input", event: "user_input_cancelled", actor: "system", now }).ok, true);
  assert.ok(f.other.hardDeleteAiTeammate(teammateId, {}, now));
});
