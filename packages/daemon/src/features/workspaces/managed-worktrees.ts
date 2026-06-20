import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ManagedWorktreeInspection {
  readonly exists: boolean;
  readonly isGitWorktree: boolean;
  readonly isDirty: boolean;
  readonly porcelain: string;
  readonly status: "ready" | "missing" | "blocked";
  readonly errorMessage?: string;
}

export interface ManagedWorktreeCreateResult {
  readonly baseBranch: string;
  readonly baseCommit: string;
}

export interface ManagedWorktreeCleanupResult {
  readonly removed: boolean;
  readonly inspection: ManagedWorktreeInspection;
}

export async function git(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
  const result = await execFileAsync("git", args, { cwd, timeout: 15000, maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

export function redactGitError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\/[^\s"']+/g, "<path>");
}

export function safeGitBranchSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "thread";
}

export async function resolveGitRepoRoot(root: string): Promise<
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly code: "not_git_repository"; readonly message: string }
> {
  const repo = await git(root, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
  if (!repo?.stdout.trim()) {
    return { ok: false, code: "not_git_repository", message: "当前工作区不是 Git 仓库，无法创建或管理独立 worktree。" };
  }
  return { ok: true, repoRoot: repo.stdout.trim() };
}

export async function createManagedGitWorktree(input: {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly requestedBaseBranch?: string;
}): Promise<
  | { readonly ok: true; readonly result: ManagedWorktreeCreateResult }
  | { readonly ok: false; readonly code: "worktree_create_failed" | "worktree_unavailable"; readonly message: string }
> {
  const baseCommit = (await git(input.repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const currentBranch = (await git(input.repoRoot, ["branch", "--show-current"]).catch(() => ({ stdout: "" }))).stdout.trim();
  const baseBranch = input.requestedBaseBranch || currentBranch || baseCommit;

  if (!existsSync(input.worktreePath)) {
    await mkdir(dirname(input.worktreePath), { recursive: true });
    try {
      await git(input.repoRoot, ["worktree", "add", "-B", input.branchName, input.worktreePath, baseBranch]);
    } catch (error) {
      return { ok: false, code: "worktree_create_failed", message: `创建 worktree 失败：${redactGitError(error)}` };
    }
  }

  const inspection = await inspectManagedWorktree(input.worktreePath);
  if (inspection.status !== "ready") {
    return {
      ok: false,
      code: "worktree_unavailable",
      message: inspection.errorMessage ?? "worktree 创建后不可用。",
    };
  }

  return { ok: true, result: { baseBranch, baseCommit } };
}

export async function inspectManagedWorktree(worktreePath: string): Promise<ManagedWorktreeInspection> {
  if (!existsSync(worktreePath)) {
    return {
      exists: false,
      isGitWorktree: false,
      isDirty: false,
      porcelain: "",
      status: "missing",
      errorMessage: "worktree 目录不存在。",
    };
  }

  try {
    const inside = (await git(worktreePath, ["rev-parse", "--is-inside-work-tree"])).stdout.trim();
    if (inside !== "true") {
      return blockedInspection(worktreePath, "worktree 路径存在，但不是 Git worktree。");
    }
    const topLevel = (await git(worktreePath, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (await realpath(topLevel) !== await realpath(worktreePath)) {
      return blockedInspection(worktreePath, "worktree 路径存在，但不是该 Git 工作区根目录。");
    }
    const porcelain = (await git(worktreePath, ["status", "--porcelain"])).stdout;
    return {
      exists: true,
      isGitWorktree: true,
      isDirty: porcelain.trim().length > 0,
      porcelain,
      status: "ready",
    };
  } catch (error) {
    return blockedInspection(worktreePath, `无法检查 worktree 状态：${redactGitError(error)}`);
  }
}

export async function removeManagedWorktreeIfClean(input: {
  readonly repoRoot: string;
  readonly worktreePath: string;
}): Promise<
  | { readonly ok: true; readonly result: ManagedWorktreeCleanupResult }
  | { readonly ok: false; readonly code: "worktree_dirty" | "worktree_blocked" | "worktree_cleanup_failed"; readonly message: string; readonly inspection: ManagedWorktreeInspection }
> {
  const inspection = await inspectManagedWorktree(input.worktreePath);
  if (!inspection.exists) {
    return { ok: true, result: { removed: false, inspection } };
  }
  if (inspection.status === "blocked") {
    return {
      ok: false,
      code: "worktree_blocked",
      message: inspection.errorMessage ?? "worktree 状态不可安全清理。",
      inspection,
    };
  }
  if (inspection.isDirty) {
    return {
      ok: false,
      code: "worktree_dirty",
      message: "worktree 存在未提交或未跟踪改动，已拒绝自动清理。",
      inspection,
    };
  }

  try {
    await git(input.repoRoot, ["worktree", "remove", input.worktreePath]);
  } catch (error) {
    return {
      ok: false,
      code: "worktree_cleanup_failed",
      message: `清理 worktree 失败：${redactGitError(error)}`,
      inspection,
    };
  }

  return { ok: true, result: { removed: true, inspection } };
}

function blockedInspection(worktreePath: string, errorMessage: string): ManagedWorktreeInspection {
  return {
    exists: existsSync(worktreePath),
    isGitWorktree: false,
    isDirty: false,
    porcelain: "",
    status: "blocked",
    errorMessage,
  };
}
