import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createDirectWorkspaceSnapshot,
  type ChannelMessageFileRef,
  type DirectWorkspaceBinding,
  type DirectWorkspaceSnapshot,
  type LingStackRuntimePaths,
  type RunStorePathsFacet,
  type TeammateStoreFacet,
  type TeammateDirectThread,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

const execFileAsync = promisify(execFile);

type DirectWorktreeTarget = Pick<TeammateDirectThread, "id" | "teammateId" | "workspaceBinding">;
type DirectWorkspaceStore = RunStorePathsFacet & TeammateStoreFacet;

export interface DirectWorkspaceReady {
  readonly thread: TeammateDirectThread;
  readonly binding: DirectWorkspaceBinding;
  readonly snapshot: DirectWorkspaceSnapshot;
  readonly executionCwd: string;
}

export function defaultDirectWorkspaceBinding(
  thread: TeammateDirectThread,
  workspaceCwd: string,
  workspacePaths?: LingStackRuntimePaths,
): DirectWorkspaceBinding {
  const worktreePath = directWorktreePath(workspaceCwd, thread.teammateId, thread.id, workspacePaths);
  return {
    mode: "managed_worktree",
    status: "not_created",
    executionPath: worktreePath,
    worktreePath,
    branchName: directWorktreeBranchName(thread.teammateId, thread.id),
    updatedAt: thread.updatedAt,
  };
}

export function assertDirectFileRefsWithinWorkspace(input: {
  readonly thread: TeammateDirectThread;
  readonly workspaceCwd: string;
  readonly workspacePaths?: LingStackRuntimePaths;
  readonly fileRefs: readonly ChannelMessageFileRef[];
}): void {
  if (input.fileRefs.length === 0) {
    return;
  }
  const binding = input.thread.workspaceBinding ?? defaultDirectWorkspaceBinding(input.thread, input.workspaceCwd, input.workspacePaths);
  const bases = uniquePaths([
    input.workspaceCwd,
    binding.executionPath,
    binding.worktreePath,
  ].filter((path): path is string => Boolean(path?.trim())));
  for (const fileRef of input.fileRefs) {
    if (!fileRef.path.trim()) {
      continue;
    }
    const insideAllowedBase = bases.some((base) => {
      const target = isAbsolute(fileRef.path) ? resolvePath(fileRef.path) : resolvePath(base, fileRef.path);
      return isPathInside(base, target);
    });
    if (!insideAllowedBase) {
      throw new Error(`文件引用不在私聊工作区范围内：${fileRef.label?.trim() || fileRef.path}`);
    }
  }
}

export async function ensureDirectWorkspaceReady(input: {
  readonly store: DirectWorkspaceStore;
  readonly thread: TeammateDirectThread;
  readonly workspaceCwd: string;
}): Promise<
  | { readonly ok: true; readonly workspace: DirectWorkspaceReady }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly thread: TeammateDirectThread; readonly binding: DirectWorkspaceBinding }
> {
  const refreshed = refreshDirectWorkspaceBinding(input.thread, input.workspaceCwd, input.store.paths, new Date().toISOString());
  if (refreshed.mode === "local" || refreshed.mode === "external_path") {
    if (refreshed.status === "ready" && existsSync(refreshed.executionPath ?? input.workspaceCwd)) {
      const updated = input.store.updateTeammateDirectThreadWorkspace(input.thread.id, refreshed, refreshed.updatedAt) ?? input.thread;
      return { ok: true, workspace: buildDirectWorkspaceReady(input.workspaceCwd, updated, refreshed) };
    }
    const updated = input.store.updateTeammateDirectThreadWorkspace(input.thread.id, refreshed, refreshed.updatedAt) ?? input.thread;
    return {
      ok: false,
      code: "direct_workspace_unavailable",
      message: refreshed.errorMessage ?? "私聊工作区不可用，可刷新或重建。",
      thread: updated,
      binding: refreshed,
    };
  }

  if (refreshed.status === "ready" && refreshed.worktreePath && existsSync(refreshed.worktreePath)) {
    const updated = input.store.updateTeammateDirectThreadWorkspace(input.thread.id, refreshed, refreshed.updatedAt) ?? input.thread;
    return { ok: true, workspace: buildDirectWorkspaceReady(input.workspaceCwd, updated, refreshed) };
  }

  if (input.thread.workspaceBinding && refreshed.status !== "not_created") {
    const updated = input.store.updateTeammateDirectThreadWorkspace(input.thread.id, refreshed, refreshed.updatedAt) ?? input.thread;
    return {
      ok: false,
      code: "direct_workspace_unavailable",
      message: refreshed.errorMessage ?? "私聊工作区不可用，可刷新或重建。",
      thread: updated,
      binding: refreshed,
    };
  }

  const created = await createManagedDirectWorktreeBinding(input.thread, input.workspaceCwd, input.store.paths);
  if (!created.ok) {
    const failed: DirectWorkspaceBinding = {
      ...refreshed,
      status: "blocked",
      errorMessage: created.message,
      checkedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const updated = input.store.updateTeammateDirectThreadWorkspace(input.thread.id, failed, failed.updatedAt) ?? input.thread;
    return { ok: false, code: created.code, message: created.message, thread: updated, binding: failed };
  }
  const updated = input.store.updateTeammateDirectThreadWorkspace(input.thread.id, created.binding, created.binding.updatedAt) ?? input.thread;
  return { ok: true, workspace: buildDirectWorkspaceReady(input.workspaceCwd, updated, created.binding) };
}

export async function handleTeammateDirectWorkspace(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
  action?: "create-worktree" | "handoff" | "refresh",
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const teammate = store.getAiTeammate(teammateId);
    if (!teammate) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }
    const thread = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());

    if (!action && request.method === "GET") {
      writeJson(response, 200, buildDirectWorkspaceResponse(cwd, teammate.id, thread, store.paths));
      return;
    }

    if (action === "refresh" && request.method === "POST") {
      const binding = refreshDirectWorkspaceBinding(thread, cwd, store.paths, new Date().toISOString());
      const updated = store.updateTeammateDirectThreadWorkspace(thread.id, binding, binding.updatedAt) ?? thread;
      writeJson(response, 200, buildDirectWorkspaceResponse(cwd, teammate.id, updated, store.paths));
      return;
    }

    if (action === "handoff" && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const binding = readHandoffBinding(body, thread, cwd, store.paths, new Date().toISOString());
      const updated = store.updateTeammateDirectThreadWorkspace(thread.id, binding, binding.updatedAt) ?? thread;
      writeJson(response, 200, buildDirectWorkspaceResponse(cwd, teammate.id, updated, store.paths));
      return;
    }

    if (action === "create-worktree" && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes).catch(() => ({}));
      const baseBranch = typeof body === "object" && body !== null && !Array.isArray(body) && typeof (body as { baseBranch?: unknown }).baseBranch === "string"
        ? (body as { baseBranch: string }).baseBranch.trim()
        : "";
      const result = await createManagedDirectWorktreeBinding(thread, cwd, store.paths, baseBranch || undefined);
      if (!result.ok) {
        writeJson(response, 400, { error: result.code, message: result.message });
        return;
      }
      const updated = store.updateTeammateDirectThreadWorkspace(thread.id, result.binding, result.binding.updatedAt) ?? thread;
      writeJson(response, 200, buildDirectWorkspaceResponse(cwd, teammate.id, updated, store.paths));
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct workspace` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildDirectWorkspaceResponse(cwd: string, teammateId: string, thread: TeammateDirectThread, workspacePaths: LingStackRuntimePaths) {
  const binding = thread.workspaceBinding ?? defaultDirectWorkspaceBinding(thread, cwd, workspacePaths);
  const boundThread = { ...thread, workspaceBinding: binding };
  return {
    cwd,
    teammateId,
    threadId: thread.id,
    binding,
    snapshot: createDirectWorkspaceSnapshot(boundThread, cwd),
  };
}

function buildDirectWorkspaceReady(workspaceCwd: string, thread: TeammateDirectThread, binding: DirectWorkspaceBinding): DirectWorkspaceReady {
  const boundThread = { ...thread, workspaceBinding: binding };
  const snapshot = createDirectWorkspaceSnapshot(boundThread, workspaceCwd);
  return {
    thread: boundThread,
    binding,
    snapshot,
    executionCwd: snapshot.executionCwd,
  };
}

function refreshDirectWorkspaceBinding(
  thread: TeammateDirectThread,
  workspaceCwd: string,
  workspacePaths: LingStackRuntimePaths,
  now: string,
): DirectWorkspaceBinding {
  const binding = thread.workspaceBinding ?? defaultDirectWorkspaceBinding(thread, workspaceCwd, workspacePaths);
  if (binding.mode === "local") {
    return { ...binding, executionPath: workspaceCwd, status: "ready", checkedAt: now, updatedAt: now };
  }
  if (binding.mode === "external_path") {
    const executionPath = binding.executionPath ? resolvePath(binding.executionPath) : "";
    const exists = Boolean(executionPath) && existsSync(executionPath);
    return {
      ...binding,
      executionPath: executionPath || undefined,
      status: exists ? "ready" : "missing",
      errorMessage: exists ? undefined : "外部私聊工作区目录不存在。",
      checkedAt: now,
      updatedAt: now,
    };
  }
  const worktreePath = binding.worktreePath ?? directWorktreePath(workspaceCwd, thread.teammateId, thread.id, workspacePaths);
  const exists = existsSync(worktreePath);
  const hasCreatedBinding = Boolean(thread.workspaceBinding?.createdAt);
  return {
    ...binding,
    executionPath: worktreePath,
    worktreePath,
    branchName: binding.branchName ?? directWorktreeBranchName(thread.teammateId, thread.id),
    status: exists ? "ready" : hasCreatedBinding ? "missing" : "not_created",
    errorMessage: exists || !hasCreatedBinding ? undefined : "私聊工作区目录不存在。",
    checkedAt: now,
    updatedAt: now,
  };
}

function readHandoffBinding(
  value: unknown,
  thread: TeammateDirectThread,
  workspaceCwd: string,
  workspacePaths: LingStackRuntimePaths,
  now: string,
): DirectWorkspaceBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workspace handoff request must be a JSON object");
  }
  const record = value as { mode?: unknown; executionPath?: unknown };
  const mode = record.mode;
  if (mode !== "local" && mode !== "managed_worktree" && mode !== "external_path") {
    throw new Error("mode must be local, managed_worktree, or external_path");
  }
  if (mode === "local") {
    return {
      mode,
      status: "ready",
      executionPath: workspaceCwd,
      checkedAt: now,
      updatedAt: now,
    };
  }
  if (mode === "external_path") {
    if (typeof record.executionPath !== "string" || !record.executionPath.trim()) {
      throw new Error("executionPath is required for external_path");
    }
    const executionPath = resolvePath(record.executionPath);
    return {
      mode,
      status: existsSync(executionPath) ? "ready" : "missing",
      executionPath,
      errorMessage: existsSync(executionPath) ? undefined : "外部私聊工作区目录不存在。",
      checkedAt: now,
      updatedAt: now,
    };
  }
  const existing = thread.workspaceBinding;
  if (existing?.mode !== "managed_worktree" || !existing.worktreePath) {
    throw new Error("Managed worktree has not been created for this direct chat.");
  }
  return refreshDirectWorkspaceBinding({ ...thread, workspaceBinding: existing }, workspaceCwd, workspacePaths, now);
}

async function createManagedDirectWorktreeBinding(
  thread: DirectWorktreeTarget,
  workspaceCwd: string,
  workspacePaths: LingStackRuntimePaths,
  requestedBaseBranch?: string,
): Promise<
  | { readonly ok: true; readonly binding: DirectWorkspaceBinding }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const repo = await git(workspaceCwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
  if (!repo?.stdout.trim()) {
    return { ok: false, code: "not_git_repository", message: "当前工作区不是 Git 仓库，无法创建独立私聊工作区。" };
  }
  const repoRoot = repo.stdout.trim();
  const now = new Date().toISOString();
  const baseCommit = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const currentBranch = (await git(repoRoot, ["branch", "--show-current"]).catch(() => ({ stdout: "" }))).stdout.trim();
  const baseBranch = requestedBaseBranch || currentBranch || baseCommit;
  const branchName = directWorktreeBranchName(thread.teammateId, thread.id);
  const worktreePath = directWorktreePath(workspaceCwd, thread.teammateId, thread.id, workspacePaths);
  if (!existsSync(worktreePath)) {
    await mkdir(dirname(worktreePath), { recursive: true });
    try {
      await git(repoRoot, ["worktree", "add", "-B", branchName, worktreePath, baseBranch]);
    } catch (error) {
      return { ok: false, code: "worktree_create_failed", message: `创建私聊 worktree 失败：${redactGitError(error)}` };
    }
  }
  return {
    ok: true,
    binding: {
      mode: "managed_worktree",
      status: existsSync(worktreePath) ? "ready" : "missing",
      executionPath: worktreePath,
      worktreePath,
      branchName,
      baseBranch,
      baseCommit,
      createdAt: thread.workspaceBinding?.createdAt ?? now,
      checkedAt: now,
      updatedAt: now,
    },
  };
}

function directWorktreePath(
  workspaceCwd: string,
  teammateId: string,
  threadId: string,
  workspacePaths?: LingStackRuntimePaths,
): string {
  const worktreesDir = workspacePaths?.worktreesDir ?? resolvePath(workspaceCwd, ".ling-stack", "worktrees");
  return resolvePath(worktreesDir, "teammates", teammateId, threadId);
}

function directWorktreeBranchName(teammateId: string, threadId: string): string {
  return `ling/teammate-${safeBranchSegment(teammateId)}-${safeBranchSegment(threadId)}`;
}

function safeBranchSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "thread";
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const resolved = resolvePath(path);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const relation = relative(resolvePath(basePath), resolvePath(targetPath));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function git(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync("git", args, { cwd, timeout: 15000, maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

function redactGitError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\/[^\s"']+/g, "<path>");
}
