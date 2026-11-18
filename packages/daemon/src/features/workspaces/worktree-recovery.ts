import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ChannelWorkspaceBinding, LingStackRuntimePaths } from "@ling-stack/core";
import type { WorktreeRecoverySnapshot } from "@ling-stack/contracts";
import { isolatedGit as runGit, inspectManagedWorktree, redactGitError } from "./managed-worktrees.js";
import { assertWorktreeIdle, type WorktreeLifecycleStore } from "./worktree-mutation.js";

export const WORKTREE_FENCE_PREFIX = "worktree_lifecycle_";
const workspaceId = "workspace_default";
interface RecoveryRecord extends WorktreeRecoverySnapshot { readonly repoRoot: string; readonly gitDir: string }

async function git(cwd: string, args: readonly string[]) {
  try { return await runGit(cwd, args); }
  catch (error) { throw new Error(redactGitError(error)); }
}

/** Publish a complete journal record before any worktree location changes. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = openSync(temporary, "wx", 0o600);
  try { writeFileSync(file, JSON.stringify(value)); fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
  // Windows does not support opening directories as file descriptors for fsync.
  if (process.platform === "win32") return;
  const directory = openSync(path, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function journalRoot(paths: LingStackRuntimePaths): string { return join(paths.rootDir, "worktree-recovery"); }
function journalPath(paths: LingStackRuntimePaths, id: string): string {
  if (!/^worktree_lifecycle_[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid worktree snapshot identity");
  return join(journalRoot(paths), `${id}.json`);
}
function persist(paths: LingStackRuntimePaths, record: RecoveryRecord): void { writePrivateJson(journalPath(paths, record.id), record); }

async function records(paths: LingStackRuntimePaths): Promise<RecoveryRecord[]> {
  let names: string[];
  try { names = await readdir(journalRoot(paths)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return await Promise.all(names.filter((name) => /^worktree_lifecycle_[a-f0-9-]{36}\.json$/.test(name)).map(async (name) => {
    const raw = await readFile(join(journalRoot(paths), name), "utf8");
    if (raw.length > 64000) throw new Error("Worktree snapshot record is too large");
    const record = JSON.parse(raw) as RecoveryRecord;
    if (journalPath(paths, record.id) !== join(journalRoot(paths), name)
      || !["channel", "teammate"].includes(record.ownerKind) || typeof record.ownerId !== "string"
      || typeof record.originalPath !== "string" || resolve(record.originalPath) !== record.originalPath
      || record.snapshotPath !== join(dirname(record.originalPath), ".ling-recovery", record.id)
      || !["prepared", "archived", "restoring", "restored", "blocked"].includes(record.state)) throw new Error("Invalid worktree snapshot record");
    return record;
  }));
}

export async function listWorktreeSnapshots(paths: LingStackRuntimePaths): Promise<WorktreeRecoverySnapshot[]> {
  const existing = await records(paths);
  const visible = await Promise.all(existing.map(async (record) => record.state === "prepared" && !await pathExists(record.snapshotPath) ? undefined : record));
  return visible.filter((record): record is RecoveryRecord => Boolean(record && record.state !== "restored")).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ repoRoot: _repoRoot, gitDir: _gitDir, ...record }) => record);
}

export async function assertOwnedLinkedWorktree(repoRoot: string, path: string, branchName: string, expectedGitDir?: string): Promise<string> {
  if ((await lstat(path)).isSymbolicLink()) throw new Error("Worktree root cannot be a symbolic link");
  const common = await realpath(resolve(path, (await git(path, ["rev-parse", "--git-common-dir"])).stdout.trim()));
  const sourceCommon = await realpath(resolve(repoRoot, (await git(repoRoot, ["rev-parse", "--git-common-dir"])).stdout.trim()));
  const gitDir = await realpath((await git(path, ["rev-parse", "--absolute-git-dir"])).stdout.trim());
  const top = await realpath((await git(path, ["rev-parse", "--show-toplevel"])).stdout.trim());
  if (common !== sourceCommon || gitDir === common || top !== await realpath(path) || (expectedGitDir && gitDir !== expectedGitDir)
    || (await git(path, ["branch", "--show-current"])).stdout.trim() !== branchName) throw new Error("Worktree repository, branch or identity does not match its owner");
  return gitDir;
}

export async function archiveWorktree(store: WorktreeLifecycleStore, input: {
  readonly repoRoot: string; readonly path: string; readonly branchName: string;
  readonly ownerKind: "channel" | "teammate"; readonly ownerId: string; readonly ownerName: string;
  readonly assertIdle: () => void;
  readonly finalize?: (record: WorktreeRecoverySnapshot, fence: { readonly ownerRequestId: string; readonly epoch: number }) => void | Promise<void>;
}): Promise<WorktreeRecoverySnapshot> {
  const gitDir = await assertOwnedLinkedWorktree(input.repoRoot, input.path, input.branchName);
  const id = `${WORKTREE_FENCE_PREFIX}${randomUUID()}`;
  let record: RecoveryRecord = { id, ownerKind: input.ownerKind, ownerId: input.ownerId, ownerName: input.ownerName,
    originalPath: resolve(input.path), snapshotPath: join(dirname(resolve(input.path)), ".ling-recovery", id), branchName: input.branchName,
    repoRoot: input.repoRoot, gitDir, createdAt: new Date().toISOString(), state: "prepared" };
  persist(store.paths, record);
  let epoch: number;
  try { epoch = store.acquireWorkspaceSnapshotFence(workspaceId, id, new Date().toISOString()); }
  catch (error) { persist(store.paths, { ...record, state: "restored" }); throw error; }
  let verified = false;
  let finalizationFailed = false;
  try {
    input.assertIdle();
    mkdirSync(dirname(record.snapshotPath), { recursive: true, mode: 0o700 });
    if ((await lstat(dirname(record.snapshotPath))).isSymbolicLink()) throw new Error("Recovery directory cannot be a symbolic link");
    await git(input.repoRoot, ["worktree", "move", input.path, record.snapshotPath]);
    syncDirectory(dirname(input.path));
    syncDirectory(dirname(record.snapshotPath));
    await assertOwnedLinkedWorktree(input.repoRoot, record.snapshotPath, input.branchName, gitDir);
    await git(input.repoRoot, ["worktree", "lock", "--reason", id, record.snapshotPath]);
    record = { ...record, state: "archived" };
    persist(store.paths, record);
    if (input.finalize) {
      try { await input.finalize(record, { ownerRequestId: id, epoch }); }
      catch (error) { finalizationFailed = true; throw error; }
    }
    try { await finalizeRecordBinding(store, record, epoch); }
    catch (error) { finalizationFailed = true; throw error; }
    verified = true;
    return record;
  } catch (error) {
    const observed = await reconcileRecord(store, record).catch(() => undefined);
    if (observed && !finalizationFailed) {
      try { await finalizeRecordBinding(store, observed, epoch); verified = true; }
      catch { finalizationFailed = true; }
    }
    if (finalizationFailed) persist(store.paths, { ...record, state: "blocked", errorMessage: "工作树目录已保留，归属更新未完成。" });
    throw error;
  } finally {
    if (verified) store.releaseWorkspaceSnapshotFence(workspaceId, id, new Date().toISOString(), epoch);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function reconcileRecord(store: WorktreeLifecycleStore, record: RecoveryRecord): Promise<RecoveryRecord> {
  const originalExists = await pathExists(record.originalPath);
  const snapshotExists = await pathExists(record.snapshotPath);
  if (originalExists === snapshotExists) throw new Error("Worktree recovery locations are ambiguous; both directories are preserved");
  const location = snapshotExists ? record.snapshotPath : record.originalPath;
  await assertOwnedLinkedWorktree(record.repoRoot, location, record.branchName, record.gitDir);
  if (snapshotExists) {
    let lock: string | undefined;
    try { lock = (await readFile(join(record.gitDir, "locked"), "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (lock && lock !== record.id) throw new Error("Worktree has a foreign Git lock; workspace remains fenced");
    if (!lock) await git(record.repoRoot, ["worktree", "lock", "--reason", record.id, record.snapshotPath]);
  }
  const next: RecoveryRecord = { ...record, state: snapshotExists ? "archived" : "restored", errorMessage: undefined };
  persist(store.paths, next);
  return next;
}

async function finalizeRecordBinding(store: WorktreeLifecycleStore, record: RecoveryRecord, epoch: number): Promise<void> {
  let binding: ChannelWorkspaceBinding | undefined;
  if (record.ownerKind === "channel") binding = store.getChannel(record.ownerId)?.workspaceBinding;
  else {
    for (let offset = 0; ; offset += 500) {
      const page = store.listTeammateDirectThreads({ offset, limit: 500 });
      const thread = page.find((item) => item.id === record.ownerId);
      if (thread) { binding = thread.workspaceBinding; break; }
      if (page.length < 500) break;
    }
  }
  if (binding?.mode !== "managed_worktree" || binding.worktreePath !== record.originalPath || binding.branchName !== record.branchName) {
    throw new Error("Worktree recovery owner no longer matches its recorded path and branch; workspace remains fenced");
  }
  const inspection = await inspectManagedWorktree(record.originalPath);
  const now = new Date().toISOString();
  if (!store.finalizeManagedWorktreeBindingWithinFence({ ownerKind: record.ownerKind, ownerId: record.ownerId,
    ownerRequestId: record.id, expectedEpoch: epoch, now,
    binding: { ...binding, status: inspection.exists ? inspection.status : "not_created",
      errorMessage: inspection.exists ? inspection.errorMessage : undefined, checkedAt: now, updatedAt: now } })) {
    throw new Error("Worktree recovery owner no longer exists; workspace remains fenced");
  }
}

/** Startup only reconciles known identities; it never overwrites or deletes a directory. */
export async function recoverWorktreeOperations(store: WorktreeLifecycleStore): Promise<void> {
  const fence = store.getWorkspaceSnapshotFence(workspaceId);
  if (!fence.ownerRequestId?.startsWith(WORKTREE_FENCE_PREFIX)) return;
  const record = (await records(store.paths)).find((item) => item.id === fence.ownerRequestId);
  if (!record) throw new Error("Worktree lifecycle journal is missing; workspace remains fenced");
  const reconciled = await reconcileRecord(store, record);
  await finalizeRecordBinding(store, reconciled, fence.epoch);
  store.releaseWorkspaceSnapshotFence(workspaceId, record.id, new Date().toISOString(), fence.epoch);
}

export async function restoreWorktreeSnapshot(
  store: WorktreeLifecycleStore,
  snapshotId: string,
  assertIdle: () => void,
  finalize?: (record: WorktreeRecoverySnapshot, fence: { readonly ownerRequestId: string; readonly epoch: number }) => void | Promise<void>,
): Promise<string> {
  let record = (await records(store.paths)).find((item) => item.id === snapshotId);
  if (!record) throw new Error("Worktree recovery snapshot was not found");
  if (record.state === "restored") {
    await assertOwnedLinkedWorktree(record.repoRoot, record.originalPath, record.branchName, record.gitDir);
    return record.originalPath;
  }
  if (await pathExists(record.originalPath)) throw new Error("恢复目标已存在，已保留现有目录与恢复快照。");
  await assertOwnedLinkedWorktree(record.repoRoot, record.snapshotPath, record.branchName, record.gitDir);
  record = { ...record, state: "restoring", errorMessage: undefined };
  const epoch = store.acquireWorkspaceSnapshotFence(workspaceId, record.id, new Date().toISOString());
  let verified = false;
  let finalizationFailed = false;
  try {
    assertIdle();
    assertWorktreeIdle(store, record.snapshotPath);
    persist(store.paths, record);
    let lock: string | undefined;
    try { lock = (await readFile(join(record.gitDir, "locked"), "utf8")).trim(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (lock && lock !== record.id) throw new Error("Worktree has a foreign Git lock");
    if (lock) await git(record.repoRoot, ["worktree", "unlock", record.snapshotPath]);
    await git(record.repoRoot, ["worktree", "move", record.snapshotPath, record.originalPath]);
    syncDirectory(dirname(record.originalPath));
    syncDirectory(dirname(record.snapshotPath));
    await assertOwnedLinkedWorktree(record.repoRoot, record.originalPath, record.branchName, record.gitDir);
    record = { ...record, state: "restored" };
    persist(store.paths, record);
    if (finalize) {
      try { await finalize(record, { ownerRequestId: record.id, epoch }); }
      catch (error) { finalizationFailed = true; throw error; }
    }
    try { await finalizeRecordBinding(store, record, epoch); }
    catch (error) { finalizationFailed = true; throw error; }
    verified = true;
    return record.originalPath;
  } catch (error) {
    const observed = await reconcileRecord(store, record).catch(() => undefined);
    if (observed && !finalizationFailed) {
      try { await finalizeRecordBinding(store, observed, epoch); verified = true; }
      catch { finalizationFailed = true; }
    }
    if (finalizationFailed) persist(store.paths, { ...record, state: "blocked", errorMessage: "工作树目录已保留，归属更新未完成。" });
    throw error;
  } finally {
    if (verified) store.releaseWorkspaceSnapshotFence(workspaceId, record.id, new Date().toISOString(), epoch);
  }
}

export async function restoreWorktreeForCreation(store: WorktreeLifecycleStore, path: string, repoRoot: string, branchName: string): Promise<boolean> {
  const candidates = (await records(store.paths)).filter((item) => item.originalPath === resolve(path) && item.state !== "restored");
  const record = (await Promise.all(candidates.map(async (item) => await pathExists(item.snapshotPath) ? item : undefined))).find(Boolean);
  if (!record) return false;
  if (await realpath(record.repoRoot) !== await realpath(repoRoot) || record.branchName !== branchName) throw new Error("Recovery snapshot belongs to a different repository or branch");
  await restoreWorktreeSnapshot(store, record.id, () => assertWorktreeIdle(store, path));
  return true;
}

/** Return the repository recorded for a retained snapshot before the original path is restored. */
export async function findWorktreeRecoveryRepoRoot(store: WorktreeLifecycleStore, path: string, branchName: string): Promise<string | undefined> {
  const candidates = (await records(store.paths)).filter((item) => item.originalPath === resolve(path) && item.state !== "restored");
  const record = (await Promise.all(candidates.map(async (item) => await pathExists(item.snapshotPath) ? item : undefined))).find(Boolean);
  if (!record) return undefined;
  if (record.branchName !== branchName) throw new Error("Recovery snapshot belongs to a different branch");
  return record.repoRoot;
}
