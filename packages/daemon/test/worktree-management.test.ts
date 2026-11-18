import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { LingDaemonClient } from "../../api-client/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { createManagedWorktreeBinding } from "../dist/features/channels/workspace.js";
import { ensureDirectWorkspaceReady } from "../dist/features/teammates/direct-workspace.js";
import { createManagedGitWorktree, removeManagedWorktreeIfClean } from "../dist/features/workspaces/managed-worktrees.js";
import { actOnManagedWorktree, completeManagedWorktreeInitialization, listManagedWorktrees, prepareManagedWorktreeInitialization } from "../dist/features/workspaces/worktree-management.js";
import { archiveWorktree, recoverWorktreeOperations, listWorktreeSnapshots, restoreWorktreeSnapshot } from "../dist/features/workspaces/worktree-recovery.js";
import { maintainManagedWorktrees, WorktreeMaintenanceRegistry } from "../dist/features/workspaces/worktree-retention.js";
import { parseWorkspaceSettingsUpdate } from "../dist/features/settings/effective-config.js";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";

const exec = promisify(execFile);
const now = "2026-11-17T00:00:00.000Z";
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

async function fixture(t: TestContext) {
  const cwd = await createSqliteWorkspaceFixture(join(tmpdir(), "ling-worktree-settings-"));
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Ling Test");
  await git(cwd, "config", "user.email", "test@ling.invalid");
  await writeFile(join(cwd, ".gitignore"), ".ling-stack/\ncustom/\nremote.git/\nupstream/\n");
  await writeFile(join(cwd, "README.md"), "initial\n");
  await git(cwd, "add", ".gitignore", "README.md");
  await git(cwd, "commit", "-m", "Initial");
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, store };
}

async function managedChannel(f: Awaited<ReturnType<typeof fixture>>, name = "Engineering") {
  const channel = f.store.createChannel({ name, boundPath: f.cwd }, now);
  const result = await createManagedWorktreeBinding(channel, f.cwd, f.store.paths, undefined, f.store.getWorkspaceSettings().worktreePolicy, f.store);
  assert.ok(result.ok, JSON.stringify(result));
  f.store.updateChannel(channel.id, { workspaceBinding: result.binding }, now);
  return { channelId: channel.id, binding: result.binding, path: result.binding.worktreePath! };
}

const channelOwner = (ownerId: string) => ({ ownerKind: "channel" as const, ownerId });

async function initializeChannel(store: ReturnType<typeof createSqliteRunStore>, cwd: string, ownerId: string) {
  const { challengeId } = await prepareManagedWorktreeInitialization(store, cwd, channelOwner(ownerId));
  await completeManagedWorktreeInitialization(store, cwd, challengeId, true);
}

test("cleanup redacts a Git move failure and preserves a locked worktree", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f);
  await git(f.cwd, "worktree", "lock", "--reason", "fixture-owned-lock", managed.path);
  await assert.rejects(actOnManagedWorktree(f.store, f.cwd, {
    ownerKind: "channel", ownerId: managed.channelId, action: "cleanup", confirmed: true,
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /locked/);
    assert.equal(error.message.includes(managed.path), false);
    assert.equal(error.message.includes(f.cwd), false);
    return true;
  });
  await access(managed.path);
  assert.equal(f.store.getChannel(managed.channelId)?.workspaceBinding?.status, "ready");
  assert.deepEqual(await listWorktreeSnapshots(f.store.paths), []);
});

test("cleanup snapshots preserve staged, unstaged, untracked, ignored files and symlinks across restart", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f);
  await writeFile(join(managed.path, ".gitignore"), ".ling-stack/\nignored/\n");
  await writeFile(join(managed.path, "README.md"), "staged\n");
  await git(managed.path, "add", "README.md");
  await writeFile(join(managed.path, "README.md"), "unstaged\n");
  await writeFile(join(managed.path, "untracked.txt"), "untracked\n");
  await mkdir(join(managed.path, "ignored"));
  await writeFile(join(managed.path, "ignored", ".env"), "LOCAL_TEST_TOKEN=fixture\n");
  await symlink("README.md", join(managed.path, "readme-link"));
  const status = await git(managed.path, "status", "--porcelain");
  const action = { ownerKind: "channel", ownerId: managed.channelId, action: "cleanup", confirmed: true } as const;
  await actOnManagedWorktree(f.store, f.cwd, action);
  await assert.rejects(access(managed.path));
  const [snapshot] = await listWorktreeSnapshots(f.store.paths);
  assert.ok(snapshot);
  assert.equal(await readFile(join(snapshot.snapshotPath, "ignored", ".env"), "utf8"), "LOCAL_TEST_TOKEN=fixture\n");
  const reopened = createSqliteRunStore(f.cwd);
  try {
    await recoverWorktreeOperations(reopened);
    assert.equal((await listWorktreeSnapshots(reopened.paths))[0]?.id, snapshot.id);
    await mkdir(managed.path);
    await writeFile(join(managed.path, "keep.txt"), "existing user directory");
    await assert.rejects(actOnManagedWorktree(reopened, f.cwd, { ...action, action: "restore", snapshotId: snapshot.id }), /目标已存在/);
    assert.equal(await readFile(join(managed.path, "keep.txt"), "utf8"), "existing user directory");
    await rm(managed.path, { recursive: true });
    await actOnManagedWorktree(reopened, f.cwd, { ...action, action: "restore", snapshotId: snapshot.id });
    assert.equal(await git(managed.path, "status", "--porcelain"), status);
    assert.equal(await git(managed.path, "show", ":README.md"), "staged");
    assert.equal(await readFile(join(managed.path, "README.md"), "utf8"), "unstaged\n");
    assert.equal(await readlink(join(managed.path, "readme-link")), "README.md");
    assert.equal(await readFile(join(managed.path, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(await readFile(join(managed.path, "ignored", ".env"), "utf8"), "LOCAL_TEST_TOKEN=fixture\n");
    assert.deepEqual(await listWorktreeSnapshots(reopened.paths), []);
  } finally { reopened.close(); }
});

test("durable cleanup fence excludes another SQLite connection's Run and binding admission", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f);
  const observer = createSqliteRunStore(f.cwd);
  const task = f.store.createTask({ channelId: managed.channelId, title: "Race", prompt: "Race" }, now);
  let checked = false;
  try {
    await archiveWorktree(f.store, { repoRoot: f.cwd, path: managed.path, branchName: managed.binding.branchName!,
      ownerKind: "channel", ownerId: managed.channelId, ownerName: "Race", assertIdle: () => {
        checked = true;
        assert.throws(() => observer.createRun({ id: "run_fenced_worktree", cwd: managed.path, taskId: task.id,
          providerName: "test", providerModel: "test", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now }), /fence/);
        assert.throws(() => observer.updateChannel(managed.channelId, { workspaceBinding: null }, now), /fence/);
        assert.throws(() => observer.createChannel({ name: "Late reference", boundPath: managed.path }, now), /fence/);
      } });
    assert.ok(checked);
    assert.equal(observer.getRun("run_fenced_worktree"), undefined);
    assert.equal(observer.getWorkspaceSnapshotFence("workspace_default").ownerRequestId, undefined);
    const [snapshot] = await listWorktreeSnapshots(f.store.paths);
    assert.ok(snapshot);
    const journal = join(f.store.paths.rootDir, "worktree-recovery", `${snapshot.id}.json`);
    const raw = JSON.parse(await readFile(journal, "utf8")) as Record<string, unknown>;
    await git(f.cwd, "worktree", "unlock", snapshot.snapshotPath);
    await writeFile(journal, JSON.stringify({ ...raw, state: "prepared" }));
    f.store.acquireWorkspaceSnapshotFence("workspace_default", snapshot.id, now);
    await recoverWorktreeOperations(observer);
    assert.equal(observer.getWorkspaceSnapshotFence("workspace_default").ownerRequestId, undefined);
    assert.equal((await listWorktreeSnapshots(observer.paths))[0]?.state, "archived");
    assert.equal((await readFile(join(String(raw.gitDir), "locked"), "utf8")).trim(), snapshot.id);
    await access(snapshot.snapshotPath);
  } finally { observer.close(); }
});

test("cleanup and restore retain their fence through failed binding finalization and restart", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f);
  const observer = createSqliteRunStore(f.cwd);
  try {
    await assert.rejects(archiveWorktree(f.store, { repoRoot: f.cwd, path: managed.path, branchName: managed.binding.branchName!,
      ownerKind: "channel", ownerId: managed.channelId, ownerName: "Finalization", assertIdle: () => {}, finalize: () => {
        assert.throws(() => observer.updateChannel(managed.channelId, { name: "Late rename" }, now), /fence/);
        throw new Error("injected finalization failure");
      } }), /injected finalization failure/);
    const [snapshot] = await listWorktreeSnapshots(f.store.paths);
    assert.ok(snapshot);
    assert.equal(snapshot.state, "blocked");
    assert.equal(observer.getWorkspaceSnapshotFence("workspace_default").ownerRequestId, snapshot.id);
    await access(snapshot.snapshotPath);
    await assert.rejects(access(managed.path));
    await recoverWorktreeOperations(observer);
    assert.equal(observer.getChannel(managed.channelId)?.workspaceBinding?.status, "not_created");
    assert.equal(observer.getWorkspaceSnapshotFence("workspace_default").ownerRequestId, undefined);

    await assert.rejects(restoreWorktreeSnapshot(f.store, snapshot.id, () => {}, () => {
      assert.throws(() => observer.deleteChannel(managed.channelId), /fence/);
      throw new Error("injected restore finalization failure");
    }), /injected restore finalization failure/);
    assert.equal(observer.getWorkspaceSnapshotFence("workspace_default").ownerRequestId, snapshot.id);
    await access(managed.path);
    await recoverWorktreeOperations(observer);
    assert.equal(observer.getChannel(managed.channelId)?.workspaceBinding?.status, "ready");
    assert.equal(observer.getWorkspaceSnapshotFence("workspace_default").ownerRequestId, undefined);
    assert.deepEqual(await listWorktreeSnapshots(observer.paths), []);
  } finally { observer.close(); }
});

test("retention cleans oldest eligible worktrees while preserving pinned, active, dirty and shared owners", async t => {
  const f = await fixture(t);
  const old = await managedChannel(f, "Old");
  const pinned = await managedChannel(f, "Pinned");
  const dirty = await managedChannel(f, "Dirty");
  const shared = await managedChannel(f, "Shared");
  const busy = await managedChannel(f, "Busy");
  const recent = await managedChannel(f, "Recent");
  for (const [i, managed] of [old, pinned, dirty, shared, busy, recent].entries()) {
    const activity = `2026-11-1${i}T00:00:00.000Z`;
    f.store.updateChannel(managed.channelId, { name: `Owner ${i}` }, activity);
    for (const chat of f.store.listLingThreads({ channelId: managed.channelId, includeArchived: true, limit: 500 })) f.store.updateLingThread(chat.id, { title: chat.title }, activity);
  }
  f.store.createLingThread({ kind: "channel_discussion", channelId: pinned.channelId, title: "Pinned conversation", objective: "Keep", pinnedAt: now }, now);
  await writeFile(join(dirty.path, "draft.txt"), "keep");
  f.store.createChannel({ name: "External reference", boundPath: shared.path }, now);
  const task = f.store.createTask({ channelId: busy.channelId, title: "Busy", prompt: "Busy" }, now);
  f.store.createRun({ id: "retention_busy", cwd: busy.path, taskId: task.id, providerName: "test", providerModel: "test", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  f.store.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false, autoCleanup: true, retainCount: 5 } }, now);
  const first = await maintainManagedWorktrees(f.store, f.cwd);
  assert.equal(first.errorMessage, undefined);
  assert.equal(first.removed, 1);
  await assert.rejects(access(old.path));
  for (const managed of [pinned, dirty, shared, busy, recent]) await access(managed.path);
  assert.equal((await maintainManagedWorktrees(f.store, f.cwd)).removed, 0);
  const registry = new WorktreeMaintenanceRegistry(10);
  registry.registerStore(f.cwd, f.store);
  registry.stopAll();
  await registry.waitForIdle();
  f.store.markRunCancelled("retention_busy", now);
});

test("environment initialization is explicit, bounded, persisted and retryable without discarding work", async t => {
  const f = await fixture(t);
  const environment = { enabled: true, setupScript: "printf '%s' \"$LING_TEST_VALUE\" > initialized.txt; printf '%s' \"$LING_TEST_VALUE\"; exit 7", variables: { LING_TEST_VALUE: "fixture-secret" }, timeoutSeconds: 2 };
  f.store.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false, environment } }, now);
  const managed = await managedChannel(f, "Setup");
  let entry = (await listManagedWorktrees(f.store, f.cwd)).entries[0]!;
  assert.equal(managed.binding.status, "blocked");
  assert.equal(entry.initialization?.status, "pending");
  assert.match(entry.initialization?.errorMessage ?? "", /等待本地确认/);
  await assert.rejects(access(join(managed.path, "initialized.txt")));
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal((await listManagedWorktrees(reopened, f.cwd)).entries[0]?.initialization?.status, "pending");
    await assert.rejects(actOnManagedWorktree(reopened, f.cwd, { ...channelOwner(managed.channelId), action: "initialize", confirmed: true }), { code: "worktree_desktop_confirmation_required" });
    await initializeChannel(reopened, f.cwd, managed.channelId);
    entry = (await listManagedWorktrees(reopened, f.cwd)).entries[0]!;
    assert.equal(entry.initialization?.status, "failed");
    assert.equal(entry.initialization?.output, "[redacted]");
    assert.equal(await readFile(join(managed.path, "initialized.txt"), "utf8"), "fixture-secret");
    reopened.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false, environment: { ...environment, setupScript: "printf done > retry.txt" } } }, now);
    await initializeChannel(reopened, f.cwd, managed.channelId);
    entry = (await listManagedWorktrees(reopened, f.cwd)).entries[0]!;
    assert.equal(entry.status, "ready");
    assert.equal(entry.initialization?.status, "succeeded");
    assert.equal(await readFile(join(managed.path, "retry.txt"), "utf8"), "done");
    assert.equal(await readFile(join(managed.path, "initialized.txt"), "utf8"), "fixture-secret");
    await assert.rejects(prepareManagedWorktreeInitialization(reopened, f.cwd, channelOwner(managed.channelId)), { code: "worktree_already_initialized" });
  } finally { reopened.close(); }
});

test("expired or stale setup confirmations cannot start a script", async t => {
  const f = await fixture(t);
  const setupFile = "approved-setup.txt";
  const environment = { enabled: true, setupScript: "printf old > approved-setup.txt", variables: {}, timeoutSeconds: 2 };
  f.store.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false, environment } }, now);
  const managed = await managedChannel(f);
  const prepare = () => prepareManagedWorktreeInitialization(f.store, f.cwd, channelOwner(managed.channelId));
  const complete = (id: string) => completeManagedWorktreeInitialization(f.store, f.cwd, id, true);

  const expiring = await prepare();
  const clock = t.mock.method(Date, "now", () => Date.parse(expiring.expiresAt));
  try {
    await assert.rejects(complete(expiring.challengeId), { code: "worktree_confirmation_expired" });
  } finally { clock.mock.restore(); }

  const stale = await prepare();
  f.store.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false, environment: {
    ...environment, setupScript: "printf current > approved-setup.txt",
  } } }, now);
  await assert.rejects(complete(stale.challengeId), { code: "worktree_initialization_changed" });
  await assert.rejects(complete(stale.challengeId), { code: "worktree_confirmation_expired" });

  const changedCheckout = await prepare();
  await git(managed.path, "switch", "-c", "user/different");
  await assert.rejects(complete(changedCheckout.challengeId), { code: "worktree_owner_mismatch" });
  await assert.rejects(access(join(managed.path, setupFile)));

  await git(managed.path, "switch", managed.binding.branchName!);
  await initializeChannel(f.store, f.cwd, managed.channelId);
  assert.equal(await readFile(join(managed.path, setupFile), "utf8"), "current");
});

test("enabling setup scripts does not add initialization work to existing worktrees", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f, "Existing");
  assert.equal((await listManagedWorktrees(f.store, f.cwd)).entries[0]?.initialization, undefined);
  f.store.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false,
    environment: { enabled: true, setupScript: "printf should-not-run > existing-setup.txt", variables: {}, timeoutSeconds: 2 } } }, now);
  const entry = (await listManagedWorktrees(f.store, f.cwd)).entries[0]!;
  assert.equal(entry.status, "ready");
  assert.equal(entry.initialization, undefined);
  await assert.rejects(access(join(managed.path, "existing-setup.txt")));
});

test("initialization timeout terminates its process group and preserves a failed worktree", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.store.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false,
    environment: { enabled: true, setupScript: "trap '' TERM; sleep 20", variables: {}, timeoutSeconds: 1 } } }, now);
  const managed = await managedChannel(f, "Timeout");
  await initializeChannel(f.store, f.cwd, managed.channelId);
  const entry = (await listManagedWorktrees(f.store, f.cwd)).entries[0]!;
  assert.equal(entry.initialization?.status, "failed");
  assert.match(entry.initialization?.errorMessage ?? "", /超时/);
  await access(managed.path);
});

test("worktree policy validates shape and persists across store reopen", async t => {
  const f = await fixture(t);
  for (const policy of [false, [], { fetchBeforeCreate: "yes" }, { rootDir: "relative", fetchBeforeCreate: false }, { rootDir: "/tmp/a\0b", fetchBeforeCreate: false }]) {
    assert.throws(() => parseWorkspaceSettingsUpdate({ worktreePolicy: policy }));
  }
  const policy = { rootDir: join(f.cwd, "custom"), fetchBeforeCreate: true };
  f.store.updateWorkspaceSettings(parseWorkspaceSettingsUpdate({ worktreePolicy: policy }), now);
  const reopened = createSqliteRunStore(f.cwd);
  try { assert.deepEqual(reopened.getWorkspaceSettings().worktreePolicy, policy); } finally { reopened.close(); }
  f.store.updateWorkspaceSettings({ locale: "zh-CN" }, now);
  assert.deepEqual(f.store.getWorkspaceSettings().worktreePolicy, policy);
  f.store.updateWorkspaceSettings({ worktreePolicy: null }, now);
  assert.equal(f.store.getWorkspaceSettings().worktreePolicy, undefined);
  const complete = { ...policy, autoCleanup: true, retainCount: 3, confirmBeforeDelete: false,
    protectedOwners: [{ ownerKind: "channel" as const, ownerId: "keep" }],
    environment: { enabled: true, setupScript: "printf ready", variables: { TEST_MODE: "local" }, timeoutSeconds: 5 } };
  f.store.updateWorkspaceSettings(parseWorkspaceSettingsUpdate({ worktreePolicy: complete }), now);
  const again = createSqliteRunStore(f.cwd);
  try { assert.deepEqual(again.getWorkspaceSettings().worktreePolicy, complete); } finally { again.close(); }
  for (const patch of [{ retainCount: 0 }, { retainCount: 1.2 }, { retainCount: 101 }, { autoCleanup: "yes" }, { confirmBeforeDelete: 1 },
    { environment: { ...complete.environment, timeoutSeconds: 0 } }, { environment: { ...complete.environment, setupScript: "" } },
    { environment: { ...complete.environment, variables: { "not a key": "x" } } }]) {
    assert.throws(() => parseWorkspaceSettingsUpdate({ worktreePolicy: { ...complete, ...patch } }));
  }
});

test("custom roots are consumed by channel creation and first-use private chats", async t => {
  const f = await fixture(t);
  const rootDir = join(f.cwd, "custom");
  f.store.updateWorkspaceSettings({ worktreePolicy: { rootDir, fetchBeforeCreate: true } }, now);
  const channel = await managedChannel(f);
  assert.equal(channel.path, join(rootDir, f.store.paths.identity.workspaceId, "channels", channel.channelId));
  const thread = f.store.getOrCreateTeammateDirectThread("teammate_builtin_engineer", now);
  const direct = await ensureDirectWorkspaceReady({ store: f.store, thread, workspaceCwd: f.cwd });
  assert.ok(direct.ok, JSON.stringify(direct));
  assert.equal(direct.workspace.executionCwd, join(rootDir, f.store.paths.identity.workspaceId, "teammates", thread.teammateId, thread.id));
  assert.equal((await listManagedWorktrees(f.store, f.cwd)).entries.length, 2);
  await actOnManagedWorktree(f.store, f.cwd, { ownerKind: "teammate", ownerId: thread.id, action: "cleanup", confirmed: true });
  f.store.updateWorkspaceSettings({ worktreePolicy: null }, now);
  const restored = await ensureDirectWorkspaceReady({ store: f.store, thread, workspaceCwd: f.cwd });
  assert.ok(restored.ok);
  assert.equal(restored.workspace.executionCwd, direct.workspace.executionCwd);
});

test("managed list excludes external checkouts and cleanup refuses dirty, busy and shared paths", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f);
  const externalPath = join(f.cwd, "external-checkout");
  await git(f.cwd, "worktree", "add", "-b", "user/external", externalPath);
  assert.equal((await listManagedWorktrees(f.store, f.cwd)).entries.length, 1);
  await writeFile(join(managed.path, "unsaved.txt"), "keep me\n");
  assert.equal((await listManagedWorktrees(f.store, f.cwd)).entries[0]?.isDirty, true);
  const action = { ownerKind: "channel", ownerId: managed.channelId, action: "cleanup", confirmed: true } as const;
  await assert.rejects(actOnManagedWorktree(f.store, f.cwd, { ...action, confirmed: false }), { code: "worktree_confirmation_required" });
  assert.equal(await readFile(join(managed.path, "unsaved.txt"), "utf8"), "keep me\n");
  await rm(join(managed.path, "unsaved.txt"));
  const task = f.store.createTask({ channelId: managed.channelId, title: "Hold workspace", prompt: "Hold workspace" }, now);
  const run = f.store.createRun({ id: "run_worktree_busy", cwd: managed.path, taskId: task.id, providerName: "test", providerModel: "test",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  assert.equal((await listManagedWorktrees(f.store, f.cwd)).entries[0]?.inUse, true);
  await assert.rejects(actOnManagedWorktree(f.store, f.cwd, action), { code: "worktree_in_use" });
  f.store.markRunCancelled(run.id, now);
  const second = f.store.createChannel({ name: "Other owner", workspaceBinding: managed.binding }, now);
  await assert.rejects(actOnManagedWorktree(f.store, f.cwd, action), { code: "worktree_shared" });
  f.store.updateChannel(second.id, { workspaceBinding: null }, now);
  const subdirectory = join(managed.path, "subdirectory");
  await mkdir(subdirectory);
  f.store.updateChannel(second.id, { boundPath: subdirectory }, now);
  await assert.rejects(actOnManagedWorktree(f.store, f.cwd, action), { code: "worktree_shared" });
  f.store.updateChannel(second.id, { boundPath: null }, now);
  await actOnManagedWorktree(f.store, f.cwd, action);
  await access(externalPath);
  assert.equal(f.store.getChannel(managed.channelId)?.workspaceBinding?.status, "not_created");
});

test("managed lifecycle retains the original repository when a channel bound path changes", async t => {
  const f = await fixture(t);
  const environment = { enabled: true, setupScript: "printf initialized > lifecycle.txt", variables: {}, timeoutSeconds: 2 };
  f.store.updateWorkspaceSettings({ worktreePolicy: { fetchBeforeCreate: false, environment } }, now);
  const managed = await managedChannel(f, "Rebound");
  const other = await fixture(t);
  f.store.updateChannel(managed.channelId, { boundPath: other.cwd }, now);

  assert.equal((await listManagedWorktrees(f.store, f.cwd)).entries[0]?.initialization?.status, "pending");
  assert.equal(await actOnManagedWorktree(f.store, f.cwd, { ...channelOwner(managed.channelId), action: "open" }), managed.path);
  await initializeChannel(f.store, f.cwd, managed.channelId);
  assert.equal(await readFile(join(managed.path, "lifecycle.txt"), "utf8"), "initialized");
  await actOnManagedWorktree(f.store, f.cwd, { ownerKind: "channel", ownerId: managed.channelId, action: "cleanup", confirmed: true });
  const [snapshot] = await listWorktreeSnapshots(f.store.paths);
  assert.ok(snapshot);
  await actOnManagedWorktree(f.store, f.cwd, { ...channelOwner(managed.channelId), action: "restore", snapshotId: snapshot.id });
  assert.equal(await readFile(join(managed.path, "lifecycle.txt"), "utf8"), "initialized");
});

test("ownership pagination checks references beyond the first 500 channels", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f);
  for (let i = 0; i < 501; i++) f.store.createChannel({ name: `Channel ${i}` }, now);
  f.store.createChannel({ name: "Last reference", boundPath: managed.path }, "2020-01-01T00:00:00Z");
  assert.equal((await listManagedWorktrees(f.store, f.cwd)).limitReached, false);
  await assert.rejects(actOnManagedWorktree(f.store, f.cwd, { ownerKind: "channel", ownerId: managed.channelId, action: "cleanup", confirmed: true }), { code: "worktree_shared" });
  await access(managed.path);
});

test("cleanup preserves committed work and recreation reuses the recorded branch and path", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f);
  await writeFile(join(managed.path, "result.txt"), "committed result\n");
  await git(managed.path, "add", "result.txt");
  await git(managed.path, "commit", "-m", "Worktree result");
  const commit = await git(managed.path, "rev-parse", "HEAD");
  await actOnManagedWorktree(f.store, f.cwd, { ownerKind: "channel", ownerId: managed.channelId, action: "cleanup", confirmed: true });
  await assert.rejects(access(managed.path));
  f.store.updateWorkspaceSettings({ worktreePolicy: { rootDir: join(f.cwd, "custom"), fetchBeforeCreate: false } }, now);
  const channel = f.store.getChannel(managed.channelId)!;
  const recreated = await createManagedWorktreeBinding(channel, f.cwd, f.store.paths, undefined, f.store.getWorkspaceSettings().worktreePolicy, f.store);
  assert.ok(recreated.ok);
  assert.equal(recreated.binding.worktreePath, managed.path);
  assert.equal(await git(managed.path, "rev-parse", "HEAD"), commit);
  assert.equal(await readFile(join(managed.path, "result.txt"), "utf8"), "committed result\n");
});

test("cleanup refuses canonical and foreign repositories and unexpected branches", async t => {
  const f = await fixture(t);
  const canonical = await removeManagedWorktreeIfClean({ repoRoot: f.cwd, worktreePath: f.cwd });
  assert.equal(canonical.ok, false);
  const other = await fixture(t);
  const foreign = await managedChannel(other);
  assert.equal((await removeManagedWorktreeIfClean({ repoRoot: f.cwd, worktreePath: foreign.path })).ok, false);
  const managed = await managedChannel(f);
  await git(managed.path, "switch", "-c", "user/different");
  await assert.rejects(actOnManagedWorktree(f.store, f.cwd, { ownerKind: "channel", ownerId: managed.channelId, action: "cleanup", confirmed: true }), { code: "worktree_owner_mismatch" });
  await access(managed.path);
});

test("settings cannot open or archive a foreign checkout occupying an owned path", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f);
  const relocated = join(f.cwd, "relocated-original");
  await git(f.cwd, "worktree", "move", managed.path, relocated);

  const other = await fixture(t);
  await git(other.cwd, "worktree", "add", "-b", managed.binding.branchName!, managed.path);
  const [entry] = (await listManagedWorktrees(f.store, f.cwd)).entries;
  assert.equal(entry?.status, "blocked");
  assert.equal(entry?.initialization, undefined);
  for (const action of ["open", "cleanup"] as const) {
    await assert.rejects(actOnManagedWorktree(f.store, f.cwd, { ...channelOwner(managed.channelId), action, confirmed: true }), { code: "worktree_owner_mismatch" });
  }
  await access(managed.path);
  await access(relocated);
  assert.deepEqual(await listWorktreeSnapshots(f.store.paths), []);
});

test("fetch updates remote refs without merging and a fetch error prevents creation", async t => {
  const f = await fixture(t);
  const remote = join(f.cwd, "remote.git");
  await git(f.cwd, "init", "--bare", remote);
  await git(f.cwd, "remote", "add", "origin", remote);
  await git(f.cwd, "push", "-u", "origin", "main");
  const localCommit = await git(f.cwd, "rev-parse", "HEAD");
  const upstream = join(f.cwd, "upstream");
  await git(f.cwd, "clone", "-b", "main", remote, upstream);
  await git(upstream, "config", "user.name", "Ling Test");
  await git(upstream, "config", "user.email", "test@ling.invalid");
  await writeFile(join(upstream, "upstream.txt"), "remote update\n");
  await git(upstream, "add", "upstream.txt");
  await git(upstream, "commit", "-m", "Remote update");
  await git(upstream, "push");
  const upstreamCommit = await git(upstream, "rev-parse", "HEAD");
  const first = await createManagedGitWorktree({ repoRoot: f.cwd, worktreePath: join(f.store.paths.worktreesDir, "fetch"), branchName: "ling/fetch", fetchBeforeCreate: true });
  assert.ok(first.ok);
  assert.equal(await git(f.cwd, "rev-parse", "origin/main"), upstreamCommit);
  assert.equal(await git(f.cwd, "rev-parse", "HEAD"), localCommit);
  await git(f.cwd, "remote", "set-url", "origin", join(f.cwd, "missing.git"));
  const unavailable = join(f.store.paths.worktreesDir, "unavailable");
  const failure = await createManagedGitWorktree({ repoRoot: f.cwd, worktreePath: unavailable, branchName: "ling/unavailable", fetchBeforeCreate: true });
  assert.ok(!failure.ok);
  assert.equal(failure.code, "worktree_fetch_failed");
  await assert.rejects(access(unavailable));
});

test("daemon and API client persist policy, list owned worktrees and validate actions", async t => {
  const f = await fixture(t);
  const managed = await managedChannel(f);
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(f.cwd, ".ling-stack", "test-home");
  t.after(() => {
    if (previousHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = previousHome;
  });
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd }, { storeFactory: () => f.store });
  try {
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new LingDaemonClient({ baseUrl });
    const policy = { rootDir: join(f.cwd, "custom"), fetchBeforeCreate: true };
    assert.deepEqual((await client.updateWorkspaceSettings(f.cwd, { worktreePolicy: policy })).settings.worktreePolicy, policy);
    assert.equal((await client.listManagedWorktrees(f.cwd)).entries[0]?.ownerId, managed.channelId);
    await client.updateChannel(f.cwd, managed.channelId, { name: "Renamed", workspaceBinding: managed.binding });
    assert.deepEqual(f.store.getChannel(managed.channelId)?.workspaceBinding?.worktreeIdentity, managed.binding.worktreeIdentity);
    const anotherPath = join(f.cwd, "another-checkout");
    const reassignment = await fetch(new URL(`/channels/${managed.channelId}?cwd=${encodeURIComponent(f.cwd)}`, baseUrl), {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceBinding: { ...managed.binding, worktreePath: anotherPath, executionPath: anotherPath } }),
    });
    assert.equal(reassignment.status, 409);
    assert.equal((await client.listManagedWorktrees(f.cwd)).entries[0]?.path, managed.path);
    for (const body of [{ ownerKind: "channel", ownerId: "missing", action: "cleanup", confirmed: true }, { ownerKind: "channel", ownerId: managed.channelId, action: "delete" }]) {
      const response = await fetch(`${baseUrl}/worktrees/actions?cwd=${encodeURIComponent(f.cwd)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.ok(response.status >= 400);
    }
    const invalid = await fetch(`${baseUrl}/workspace-settings?cwd=${encodeURIComponent(f.cwd)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ worktreePolicy: { rootDir: "relative", fetchBeforeCreate: true } }) });
    assert.equal(invalid.status, 400);
    for (const [path, options] of [
      [`/worktrees?cwd=${encodeURIComponent(f.cwd)}`, { headers: { Origin: "https://foreign.invalid" } }],
      [`/worktrees/actions?cwd=${encodeURIComponent(f.cwd)}`, { method: "POST", headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ ownerKind: "channel", ownerId: managed.channelId, action: "cleanup", confirmed: true }) }],
      [`/workspace-settings?cwd=${encodeURIComponent(f.cwd)}`, { method: "PATCH", headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ worktreePolicy: null }) }],
      [`/worktrees?cwd=${encodeURIComponent(join(f.cwd, "unknown"))}`, {}],
      [`/workspace-settings?cwd=${encodeURIComponent(join(f.cwd, "unknown"))}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ worktreePolicy: null }) }],
    ] as const) {
      assert.equal((await fetch(`${baseUrl}${path}`, options)).status, 403);
    }
    await access(managed.path);
    assert.deepEqual(f.store.getWorkspaceSettings().worktreePolicy, policy);
    const cleaned = await client.actOnManagedWorktree(f.cwd, { ownerKind: "channel", ownerId: managed.channelId, action: "cleanup", confirmed: true });
    assert.equal(cleaned.entries[0]?.status, "not_created");
  } finally { await daemon.stop(); }
});
