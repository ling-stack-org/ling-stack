import { createHash } from "node:crypto";
import { diffLines } from "diff";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkSummaryWorkspace } from "@ling-stack/contracts";
import { git } from "../workspaces/managed-worktrees.js";
import { SummaryCache } from "./cache.js";

const cache = new SummaryCache<WorkSummaryWorkspace>(10_000);
const readArgs = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const readGit = (cwd: string, args: readonly string[]) => git(cwd, [...readArgs, ...args]);

export async function resolveSummaryWorkspace(path: string): Promise<string> {
  const canonical = await realpath(path);
  try {
    return await realpath((await readGit(canonical, ["rev-parse", "--show-toplevel"])).stdout.trim());
  } catch {
    return canonical;
  }
}

export function getGitSummary(cwd: string): Promise<WorkSummaryWorkspace> {
  return cache.get(cwd, () => inspectGitSummary(cwd));
}

interface NumstatEntry { readonly path: string; readonly additions: number; readonly deletions: number; readonly binary: boolean }
function numstatEntries(output: string): NumstatEntry[] {
  const tokens = output.split("\0");
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (!match) throw new Error("Incomplete Git statistics");
    let path = match[3]!;
    if (!path) {
      if (!tokens[i + 1] || !tokens[i + 2]) throw new Error("Incomplete rename statistics");
      path = tokens[i + 2]!; i += 2;
    }
    entries.push({ path, additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0,
      binary: match[1] === "-" || match[2] === "-" });
  }
  return entries;
}
export function parseSummaryNumstat(output: string): { additions: number; deletions: number; changedFiles: number; binaryFiles: number } {
  const entries = numstatEntries(output);
  return { additions: entries.reduce((sum, item) => sum + item.additions, 0), deletions: entries.reduce((sum, item) => sum + item.deletions, 0),
    changedFiles: entries.length, binaryFiles: entries.filter((item) => item.binary).length };
}

export async function inspectGitSummary(cwd: string): Promise<WorkSummaryWorkspace> {
  const base = { key: cwd, cwd, checkedAt: new Date().toISOString(), commits: [], partial: false } as const;
  try {
    await readGit(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    const notRepository = /not a git repository/i.test(String(error));
    return { ...base, state: notRepository ? "not_repository" : "unavailable", error: notRepository ? undefined : "Git inspection unavailable" };
  }
  try {
    const headResult = await readGit(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
    const headSha = headResult?.stdout.trim();
    const branch = (await readGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => undefined))?.stdout.trim();
    const [numstat, untracked, log, unmerged] = await Promise.all([
      headSha ? readGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "HEAD", "--"]) : undefined,
      readGit(cwd, ["ls-files", ...(!headSha ? ["--cached"] : []), "--others", "--exclude-standard", "-z"]),
      headSha ? readGit(cwd, ["log", "-3", "--format=%H%x00%cI%x00%s%x00"]) : undefined,
      readGit(cwd, ["ls-files", "--unmerged", "-z"]),
    ]);
    const stats = numstat ? parseSummaryNumstat(numstat.stdout) : { additions: 0, deletions: 0, changedFiles: 0, binaryFiles: 0 };
    const trackedEntries = new Map(numstatEntries(numstat?.stdout ?? "").map((entry) => [entry.path, entry]));
    const paths = [...new Set(untracked.stdout.split("\0").filter(Boolean))];
    let partial = Boolean(unmerged.stdout) || paths.length > 200;
    let totalBytes = 0;
    for (const path of paths.slice(0, 200)) {
      const file = resolve(cwd, path);
      try {
        const metadata = await lstat(file);
        if (!metadata.isFile() && !metadata.isSymbolicLink()) { partial = true; continue; }
        const tracked = trackedEntries.get(path);
        if (!tracked) stats.changedFiles++;
        totalBytes += metadata.size;
        if (metadata.size > 1024 * 1024 || totalBytes > 8 * 1024 * 1024) { partial = true; continue; }
        let content: Buffer;
        if (metadata.isSymbolicLink()) content = Buffer.from(await readlink(file));
        else {
          // O_NOFOLLOW prevents a file replaced by a symlink during a scan from escaping the worktree.
          const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            content = Buffer.alloc(Math.min(metadata.size + 1, 1024 * 1024 + 1));
            const { bytesRead } = await handle.read(content, 0, content.length, 0);
            content = content.subarray(0, bytesRead);
            if (bytesRead > metadata.size) { partial = true; continue; }
          } finally { await handle.close(); }
        }
        if (tracked && headSha) {
          // A staged deletion can reappear as an untracked file at the same path.
          // Compare its final content with HEAD instead of counting delete + add.
          const beforeSha = (await readGit(cwd, ["rev-parse", `HEAD:${path}`])).stdout.trim();
          const contentSha = createHash(beforeSha.length === 64 ? "sha256" : "sha1")
            .update(Buffer.from(`blob ${content.length}\0`)).update(content).digest("hex");
          stats.additions -= tracked.additions; stats.deletions -= tracked.deletions;
          if (tracked.binary) stats.binaryFiles--;
          if (beforeSha === contentSha) { stats.changedFiles--; continue; }
          const before = (await readGit(cwd, ["show", `HEAD:${path}`])).stdout;
          if (content.includes(0) || before.includes("\0")) {
            stats.binaryFiles++; // Binary content remains a file change without invented line totals.
          } else {
            const changes = diffLines(before, content.toString("utf8"), { timeout: 100 });
            if (!changes) { partial = true; continue; }
            const added = changes.filter((part) => part.added).reduce((sum, part) => sum + part.count, 0);
            const deleted = changes.filter((part) => part.removed).reduce((sum, part) => sum + part.count, 0);
            stats.additions += added; stats.deletions += deleted;
            if (!added && !deleted) stats.changedFiles--;
          }
        } else if (content.includes(0)) stats.binaryFiles++;
        else stats.additions += countTextLines(content);
      } catch (error) {
        if (!headSha && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        partial = true;
      }
    }
    const commits: WorkSummaryWorkspace["commits"][number][] = [];
    const tokens = log?.stdout.split("\0") ?? [];
    for (let i = 0; i + 2 < tokens.length; i += 3) {
      commits.push({ sha: tokens[i]!.trim(), committedAt: tokens[i + 1]!, subject: tokens[i + 2]! });
    }
    return { ...base, state: "ready", branch: branch || (headSha ? "HEAD" : undefined), headSha, ...stats,
      // Unknown totals remain absent, so partial scans cannot look like complete counts.
      changedFiles: partial ? undefined : stats.changedFiles,
      additions: partial ? undefined : stats.additions, deletions: partial ? undefined : stats.deletions,
      partial, commits };
  } catch {
    return { ...base, state: "unavailable", error: "Git statistics unavailable; retry after the workspace is accessible." };
  }
}

function countTextLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let count = content.at(-1) === 10 ? 0 : 1;
  for (const byte of content) if (byte === 10) count++;
  return count;
}
