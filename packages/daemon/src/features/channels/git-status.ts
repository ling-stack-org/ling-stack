import { existsSync } from "node:fs";
import type { WorkspaceGitFileKind, WorkspaceGitStatus, WorkspaceGitStatusFile } from "@ling-stack/contracts";
import { git, redactGitError } from "../workspaces/managed-worktrees.js";

const conflictStatuses = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);

export function buildUnavailableWorkspaceGitStatus(cwd: string, checkedAt: string, unavailableReason: string): WorkspaceGitStatus {
  return {
    state: "unavailable",
    cwd,
    changedFileCount: 0,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    files: [],
    checkedAt,
    unavailableReason,
  };
}

export async function inspectWorkspaceGitStatus(cwd: string, checkedAt: string): Promise<WorkspaceGitStatus> {
  if (!existsSync(cwd)) {
    return buildUnavailableWorkspaceGitStatus(cwd, checkedAt, "Workspace path does not exist.");
  }

  let repoRoot = "";
  try {
    repoRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        state: "not_git_repo",
        cwd,
        changedFileCount: 0,
        stagedFileCount: 0,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        conflictedFileCount: 0,
        files: [],
        checkedAt,
        unavailableReason: "Selected channel workspace is not a Git repository.",
      };
    }
    return buildErrorWorkspaceGitStatus(cwd, checkedAt, error);
  }

  try {
    const statusOutput = (await git(cwd, ["status", "--porcelain=v1", "-b", "--untracked-files=all"])).stdout;
    const parsedStatus = parseGitStatusPorcelain(statusOutput);
    const unstagedStats = await git(cwd, ["diff", "--numstat"]).then((result) => parseGitNumstat(result.stdout)).catch(() => ({ additions: 0, deletions: 0, hasStats: false }));
    const stagedStats = await git(cwd, ["diff", "--cached", "--numstat"]).then((result) => parseGitNumstat(result.stdout)).catch(() => ({ additions: 0, deletions: 0, hasStats: false }));
    const headSha = await git(cwd, ["rev-parse", "--short", "HEAD"]).then((result) => result.stdout.trim() || undefined).catch(() => undefined);
    const stats = mergeGitNumstats(unstagedStats, stagedStats);

    return {
      state: parsedStatus.files.length > 0 ? "dirty" : "clean",
      cwd,
      repoRoot,
      branchName: parsedStatus.branchName,
      upstream: parsedStatus.upstream,
      headSha,
      changedFileCount: parsedStatus.files.length,
      stagedFileCount: parsedStatus.files.filter((file) => file.staged).length,
      unstagedFileCount: parsedStatus.files.filter((file) => file.unstaged).length,
      untrackedFileCount: parsedStatus.files.filter((file) => file.untracked).length,
      conflictedFileCount: parsedStatus.files.filter((file) => file.kind === "conflicted").length,
      additions: stats.hasStats ? stats.additions : undefined,
      deletions: stats.hasStats ? stats.deletions : undefined,
      files: parsedStatus.files,
      checkedAt,
    };
  } catch (error) {
    return buildErrorWorkspaceGitStatus(cwd, checkedAt, error);
  }
}

export function parseGitStatusPorcelain(stdout: string): {
  readonly branchName?: string;
  readonly upstream?: string;
  readonly files: readonly WorkspaceGitStatusFile[];
} {
  let branchName: string | undefined;
  let upstream: string | undefined;
  const files: WorkspaceGitStatusFile[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if (line.startsWith("## ")) {
      const parsedHeader = parseGitBranchHeader(line.slice(3));
      branchName = parsedHeader.branchName;
      upstream = parsedHeader.upstream;
      continue;
    }
    const parsedFile = parseGitStatusFile(line);
    if (parsedFile) {
      files.push(parsedFile);
    }
  }

  return { branchName, upstream, files };
}

export function parseGitNumstat(stdout: string): { readonly additions: number; readonly deletions: number; readonly hasStats: boolean } {
  let additions = 0;
  let deletions = 0;
  let hasStats = false;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [rawAdditions, rawDeletions] = line.split(/\s+/, 3);
    if (!rawAdditions || !rawDeletions || rawAdditions === "-" || rawDeletions === "-") {
      continue;
    }
    const parsedAdditions = Number.parseInt(rawAdditions, 10);
    const parsedDeletions = Number.parseInt(rawDeletions, 10);
    if (!Number.isFinite(parsedAdditions) || !Number.isFinite(parsedDeletions)) {
      continue;
    }
    additions += parsedAdditions;
    deletions += parsedDeletions;
    hasStats = true;
  }

  return { additions, deletions, hasStats };
}

function parseGitBranchHeader(header: string): { readonly branchName?: string; readonly upstream?: string } {
  const withoutStatus = header.replace(/\s+\[.*\]$/, "");
  if (withoutStatus === "HEAD (no branch)") {
    return { branchName: "HEAD" };
  }
  const upstreamSeparator = withoutStatus.indexOf("...");
  if (upstreamSeparator >= 0) {
    return {
      branchName: withoutStatus.slice(0, upstreamSeparator) || undefined,
      upstream: withoutStatus.slice(upstreamSeparator + 3) || undefined,
    };
  }
  return { branchName: withoutStatus || undefined };
}

function parseGitStatusFile(line: string): WorkspaceGitStatusFile | undefined {
  if (line.length < 3) {
    return undefined;
  }
  const indexStatus = line[0] ?? " ";
  const worktreeStatus = line[1] ?? " ";
  const statusPair = `${indexStatus}${worktreeStatus}`;
  const untracked = statusPair === "??";
  const conflicted = conflictStatuses.has(statusPair);
  const rawPath = line.slice(3);
  const { path, originalPath } = parseStatusPath(rawPath, indexStatus);
  const staged = conflicted || (!untracked && indexStatus !== " " && indexStatus !== "?");
  const unstaged = conflicted || (!untracked && worktreeStatus !== " " && worktreeStatus !== "?");

  return {
    path,
    originalPath,
    indexStatus,
    worktreeStatus,
    kind: gitFileKind(indexStatus, worktreeStatus, conflicted, untracked),
    staged,
    unstaged,
    untracked,
  };
}

function parseStatusPath(rawPath: string, indexStatus: string): { readonly path: string; readonly originalPath?: string } {
  if ((indexStatus === "R" || indexStatus === "C") && rawPath.includes(" -> ")) {
    const [originalPath, path] = rawPath.split(" -> ", 2);
    return { originalPath, path: path || rawPath };
  }
  return { path: rawPath };
}

function gitFileKind(indexStatus: string, worktreeStatus: string, conflicted: boolean, untracked: boolean): WorkspaceGitFileKind {
  if (conflicted) {
    return "conflicted";
  }
  if (untracked) {
    return "untracked";
  }
  if (indexStatus === "R" || worktreeStatus === "R") {
    return "renamed";
  }
  if (indexStatus === "C" || worktreeStatus === "C") {
    return "copied";
  }
  if (indexStatus === "A" || worktreeStatus === "A") {
    return "added";
  }
  if (indexStatus === "D" || worktreeStatus === "D") {
    return "deleted";
  }
  if (indexStatus === "M" || worktreeStatus === "M") {
    return "modified";
  }
  return "unknown";
}

function mergeGitNumstats(
  left: { readonly additions: number; readonly deletions: number; readonly hasStats: boolean },
  right: { readonly additions: number; readonly deletions: number; readonly hasStats: boolean },
): { readonly additions: number; readonly deletions: number; readonly hasStats: boolean } {
  return {
    additions: left.additions + right.additions,
    deletions: left.deletions + right.deletions,
    hasStats: left.hasStats || right.hasStats,
  };
}

function buildErrorWorkspaceGitStatus(cwd: string, checkedAt: string, error: unknown): WorkspaceGitStatus {
  return {
    state: "error",
    cwd,
    changedFileCount: 0,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    files: [],
    checkedAt,
    errorMessage: `Git status failed: ${redactGitError(error)}`,
  };
}

function isNotGitRepositoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not a git repository") || message.includes("not a git work tree");
}
