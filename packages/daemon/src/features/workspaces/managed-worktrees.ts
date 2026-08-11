import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRepositoryResolutionErrorCode =
  | "git_inspection_failed"
  | "git_unavailable"
  | "not_git_repository"
  | "workspace_unavailable";

export type WorkspaceBindingCreateResult<TBinding> =
  | { readonly ok: true; readonly binding: TBinding }
  | { readonly ok: false; readonly code: string; readonly message: string };

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

export async function createInitialWorkspaceBinding<TBinding>(input: {
  readonly createManaged: () => Promise<WorkspaceBindingCreateResult<TBinding>>;
  readonly createLocal: () => WorkspaceBindingCreateResult<TBinding>;
}): Promise<WorkspaceBindingCreateResult<TBinding>> {
  const managed = await input.createManaged();
  if (managed.ok || !isGitIsolationUnavailable(managed.code)) {
    return managed;
  }
  return input.createLocal();
}

export async function resolveGitRepoRoot(
  root: string,
  runGit: typeof git = git,
): Promise<
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly code: GitRepositoryResolutionErrorCode; readonly message: string }
> {
  if (!isWorkspaceDirectory(root)) {
    return { ok: false, code: "workspace_unavailable", message: "当前工作区目录不存在、不是目录或不可访问，无法创建或管理独立 worktree。" };
  }
  try {
    const repo = await runGit(root, ["rev-parse", "--show-toplevel"]);
    if (!isWorkspaceDirectory(root)) {
      return { ok: false, code: "workspace_unavailable", message: "当前工作区目录不存在、不是目录或不可访问，无法创建或管理独立 worktree。" };
    }
    if (!repo.stdout.trim()) {
      return { ok: false, code: "git_inspection_failed", message: "Git 仓库检查未返回工作区根目录，无法创建或管理独立 worktree。" };
    }
    return { ok: true, repoRoot: repo.stdout.trim() };
  } catch (error) {
    if (!isWorkspaceDirectory(root)) {
      return { ok: false, code: "workspace_unavailable", message: "当前工作区目录不存在、不是目录或不可访问，无法创建或管理独立 worktree。" };
    }
    return classifyGitRepositoryResolutionError(error);
  }
}

export async function createManagedGitWorktree(input: {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly requestedBaseBranch?: string;
}): Promise<
  | { readonly ok: true; readonly result: ManagedWorktreeCreateResult }
  | { readonly ok: false; readonly code: "git_inspection_failed" | "worktree_create_failed" | "worktree_unavailable"; readonly message: string }
> {
  const baseCommit = await git(input.repoRoot, ["rev-parse", "HEAD"])
    .then((result) => result.stdout.trim())
    .catch(() => "");
  if (!baseCommit) {
    return {
      ok: false,
      code: "git_inspection_failed",
      message: "Git 仓库没有可用的 HEAD 提交，无法创建或管理独立 worktree。",
    };
  }
  const currentBranch = (await git(input.repoRoot, ["branch", "--show-current"]).catch(() => ({ stdout: "" }))).stdout.trim();
  const baseBranch = input.requestedBaseBranch || currentBranch || baseCommit;

  if (!existsSync(input.worktreePath)) {
    await mkdir(dirname(input.worktreePath), { recursive: true });
    try {
      await git(input.repoRoot, ["worktree", "add", "-B", input.branchName, input.worktreePath, baseBranch]);
    } catch (error) {
      return { ok: false, code: "worktree_create_failed", message: `创建 worktree 失败：${redactGitError(error)}` };
    }
    if (!isWorkspaceDirectory(input.worktreePath)) {
      return { ok: false, code: "worktree_unavailable", message: "worktree 创建后目录不可用。" };
    }
    return { ok: true, result: { baseBranch, baseCommit } };
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

function isGitIsolationUnavailable(code: string): boolean {
  return code === "git_inspection_failed" || code === "git_unavailable" || code === "not_git_repository";
}

export function isWorkspaceDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function classifyGitRepositoryResolutionError(error: unknown): {
  readonly ok: false;
  readonly code: Exclude<GitRepositoryResolutionErrorCode, "workspace_unavailable">;
  readonly message: string;
} {
  const record = typeof error === "object" && error !== null
    ? error as { readonly code?: unknown; readonly message?: unknown; readonly stderr?: unknown }
    : undefined;
  if (record?.code === "ENOENT") {
    return { ok: false, code: "git_unavailable", message: "系统未找到 Git 可执行文件，无法创建或管理独立 worktree。" };
  }
  const details = [record?.message, record?.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  if (details.includes("not a git repository") || details.includes("not a git work tree")) {
    return { ok: false, code: "not_git_repository", message: "当前工作区不是 Git 仓库，无法创建或管理独立 worktree。" };
  }
  return { ok: false, code: "git_inspection_failed", message: "无法检查 Git 仓库状态，请确认 Git 可用且工作区可访问。" };
}
