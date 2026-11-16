import type { ChannelWorkspaceBinding, RunStore } from "@ling-stack/core";
import type { ManagedWorktreeActionRequest, ManagedWorktreeEntry, ManagedWorktreeListResponse } from "@ling-stack/contracts";
import { git, inspectManagedWorktree, resolveGitRepoRoot } from "./managed-worktrees.js";
import { initializeWorktree } from "./worktree-initialization.js";
import { archiveWorktree, listWorktreeSnapshots, recoverWorktreeOperations, restoreWorktreeSnapshot } from "./worktree-recovery.js";
import { assertWorktreeIdle, coordinateWorktreeMutation, worktreeContains } from "./worktree-mutation.js";
import { worktreeRoot } from "./worktree-policy.js";

interface OwnedWorktree {
  readonly kind: "channel" | "teammate"; readonly id: string; readonly name: string;
  readonly repoPath: string; readonly binding: ChannelWorkspaceBinding; readonly pinned: boolean; readonly lastUsedAt: string;
}
interface WorkspaceReference { readonly kind: "channel" | "teammate"; readonly id: string; readonly paths: readonly string[] }
export class WorktreeActionError extends Error { constructor(readonly code: string, message: string) { super(message); } }

function allPages<T extends { readonly id: string }>(load: (offset: number) => T[]): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    const page = load(offset);
    if (page.some((item) => seen.has(item.id))) throw new WorktreeActionError("worktree_owner_limit", "工作区归属分页不稳定，已停止清理。");
    for (const item of page) { seen.add(item.id); result.push(item); }
    if (page.length < 500) return result;
  }
}

function owners(store: RunStore, cwd: string): { entries: OwnedWorktree[]; references: WorkspaceReference[]; limitReached: boolean } {
  const activeChannels = allPages((offset) => store.listChannels({ limit: 500, offset }));
  const archivedChannels = allPages((offset) => store.listChannels({ archived: true, limit: 500, offset }));
  const threads = allPages((offset) => store.listTeammateDirectThreads({ limit: 500, offset }));
  const entries: OwnedWorktree[] = [];
  const references: WorkspaceReference[] = [];
  const protectedOwners = store.getWorkspaceSettings().worktreePolicy?.protectedOwners ?? [];
  for (const channel of [...activeChannels, ...archivedChannels]) {
    references.push({ kind: "channel", id: channel.id, paths: [channel.workspaceBinding?.executionPath, channel.workspaceBinding?.worktreePath, channel.boundPath].filter((path): path is string => Boolean(path)) });
    if (channel.workspaceBinding?.mode !== "managed_worktree" || !channel.workspaceBinding.worktreePath) continue;
    const chats = allPages((offset) => store.listLingThreads({ channelId: channel.id, includeArchived: true, limit: 500, offset }));
    entries.push({ kind: "channel", id: channel.id, name: channel.name, repoPath: channel.boundPath ?? cwd, binding: channel.workspaceBinding,
      pinned: chats.some((chat) => Boolean(chat.pinnedAt)) || protectedOwners.some((item) => item.ownerKind === "channel" && item.ownerId === channel.id),
      lastUsedAt: [channel.updatedAt, ...chats.map((chat) => chat.updatedAt)].sort().at(-1)! });
  }
  for (const thread of threads) {
    references.push({ kind: "teammate", id: thread.id, paths: [thread.workspaceBinding?.executionPath, thread.workspaceBinding?.worktreePath].filter((path): path is string => Boolean(path)) });
    if (thread.workspaceBinding?.mode !== "managed_worktree" || !thread.workspaceBinding.worktreePath) continue;
    const chats = allPages((offset) => store.listLingThreads({ teammateId: thread.teammateId, includeArchived: true, limit: 500, offset }));
    const teammate = store.getAiTeammate(thread.teammateId);
    entries.push({ kind: "teammate", id: thread.id, name: teammate?.displayName ?? thread.title, repoPath: cwd, binding: thread.workspaceBinding,
      pinned: Boolean(teammate?.pinned) || chats.some((chat) => Boolean(chat.pinnedAt)) || protectedOwners.some((item) => item.ownerKind === "teammate" && item.ownerId === thread.id),
      lastUsedAt: [thread.updatedAt, ...chats.map((chat) => chat.updatedAt)].sort().at(-1)! });
  }
  return { entries, references, limitReached: false };
}

function inUse(store: RunStore, path: string): boolean { try { assertWorktreeIdle(store, path); return false; } catch { return true; } }

export async function listManagedWorktrees(store: RunStore, cwd: string): Promise<ManagedWorktreeListResponse> {
  const owned = owners(store, cwd);
  const entries: ManagedWorktreeEntry[] = [];
  for (let i = 0; i < owned.entries.length; i += 4) {
    entries.push(...await Promise.all(owned.entries.slice(i, i + 4).map(async (owner): Promise<ManagedWorktreeEntry> => {
      const path = owner.binding.worktreePath!;
      const inspection = await inspectManagedWorktree(path);
      return { ownerKind: owner.kind, ownerId: owner.id, ownerName: owner.name, path, branchName: owner.binding.branchName,
        status: !inspection.exists && owner.binding.status === "not_created" ? "not_created" : inspection.status,
        isDirty: inspection.isDirty, inUse: inUse(store, path), pinned: owner.pinned,
        kept: (store.getWorkspaceSettings().worktreePolicy?.protectedOwners ?? []).some((item) => item.ownerKind === owner.kind && item.ownerId === owner.id), lastUsedAt: owner.lastUsedAt,
        initialization: inspection.initialization, errorMessage: inspection.status === "blocked" ? inspection.errorMessage : undefined };
    })));
  }
  const policy = store.getWorkspaceSettings().worktreePolicy ?? { fetchBeforeCreate: false };
  return { cwd, policy, defaultRootDir: store.paths.worktreesDir, effectiveRootDir: worktreeRoot(store.paths, policy),
    snapshots: await listWorktreeSnapshots(store.paths), entries, limitReached: owned.limitReached };
}

export async function actOnManagedWorktree(store: RunStore, cwd: string, input: ManagedWorktreeActionRequest): Promise<string> {
  return coordinateWorktreeMutation(store, () => actOnManagedWorktreeLocked(store, cwd, input));
}

/** Caller owns the workspace mutation queue; the durable fence also blocks Run admission. */
export async function actOnManagedWorktreeLocked(store: RunStore, cwd: string, input: ManagedWorktreeActionRequest, automatic = false): Promise<string> {
  await recoverWorktreeOperations(store);
  store.assertWorkspaceSnapshotFence(cwd);
  const owner = owners(store, cwd).entries.find((entry) => entry.kind === input.ownerKind && entry.id === input.ownerId);
  if (!owner) throw new WorktreeActionError("worktree_not_found", "未找到 Ling 托管的工作树。");
  const path = owner.binding.worktreePath!;
  const policy = store.getWorkspaceSettings().worktreePolicy ?? { fetchBeforeCreate: false };
  if (input.action === "pin" || input.action === "unpin") {
    const protectedOwners = (policy.protectedOwners ?? []).filter((item) => item.ownerKind !== owner.kind || item.ownerId !== owner.id);
    if (input.action === "pin") protectedOwners.push({ ownerKind: owner.kind, ownerId: owner.id });
    store.updateWorkspaceSettings({ worktreePolicy: { ...policy, protectedOwners } }, new Date().toISOString());
    return path;
  }
  if (input.action === "open") {
    const inspection = await inspectManagedWorktree(path);
    if (!inspection.exists || !inspection.isGitWorktree) throw new WorktreeActionError("worktree_unavailable", inspection.errorMessage ?? "工作树不可用。");
    return path;
  }
  const assertIdle = (): void => {
    try { assertWorktreeIdle(store, path); } catch { throw new WorktreeActionError("worktree_in_use", "工作树正在运行任务或仍有未结束的命令。"); }
    const current = owners(store, cwd);
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
    const repo = await resolveGitRepoRoot(owner.repoPath);
    if (!repo.ok) throw new WorktreeActionError(repo.code, repo.message);
    const { assertOwnedLinkedWorktree } = await import("./worktree-recovery.js");
    await assertOwnedLinkedWorktree(repo.repoRoot, path, owner.binding.branchName ?? "");
    const inspection = await inspectManagedWorktree(path);
    if (!inspection.initialization || inspection.initialization.status === "succeeded") throw new WorktreeActionError("worktree_already_initialized", "工作树不需要重试初始化。");
    assertIdle();
    await initializeWorktree(path, policy.environment, true);
  } else {
    if (!automatic && policy.confirmBeforeDelete !== false && input.confirmed !== true) throw new WorktreeActionError("worktree_confirmation_required", "请确认清理工作树。");
    const inspection = await inspectManagedWorktree(path);
    if (!inspection.exists) throw new WorktreeActionError("worktree_unavailable", "工作树目录不存在。");
    if (inspection.initialization?.status === "running") throw new WorktreeActionError("worktree_in_use", "工作树初始化尚未结束。");
    if (automatic && inspection.isDirty) throw new WorktreeActionError("worktree_dirty", "包含未提交改动的工作树保留。");
    const repo = await resolveGitRepoRoot(owner.repoPath);
    if (!repo.ok) throw new WorktreeActionError(repo.code, repo.message);
    if (owner.binding.branchName && (await git(path, ["branch", "--show-current"])).stdout.trim() !== owner.binding.branchName) throw new WorktreeActionError("worktree_owner_mismatch", "工作树分支与记录不符，无法清理。");
    await archiveWorktree(store, { repoRoot: repo.repoRoot, path, branchName: owner.binding.branchName ?? "", ownerKind: owner.kind, ownerId: owner.id,
      ownerName: owner.name, assertIdle, finalize: assertIdle });
  }
  if (input.action === "restore" || input.action === "cleanup") return path;
  const inspection = await inspectManagedWorktree(path);
  const now = new Date().toISOString();
  const binding: ChannelWorkspaceBinding = { ...owner.binding, status: inspection.exists ? inspection.status : "not_created", errorMessage: inspection.exists ? inspection.errorMessage : undefined, checkedAt: now, updatedAt: now };
  if (owner.kind === "channel") store.updateChannel(owner.id, { workspaceBinding: binding }, now);
  else store.updateTeammateDirectThreadWorkspace(owner.id, binding, now);
  return path;
}
