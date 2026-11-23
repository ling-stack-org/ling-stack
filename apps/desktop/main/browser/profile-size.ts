import { lstat, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DeviceStorageCategorySize } from "@ling-stack/contracts";

export async function measureBrowserProfileSize(storagePath: string | null, metadataPath?: string): Promise<DeviceStorageCategorySize> {
  if (!storagePath) return { category: "browser", knownBytes: 0, status: "unavailable", reason: "browser_profile_unavailable" };
  const root = resolve(storagePath);
  let bytes = 0, entries = 0;
  const deadline = Date.now() + 20_000;
  const partial = (reason: NonNullable<DeviceStorageCategorySize["reason"]>): DeviceStorageCategorySize =>
    ({ category: "browser", knownBytes: bytes, status: "partial", reason });
  const budgetLimit = () => Date.now() > deadline ? partial("deadline") : entries >= 300_000 ? partial("entry_limit") : undefined;
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid_profile_path");
    await realpath(root);
    const pending = [root];
    while (pending.length) {
      const directoryLimit = budgetLimit();
      if (directoryLimit) return directoryLimit;
      const directory = pending.pop()!;
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
    if (metadataPath) { const stat = await lstat(metadataPath).catch(() => undefined); if (stat?.isFile() && !stat.isSymbolicLink()) bytes += stat.size; }
    if (Date.now() > deadline) return partial("deadline");
    return { category: "browser", knownBytes: bytes, status: "complete" };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (metadataPath) { const stat = await lstat(metadataPath).catch(() => undefined); if (stat?.isFile() && !stat.isSymbolicLink()) bytes += stat.size; }
      return { category: "browser", knownBytes: bytes, status: "complete" };
    }
    return partial("read_error");
  }
}
