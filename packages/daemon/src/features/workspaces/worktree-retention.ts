import type { RunStore } from "@ling-stack/core";
import { actOnManagedWorktreeLocked, listManagedWorktrees, WorktreeActionError } from "./worktree-management.js";
import { coordinateWorktreeMutation } from "./worktree-mutation.js";
import { recoverWorktreeOperations } from "./worktree-recovery.js";

export interface WorktreeCleanupResult { readonly checkedAt: string; readonly removed: number; readonly errorMessage?: string }
const results = new Map<string, WorktreeCleanupResult>();
export function worktreeCleanupStatus(store: RunStore): WorktreeCleanupResult | undefined { return results.get(store.paths.rootDir); }

export async function maintainManagedWorktrees(store: RunStore, cwd: string): Promise<WorktreeCleanupResult> {
  return coordinateWorktreeMutation(store, async () => {
    let removed = 0;
    let errorMessage: string | undefined;
    try {
      await recoverWorktreeOperations(store);
      const policy = store.getWorkspaceSettings().worktreePolicy;
      if (policy?.autoCleanup) {
        const list = await listManagedWorktrees(store, cwd);
        if (list.limitReached) throw new WorktreeActionError("worktree_owner_limit", "工作树归属记录超过核查上限，自动清理已停止。");
        const active = list.entries.filter((entry) => entry.status === "ready" || entry.status === "blocked");
        let remaining = active.length;
        const target = policy.retainCount ?? 15;
        for (const entry of active.sort((a, b) => (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? "") || a.ownerId.localeCompare(b.ownerId))) {
          if (remaining <= target) break;
          if (entry.pinned || entry.inUse || entry.isDirty || entry.status !== "ready") continue;
          try {
            await actOnManagedWorktreeLocked(store, cwd, { ownerKind: entry.ownerKind, ownerId: entry.ownerId, action: "cleanup" }, true);
            removed++;
            remaining--;
          } catch (error) {
            if (error instanceof WorktreeActionError && ["worktree_in_use", "worktree_shared", "worktree_pinned", "worktree_dirty"].includes(error.code)) continue;
            throw error;
          }
        }
      }
    } catch (error) { errorMessage = error instanceof Error ? error.message : String(error); }
    const result = { checkedAt: new Date().toISOString(), removed, ...(errorMessage ? { errorMessage } : {}) };
    results.set(store.paths.rootDir, result);
    return result;
  });
}

/** Workspace ownership starts maintenance; shutdown drains its filesystem operations. */
export class WorktreeMaintenanceRegistry {
  private readonly entries = new Map<RunStore, { timer?: NodeJS.Timeout; pending?: Promise<unknown> }>();
  private stopped = false;
  constructor(private readonly intervalMs = 60_000) {}
  registerStore(cwd: string, store: RunStore): void {
    if (this.stopped || this.entries.has(store)) return;
    const entry: { timer?: NodeJS.Timeout; pending?: Promise<unknown> } = {};
    this.entries.set(store, entry);
    const tick = (): void => {
      if (this.stopped) return;
      entry.pending = maintainManagedWorktrees(store, cwd).finally(() => {
        entry.pending = undefined;
        if (!this.stopped) { entry.timer = setTimeout(tick, this.intervalMs); entry.timer.unref?.(); }
      });
    };
    tick();
  }
  stopAll(): void { this.stopped = true; for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer); }
  async waitForIdle(): Promise<void> { await Promise.allSettled([...this.entries.values()].flatMap((entry) => entry.pending ? [entry.pending] : [])); }
}
