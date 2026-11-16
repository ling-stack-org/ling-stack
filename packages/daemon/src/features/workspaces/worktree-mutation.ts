import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { RunStore, RunStorePathsFacet } from "@ling-stack/core";

export type WorktreeLifecycleStore = Pick<RunStore, "paths" | "acquireWorkspaceSnapshotFence" | "getWorkspaceSnapshotFence"
  | "releaseWorkspaceSnapshotFence" | "listActiveRunScopes" | "listHostCommandWriteBlockers" | "assertWorkspaceSnapshotFence"
  | "getChannel" | "listTeammateDirectThreads" | "finalizeManagedWorktreeBindingWithinFence">;

function canonical(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
export function worktreeContains(root: string, path: string): boolean {
  const child = relative(canonical(root), canonical(path));
  return child === "" || child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep) && !/^[A-Za-z]:/.test(child);
}

export function assertWorktreeIdle(store: WorktreeLifecycleStore, path: string): void {
  if (store.listActiveRunScopes().some((run) => worktreeContains(path, run.cwd) || worktreeContains(run.cwd, path))
    || store.listHostCommandWriteBlockers(path).length > 0) throw Object.assign(new Error("工作树正在运行任务或仍有未结束的命令。"), { code: "worktree_in_use" });
}

const tails = new Map<string, Promise<void>>();

/** Serialize binding changes and filesystem effects within the workspace owner. */
export async function coordinateWorktreeMutation<T>(store: RunStorePathsFacet, operation: () => Promise<T>): Promise<T> {
  const key = resolve(store.paths.rootDir);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((done) => { release = done; });
  tails.set(key, next);
  await previous;
  try { return await operation(); }
  finally { release(); if (tails.get(key) === next) tails.delete(key); }
}
