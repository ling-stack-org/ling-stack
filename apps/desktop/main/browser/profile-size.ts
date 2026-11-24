import { lstat, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DeviceStorageCategorySize } from "@ling-stack/contracts";

export interface BrowserProfileScanBudget {
  readonly deadlineMs: number;
  remainingEntries: number;
  readonly signal?: AbortSignal;
}

async function hasExpectedPhysicalPath(path: string): Promise<boolean> {
  const physical = await realpath(path);
  return physical === path || process.platform === "darwin"
    && (path.startsWith("/var/") || path.startsWith("/tmp/")) && physical === `/private${path}`;
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function measureBrowserProfileSize(storagePath: string | null, metadataPaths: readonly (string | undefined)[] = [],
  sharedBudget?: BrowserProfileScanBudget): Promise<DeviceStorageCategorySize> {
  if (!storagePath) return { category: "browser", knownBytes: 0, status: "unavailable", reason: "browser_profile_unavailable" };
  const root = resolve(storagePath);
  let bytes = 0;
  const budget = sharedBudget ?? { deadlineMs: Date.now() + 20_000, remainingEntries: 300_000 };
  const partial = (reason: NonNullable<DeviceStorageCategorySize["reason"]>): DeviceStorageCategorySize =>
    ({ category: "browser", knownBytes: bytes, status: "partial", reason });
  const budgetLimit = () => budget.signal?.aborted || Date.now() >= budget.deadlineMs
    ? partial("deadline") : budget.remainingEntries <= 0 ? partial("entry_limit") : undefined;
  try {
    const pending = (await statIfPresent(root)) ? [root] : [];
    while (pending.length) {
      const directoryLimit = budgetLimit();
      if (directoryLimit) return directoryLimit;
      const directory = pending.pop()!;
      if (!await hasExpectedPhysicalPath(directory)) return partial("read_error");
      for await (const entry of await opendir(directory)) {
        const entryLimit = budgetLimit();
        if (entryLimit) return entryLimit;
        budget.remainingEntries--;
        const path = join(directory, entry.name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) pending.push(path);
        else if (stat.isFile()) bytes += stat.size;
      }
    }
    for (const metadataPath of metadataPaths) {
      if (!metadataPath) continue;
      const metadataLimit = budgetLimit();
      if (metadataLimit) return metadataLimit;
      const metadata = resolve(metadataPath);
      const stat = await statIfPresent(metadata);
      if (stat?.isFile()) {
        budget.remainingEntries--;
        if (!await hasExpectedPhysicalPath(metadata)) return partial("read_error");
        bytes += stat.size;
      }
    }
    if (budget.signal?.aborted || Date.now() >= budget.deadlineMs) return partial("deadline");
    return { category: "browser", knownBytes: bytes, status: "complete" };
  } catch {
    return partial("read_error");
  }
}
