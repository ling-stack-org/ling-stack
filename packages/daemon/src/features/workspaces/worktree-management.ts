import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { ChannelWorkspaceBinding, ManagedWorktreeIdentity, RunStore } from "@ling-stack/core";
import type { ManagedWorktreeActionRequest, ManagedWorktreeEntry, ManagedWorktreeListResponse, WorktreeInitialization, WorktreeInitializationChallenge } from "@ling-stack/contracts";
import { inspectManagedWorktree, type ManagedWorktreeInspection } from "./managed-worktrees.js";
import { initializeWorktree, worktreeEnvironmentFingerprint } from "./worktree-initialization.js";
import { archiveWorktree, listWorktreeSnapshots, recoverWorktreeOperations, restoreWorktreeSnapshot } from "./worktree-recovery.js";
import { assertOwnedLinkedWorktree, resolveWorktreeSource, type ManagedWorktreeOwner } from "./worktree-identity.js";
import { assertWorktreeIdle, coordinateWorktreeMutation, worktreeContains } from "./worktree-mutation.js";
import { redactWorktreePolicy, worktreeRoot } from "./worktree-policy.js";

type OwnedWorktree = ManagedWorktreeOwner & {
  readonly name: string; readonly binding: ChannelWorkspaceBinding; readonly path: string;
  readonly pinned: boolean; readonly lastUsedAt: string;
};
interface WorkspaceReference { readonly kind: "channel" | "teammate"; readonly id: string; readonly paths: readonly string[] }
export class WorktreeActionError extends Error { constructor(readonly code: string, message: string) { super(message); } }

function allPages<T extends { readonly id: string }>(load: (offset: number) => T[], checkBudget: () => void = () => {}): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    checkBudget();
    const page = load(offset);
    if (page.some((item) => seen.has(item.id))) throw new WorktreeActionError("worktree_owner_limit", "工作区归属分页不稳定，已停止清理。");
    for (const item of page) { seen.add(item.id); result.push(item); }
    if (page.length < 500) return result;
  }
}

function owners(store: RunStore, checkBudget: () => void = () => {}): { entries: OwnedWorktree[]; references: WorkspaceReference[]; limitReached: boolean } {
  const activeChannels = allPages((offset) => store.listChannels({ limit: 500, offset }), checkBudget);
  const archivedChannels = allPages((offset) => store.listChannels({ archived: true, limit: 500, offset }), checkBudget);
  const threads = allPages((offset) => store.listTeammateDirectThreads({ limit: 500, offset }), checkBudget);
  const entries: OwnedWorktree[] = [];
  const references: WorkspaceReference[] = [];
  const protectedOwners = store.getWorkspaceSettings().worktreePolicy?.protectedOwners ?? [];
  for (const channel of [...activeChannels, ...archivedChannels]) {
    checkBudget();
    references.push({ kind: "channel", id: channel.id, paths: [channel.workspaceBinding?.executionPath, channel.workspaceBinding?.worktreePath, channel.boundPath].filter((path): path is string => Boolean(path)) });
    if (channel.workspaceBinding?.mode !== "managed_worktree" || !channel.workspaceBinding.worktreePath) continue;
    const chats = allPages((offset) => store.listLingThreads({ channelId: channel.id, includeArchived: true, limit: 500, offset }), checkBudget);
    entries.push({ kind: "channel", id: channel.id, name: channel.name, boundPath: channel.boundPath, binding: channel.workspaceBinding, path: channel.workspaceBinding.worktreePath,
      pinned: chats.some((chat) => Boolean(chat.pinnedAt)) || protectedOwners.some((item) => item.ownerKind === "channel" && item.ownerId === channel.id),
      lastUsedAt: [channel.updatedAt, ...chats.map((chat) => chat.updatedAt)].sort().at(-1)! });
  }
  for (const thread of threads) {
    checkBudget();
    references.push({ kind: "teammate", id: thread.id, paths: [thread.workspaceBinding?.executionPath, thread.workspaceBinding?.worktreePath].filter((path): path is string => Boolean(path)) });
    if (thread.workspaceBinding?.mode !== "managed_worktree" || !thread.workspaceBinding.worktreePath) continue;
    const chats = allPages((offset) => store.listLingThreads({ teammateId: thread.teammateId, includeArchived: true, limit: 500, offset }), checkBudget);
    const teammate = store.getAiTeammate(thread.teammateId);
    entries.push({ kind: "teammate", id: thread.id, name: teammate?.displayName ?? thread.title, teammateId: thread.teammateId, binding: thread.workspaceBinding, path: thread.workspaceBinding.worktreePath,
      pinned: Boolean(teammate?.pinned) || chats.some((chat) => Boolean(chat.pinnedAt)) || protectedOwners.some((item) => item.ownerKind === "teammate" && item.ownerId === thread.id),
      lastUsedAt: [thread.updatedAt, ...chats.map((chat) => chat.updatedAt)].sort().at(-1)! });
  }
  return { entries, references, limitReached: false };
}

function inUse(store: RunStore, path: string): boolean { try { assertWorktreeIdle(store, path); return false; } catch { return true; } }

async function assertManagedOwnerIdentity(store: RunStore, owner: OwnedWorktree): Promise<ManagedWorktreeIdentity> {
  const source = await resolveWorktreeSource(store.paths, owner, owner.binding);
  if (!source.ok) throw new WorktreeActionError(source.code, source.message);
  try {
    return await assertOwnedLinkedWorktree(source.repoRoot, owner.path, owner.binding.branchName ?? "", source.identity);
  } catch {
    throw new WorktreeActionError("worktree_owner_mismatch", "工作树与记录的仓库、目录或分支不符。");
  }
}

async function inspectOwnedWorktree(store: RunStore, owner: OwnedWorktree): Promise<ManagedWorktreeInspection> {
  try {
    await lstat(owner.path);
    await assertManagedOwnerIdentity(store, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, isGitWorktree: false, isDirty: false, porcelain: "", status: "missing" };
    }
    return { exists: true, isGitWorktree: false, isDirty: false, porcelain: "", status: "blocked",
      errorMessage: error instanceof WorktreeActionError ? error.message : "无法核对托管工作树目录。" };
  }
  return inspectManagedWorktree(owner.path);
}

function publicInitialization(value: WorktreeInitialization | undefined): WorktreeInitialization | undefined {
  if (!value) return undefined;
  const { status, output, completedAt, errorMessage } = value;
  return { status, output, completedAt, errorMessage };
}

export async function listManagedWorktrees(store: RunStore, cwd: string,
  options: { readonly signal?: AbortSignal; readonly deadline?: number } = {}): Promise<ManagedWorktreeListResponse> {
  const checkBudget = (): void => {
    if (options.signal?.aborted || options.deadline !== undefined && Date.now() >= options.deadline) {
      throw new Error("worktree_inventory_interrupted");
    }
  };
  const owned = owners(store, checkBudget);
  const policy = store.getWorkspaceSettings().worktreePolicy ?? { fetchBeforeCreate: false };
  const entries: ManagedWorktreeEntry[] = [];
  for (let i = 0; i < owned.entries.length; i += 4) {
    checkBudget();
    entries.push(...await Promise.all(owned.entries.slice(i, i + 4).map(async (owner): Promise<ManagedWorktreeEntry> => {
      checkBudget();
      const path = owner.path;
      const inspection = await inspectOwnedWorktree(store, owner);
      checkBudget();
      return { ownerKind: owner.kind, ownerId: owner.id, ownerName: owner.name, path, branchName: owner.binding.branchName,
        status: !inspection.exists && owner.binding.status === "not_created" ? "not_created" : inspection.status,
        isDirty: inspection.isDirty, inUse: inUse(store, path), pinned: owner.pinned,
        kept: (policy.protectedOwners ?? []).some((item) => item.ownerKind === owner.kind && item.ownerId === owner.id), lastUsedAt: owner.lastUsedAt,
        initialization: publicInitialization(inspection.initialization), errorMessage: inspection.status === "blocked" ? inspection.errorMessage : undefined };
    })));
  }
  checkBudget();
  const snapshots = await listWorktreeSnapshots(store.paths);
  checkBudget();
  return { cwd, policy: redactWorktreePolicy(policy)!, defaultRootDir: store.paths.worktreesDir, effectiveRootDir: worktreeRoot(store.paths, policy),
    snapshots, entries, limitReached: owned.limitReached };
}

export async function actOnManagedWorktree(store: RunStore, cwd: string, input: ManagedWorktreeActionRequest): Promise<string> {
  return coordinateWorktreeMutation(store, () => actOnManagedWorktreeLocked(store, cwd, input));
}

/** Caller owns the workspace mutation queue; the durable fence also blocks Run admission. */
export async function actOnManagedWorktreeLocked(store: RunStore, cwd: string, input: ManagedWorktreeActionRequest, automatic = false, initializationApproval?: InitializationApproval): Promise<string> {
  await recoverWorktreeOperations(store);
  store.assertWorkspaceSnapshotFence(cwd);
  const owner = owners(store).entries.find((entry) => entry.kind === input.ownerKind && entry.id === input.ownerId);
  if (!owner) throw new WorktreeActionError("worktree_not_found", "未找到 Ling 托管的工作树。");
  const path = owner.path;
  const policy = store.getWorkspaceSettings().worktreePolicy ?? { fetchBeforeCreate: false };
  if (input.action === "pin" || input.action === "unpin") {
    const protectedOwners = (policy.protectedOwners ?? []).filter((item) => item.ownerKind !== owner.kind || item.ownerId !== owner.id);
    if (input.action === "pin") protectedOwners.push({ ownerKind: owner.kind, ownerId: owner.id });
    store.updateWorkspaceSettings({ worktreePolicy: { ...policy, protectedOwners } }, new Date().toISOString());
    return path;
  }
  if (input.action === "open") {
    await assertManagedOwnerIdentity(store, owner);
    return path;
  }
  const assertIdle = (): void => {
    try { assertWorktreeIdle(store, path); } catch { throw new WorktreeActionError("worktree_in_use", "工作树正在运行任务或仍有未结束的命令。"); }
    const current = owners(store);
    if (current.limitReached) throw new WorktreeActionError("worktree_owner_limit", "工作区归属记录过多，无法完整核查占用，已停止清理。");
    const latest = current.entries.find((entry) => entry.kind === owner.kind && entry.id === owner.id);
    if (!latest || latest.binding.worktreePath !== path || latest.binding.branchName !== owner.binding.branchName) throw new WorktreeActionError("worktree_owner_mismatch", "工作区归属已变化，请刷新后重试。");
    if (current.references.some((other) => (other.kind !== owner.kind || other.id !== owner.id) && other.paths.some((reference) => worktreeContains(path, reference)))) throw new WorktreeActionError("worktree_shared", "工作树仍由其他会话使用，无法清理。");
    if (automatic && latest.pinned) throw new WorktreeActionError("worktree_pinned", "置顶工作树保留。");
  };
  assertIdle();
  if (input.action === "restore") {
    const snapshot = (await listWorktreeSnapshots(store.paths)).find((item) => item.id === input.snapshotId);
    if (!snapshot || snapshot.ownerKind !== owner.kind || snapshot.ownerId !== owner.id || snapshot.originalPath !== path) throw new WorktreeActionError("worktree_snapshot_mismatch", "恢复快照与工作树归属不符。");
    await restoreWorktreeSnapshot(store, snapshot.id, assertIdle, assertIdle);
  } else if (input.action === "initialize") {
    if (!initializationApproval) throw new WorktreeActionError("worktree_desktop_confirmation_required", "请在 Ling 桌面应用中确认初始化脚本。");
    const target = await inspectInitializationTarget(store, owner);
    if (initializationApproval.path !== path || initializationApproval.fingerprint !== target.fingerprint
      || initializationApproval.directory !== target.directory
      || initializationApproval.identity.gitDir !== target.identity.gitDir
      || initializationApproval.identity.gitCommonDir !== target.identity.gitCommonDir
      || initializationApproval.identity.repoRoot !== target.identity.repoRoot) {
      throw new WorktreeActionError("worktree_initialization_changed", "初始化配置或工作树已变化，请重新确认。");
    }
    assertIdle();
    await initializeWorktree(path, target.environment, { retry: true, approvalFingerprint: target.fingerprint });
  } else {
    if (!automatic && policy.confirmBeforeDelete !== false && input.confirmed !== true) throw new WorktreeActionError("worktree_confirmation_required", "请确认清理工作树。");
    const identity = await assertManagedOwnerIdentity(store, owner);
    const inspection = await inspectManagedWorktree(path);
    if (!inspection.isGitWorktree) throw new WorktreeActionError("worktree_unavailable", inspection.errorMessage ?? "工作树不可用。");
    if (inspection.initialization?.status === "running") throw new WorktreeActionError("worktree_in_use", "工作树初始化尚未结束。");
    if (automatic && inspection.isDirty) throw new WorktreeActionError("worktree_dirty", "包含未提交改动的工作树保留。");
    await archiveWorktree(store, { repoRoot: identity.repoRoot, path, branchName: owner.binding.branchName ?? "", ownerKind: owner.kind, ownerId: owner.id,
      ownerName: owner.name, expectedIdentity: identity, assertIdle, finalize: assertIdle });
  }
  if (input.action === "restore" || input.action === "cleanup") return path;
  const inspection = await inspectManagedWorktree(path);
  const now = new Date().toISOString();
  const binding: ChannelWorkspaceBinding = { ...owner.binding, status: inspection.exists ? inspection.status : "not_created", errorMessage: inspection.exists ? inspection.errorMessage : undefined, checkedAt: now, updatedAt: now };
  if (owner.kind === "channel") store.updateChannel(owner.id, { workspaceBinding: binding }, now);
  else store.updateTeammateDirectThreadWorkspace(owner.id, binding, now);
  return path;
}

interface InitializationApproval {
  readonly ownerKind: ManagedWorktreeActionRequest["ownerKind"]; readonly ownerId: string; readonly cwd: string;
  readonly path: string; readonly fingerprint: string; readonly identity: ManagedWorktreeIdentity; readonly directory: string; readonly expiresAt: number;
}
const initializationApprovals = new WeakMap<RunStore, Map<string, InitializationApproval>>();
const INITIALIZATION_APPROVAL_TTL_MS = 2 * 60 * 1000;

async function inspectInitializationTarget(store: RunStore, owner: OwnedWorktree) {
  const path = owner.path;
  assertWorktreeIdle(store, path);
  const identity = await assertManagedOwnerIdentity(store, owner);
  const metadata = await lstat(path, { bigint: true });
  const inspection = await inspectManagedWorktree(path);
  if (!inspection.initialization || inspection.initialization.status === "succeeded") throw new WorktreeActionError("worktree_already_initialized", "工作树不需要重试初始化。");
  const environment = store.getWorkspaceSettings().worktreePolicy?.environment;
  return { path, identity, directory: [metadata.dev, metadata.ino, metadata.birthtimeNs].join(":"), fingerprint: worktreeEnvironmentFingerprint(environment), environment };
}

/** Desktop Main alone receives the exact saved script and a short-lived execution challenge. */
export async function prepareManagedWorktreeInitialization(store: RunStore, cwd: string, input: Pick<ManagedWorktreeActionRequest, "ownerKind" | "ownerId">): Promise<WorktreeInitializationChallenge> {
  return coordinateWorktreeMutation(store, async () => {
    await recoverWorktreeOperations(store);
    store.assertWorkspaceSnapshotFence(cwd);
    const owner = owners(store).entries.find((entry) => entry.kind === input.ownerKind && entry.id === input.ownerId);
    if (!owner) throw new WorktreeActionError("worktree_not_found", "未找到 Ling 托管的工作树。");
    const target = await inspectInitializationTarget(store, owner);
    const pending = initializationApprovals.get(store) ?? new Map<string, InitializationApproval>();
    initializationApprovals.set(store, pending);
    const now = Date.now();
    for (const [id, record] of pending) if (record.expiresAt <= now) pending.delete(id);
    if (pending.size >= 64) throw new WorktreeActionError("worktree_confirmation_limit", "初始化确认过多，请稍后重试。");
    const challengeId = randomUUID(), expiresAt = now + INITIALIZATION_APPROVAL_TTL_MS;
    pending.set(challengeId, { ownerKind: input.ownerKind, ownerId: input.ownerId, cwd, path: target.path,
      fingerprint: target.fingerprint, identity: target.identity, directory: target.directory, expiresAt });
    const environment = target.environment;
    return { challengeId, expiresAt: new Date(expiresAt).toISOString(), path: target.path, ownerName: owner.name,
      environment: environment && { enabled: environment.enabled, setupScript: environment.setupScript,
        timeoutSeconds: environment.timeoutSeconds, variableNames: Object.keys(environment.variables) } };
  });
}

/** Consume authority in the same queue as identity/configuration checks and execution. */
export async function completeManagedWorktreeInitialization(store: RunStore, cwd: string, challengeId: string, confirmed: boolean): Promise<void> {
  return coordinateWorktreeMutation(store, async () => {
    const pending = initializationApprovals.get(store), approval = pending?.get(challengeId);
    pending?.delete(challengeId);
    if (!approval || approval.expiresAt <= Date.now() || approval.cwd !== cwd) throw new WorktreeActionError("worktree_confirmation_expired", "初始化确认已过期或已使用，请重新确认。");
    if (!confirmed) return;
    await actOnManagedWorktreeLocked(store, cwd, { ownerKind: approval.ownerKind, ownerId: approval.ownerId, action: "initialize" }, false, approval);
  });
}
