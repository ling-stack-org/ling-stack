import { lstat, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DeviceStorageCategorySize } from "@ling-stack/contracts";

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function measureBrowserProfileSize(storagePath: string | null, metadataPath?: string, overallDeadline?: number): Promise<DeviceStorageCategorySize> {
  if (!storagePath) return { category: "browser", knownBytes: 0, status: "unavailable", reason: "browser_profile_unavailable" };
  const root = resolve(storagePath);
  let bytes = 0, entries = 0;
  const deadline = Math.min(Date.now() + 20_000, overallDeadline ?? Number.POSITIVE_INFINITY);
  const partial = (reason: NonNullable<DeviceStorageCategorySize["reason"]>): DeviceStorageCategorySize =>
    ({ category: "browser", knownBytes: bytes, status: "partial", reason });
  const budgetLimit = () => Date.now() > deadline ? partial("deadline") : entries >= 300_000 ? partial("entry_limit") : undefined;
  try {
    const pending = (await statIfPresent(root)) ? [root] : [];
    while (pending.length) {
      const directoryLimit = budgetLimit();
      if (directoryLimit) return directoryLimit;
      const directory = pending.pop()!;
      if (await realpath(directory) !== directory) return partial("read_error");
      for await (const entry of await opendir(directory)) {
        const entryLimit = budgetLimit();
        if (entryLimit) return entryLimit;
        entries++;
        const path = join(directory, entry.name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) pending.push(path);
        else if (stat.isFile()) bytes += stat.size;
      }
    }
    if (metadataPath) {
      const metadata = resolve(metadataPath);
      const stat = await statIfPresent(metadata);
      if (stat?.isFile()) {
        if (await realpath(metadata) !== metadata) return partial("read_error");
        bytes += stat.size;
      }
    }
    if (Date.now() > deadline) return partial("deadline");
    return { category: "browser", knownBytes: bytes, status: "complete" };
  } catch {
    return partial("read_error");
  }
}
