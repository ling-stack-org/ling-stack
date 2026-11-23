import { lstat, opendir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { DeviceStorageCategory, DeviceStorageCategorySize, DeviceStorageScope, DeviceStorageSnapshot } from "@ling-stack/contracts";

export interface OwnedStorageRoots {
  readonly userRoot?: string;
  readonly workspaceRoots: readonly string[];
  readonly worktreeRoots: readonly string[];
  readonly scope: DeviceStorageScope;
  readonly worktreeInventoryIncomplete?: boolean;
}

const categories: readonly DeviceStorageCategory[] = ["conversations", "worktrees", "plugins", "browser", "other"];
const conversationNames = new Set(["sessions", "attachments", "artifacts"]);
const within = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);

export async function scanOwnedStorage(input: OwnedStorageRoots, options: { readonly signal?: AbortSignal; readonly deadlineMs?: number; readonly maxEntries?: number } = {}): Promise<DeviceStorageSnapshot> {
  const roots = [...new Set([input.userRoot, ...input.workspaceRoots, ...input.worktreeRoots].filter((value): value is string => Boolean(value)).map(value => resolve(value)))];
  const workspaceRoots = input.workspaceRoots.map(value => resolve(value));
  const worktreeRoots = input.worktreeRoots.map(value => resolve(value));
  const userRoot = input.userRoot ? resolve(input.userRoot) : undefined;
  const sizes = new Map<DeviceStorageCategory, number>(categories.map(category => [category, 0]));
  const issues = new Map<DeviceStorageCategory, DeviceStorageCategorySize["reason"]>();
  if (input.worktreeInventoryIncomplete) issues.set("worktrees", "read_error");
  const seenFiles = new Set<string>();
  const visitedDirectories = new Set<string>();
  const deadline = Date.now() + (options.deadlineMs ?? 30_000);
  const maxEntries = options.maxEntries ?? 500_000;
  let entries = 0;

  const categoryFor = (path: string): DeviceStorageCategory => {
    if (worktreeRoots.some(root => within(path, root))) return "worktrees";
    const workspaceRoot = workspaceRoots.filter(root => within(path, root)).sort((a, b) => b.length - a.length)[0];
    if (workspaceRoot) {
      const relative = path.slice(workspaceRoot.length + 1).split(sep)[0];
      if (conversationNames.has(relative)) return "conversations";
      if (relative === "plugins") return "plugins";
      if (relative === "worktrees") return "worktrees";
      return "other";
    }
    if (userRoot && within(path, join(userRoot, "plugins"))) return "plugins";
    return "other";
  };
  const mark = (path: string, reason: DeviceStorageCategorySize["reason"]): void => {
    const category = categoryFor(path);
    issues.set(category, reason);
  };
  const checkBudget = (): boolean => {
    const reason = options.signal?.aborted ? "cancelled" : Date.now() > deadline ? "deadline" : entries >= maxEntries ? "entry_limit" : undefined;
    if (!reason) return true;
    for (const category of categories) if (category !== "browser") issues.set(category, reason);
    return false;
  };

  for (const root of roots) {
    if (!checkBudget()) break;
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { mark(root, "unavailable_path"); continue; }
      await realpath(root);
    } catch { mark(root, "unavailable_path"); continue; }
    const pending = [root];
    while (pending.length && checkBudget()) {
      const directory = pending.pop()!;
      if (visitedDirectories.has(directory)) continue;
      visitedDirectories.add(directory);
      try {
        for await (const entry of await opendir(directory)) {
          if (!checkBudget()) break;
          entries++;
          const path = join(directory, entry.name);
          try {
            const stat = await lstat(path);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
              if (userRoot && directory === userRoot && entry.name === "workspaces") continue;
              if (workspaceRoots.includes(directory) && entry.name === "worktrees") continue;
              pending.push(path); continue;
            }
            if (!stat.isFile()) continue;
            const identity = `${stat.dev}:${stat.ino}`;
            if (seenFiles.has(identity)) continue;
            seenFiles.add(identity);
            const category = categoryFor(path);
            sizes.set(category, sizes.get(category)! + stat.size);
          } catch { mark(path, "read_error"); }
        }
      } catch { mark(directory, "read_error"); }
    }
  }
  const rows: DeviceStorageCategorySize[] = categories.map(category => ({ category, knownBytes: sizes.get(category)!,
    status: category === "browser" ? "unavailable" : issues.has(category) ? "partial" : "complete",
    ...(category === "browser" ? { reason: "browser_profile_unavailable" as const } : issues.has(category) ? { reason: issues.get(category) } : {}) }));
  return { measurement: "logical_file_bytes", scope: input.scope, scannedAt: new Date().toISOString(),
    complete: rows.every(row => row.status === "complete"), knownBytes: rows.reduce((total, row) => total + row.knownBytes, 0), categories: rows };
}
