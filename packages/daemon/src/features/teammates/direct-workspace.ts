import { isAbsolute, relative, resolve as resolvePath } from "node:path";
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
import {
  createInitialWorkspaceBinding,
  createManagedGitWorktree,
  inspectManagedWorktree,
  isWorkspaceDirectory,
  removeManagedWorktreeIfClean,
  resolveGitRepoRoot,
  safeGitBranchSegment,
  type WorkspaceBindingCreateResult,
} from "../workspaces/managed-worktrees.js";

type DirectWorktreeTarget = Pick<TeammateDirectThread, "id" | "teammateId" | "workspaceBinding">;
type DirectWorkspaceStore = RunStorePathsFacet & TeammateStoreFacet;
type DirectWorkspaceEnsureResult =
  | { readonly ok: true; readonly workspace: DirectWorkspaceReady }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly thread: TeammateDirectThread; readonly binding: DirectWorkspaceBinding };

interface DirectWorkspaceBindingFactory {
  readonly createInitial: () => Promise<WorkspaceBindingCreateResult<DirectWorkspaceBinding>>;
  readonly createManaged: () => Promise<WorkspaceBindingCreateResult<DirectWorkspaceBinding>>;
}

const directWorkspaceMutationTails = new WeakMap<DirectWorkspaceStore, Map<string, Promise<void>>>();

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
    // Lexical tokens annotate the user's text; they do not request file access.
    if (fileRef.source === "inferred_text") continue;
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
  readonly bindingFactory?: DirectWorkspaceBindingFactory;
}): Promise<DirectWorkspaceEnsureResult> {
  return await coordinateDirectWorkspaceMutation(input.store, input.thread.id, async () => {
    const currentThread = input.store.getOrCreateTeammateDirectThread(input.thread.teammateId, new Date().toISOString());
    return await ensureDirectWorkspaceReadyOnce({ ...input, thread: currentThread });
  });
}

async function coordinateDirectWorkspaceMutation<T>(
  store: DirectWorkspaceStore,
  threadId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let tails = directWorkspaceMutationTails.get(store);
  if (!tails) {
    tails = new Map();
    directWorkspaceMutationTails.set(store, tails);
  }
  const previous = tails.get(threadId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(threadId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (tails.get(threadId) === current) {
      tails.delete(threadId);
    }
    if (tails.size === 0) {
      directWorkspaceMutationTails.delete(store);
    }
  }
}

async function ensureDirectWorkspaceReadyOnce(input: {
  readonly store: DirectWorkspaceStore;
  readonly thread: TeammateDirectThread;
  readonly workspaceCwd: string;
  readonly bindingFactory?: DirectWorkspaceBindingFactory;
}): Promise<DirectWorkspaceEnsureResult> {
  const refreshed = await refreshDirectWorkspaceBinding(input.thread, input.workspaceCwd, input.store.paths, new Date().toISOString());
  if (refreshed.mode === "local" || refreshed.mode === "external_path") {
    if (refreshed.status === "ready" && isWorkspaceDirectory(refreshed.executionPath ?? input.workspaceCwd)) {
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

  if (refreshed.status === "ready" && refreshed.worktreePath && isWorkspaceDirectory(refreshed.worktreePath)) {
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

  const bindingFactory = input.bindingFactory ?? {
    createInitial: () => createInitialDirectWorkspaceBinding(input.thread, input.workspaceCwd, input.store.paths),
    createManaged: () => createManagedDirectWorktreeBinding(input.thread, input.workspaceCwd, input.store.paths),
  };
  const created = input.thread.workspaceBinding?.createdAt
    ? await bindingFactory.createManaged()
    : await bindingFactory.createInitial();
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
  action?: "create-worktree" | "handoff" | "refresh" | "cleanup",
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
      const updated = await coordinateDirectWorkspaceMutation(store, thread.id, async () => {
        const current = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
        const binding = await refreshDirectWorkspaceBinding(current, cwd, store.paths, new Date().toISOString());
        return store.updateTeammateDirectThreadWorkspace(current.id, binding, binding.updatedAt) ?? current;
      });
      writeJson(response, 200, buildDirectWorkspaceResponse(cwd, teammate.id, updated, store.paths));
      return;
    }

    if (action === "handoff" && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updated = await coordinateDirectWorkspaceMutation(store, thread.id, async () => {
        const current = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
        const binding = await readHandoffBinding(body, current, cwd, store.paths, new Date().toISOString());
        return store.updateTeammateDirectThreadWorkspace(current.id, binding, binding.updatedAt) ?? current;
      });
      writeJson(response, 200, buildDirectWorkspaceResponse(cwd, teammate.id, updated, store.paths));
      return;
    }

    if (action === "cleanup" && request.method === "POST") {
      const outcome = await coordinateDirectWorkspaceMutation(store, thread.id, async () => {
        const current = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
        const result = await cleanupManagedDirectWorktree(current, cwd, store.paths, new Date().toISOString());
        let updated = current;
        if (result.ok) {
          updated = store.updateTeammateDirectThreadWorkspace(current.id, result.binding, result.binding.updatedAt) ?? current;
        } else if (result.binding) {
          updated = store.updateTeammateDirectThreadWorkspace(current.id, result.binding, result.binding.updatedAt) ?? current;
        }
        return { result, updated };
      });
      const { result, updated } = outcome;
      if (!result.ok) {
        if (result.binding) {
          writeJson(response, result.code === "worktree_dirty" ? 409 : 400, {
            error: result.code,
            message: result.message,
            ...buildDirectWorkspaceResponse(cwd, teammate.id, updated, store.paths),
          });
          return;
        }
        writeJson(response, 400, { error: result.code, message: result.message });
        return;
      }
      writeJson(response, 200, buildDirectWorkspaceResponse(cwd, teammate.id, updated, store.paths));
      return;
    }

    if (action === "create-worktree" && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes).catch(() => ({}));
      const baseBranch = typeof body === "object" && body !== null && !Array.isArray(body) && typeof (body as { baseBranch?: unknown }).baseBranch === "string"
        ? (body as { baseBranch: string }).baseBranch.trim()
        : "";
      const outcome = await coordinateDirectWorkspaceMutation(store, thread.id, async () => {
        const current = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
        const result = await createManagedDirectWorktreeBinding(current, cwd, store.paths, baseBranch || undefined);
        const updated = result.ok
          ? store.updateTeammateDirectThreadWorkspace(current.id, result.binding, result.binding.updatedAt) ?? current
          : current;
        return { result, updated };
      });
      const { result, updated } = outcome;
      if (!result.ok) {
        writeJson(response, 400, { error: result.code, message: result.message });
        return;
      }
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

async function refreshDirectWorkspaceBinding(
  thread: TeammateDirectThread,
  workspaceCwd: string,
  workspacePaths: LingStackRuntimePaths,
  now: string,
): Promise<DirectWorkspaceBinding> {
  const binding = thread.workspaceBinding ?? defaultDirectWorkspaceBinding(thread, workspaceCwd, workspacePaths);
  if (binding.mode === "local") {
    const available = isWorkspaceDirectory(workspaceCwd);
    return {
      ...binding,
      executionPath: workspaceCwd,
      status: available ? "ready" : "missing",
      errorMessage: available ? undefined : "Local 私聊工作区目录不存在、不是目录或不可访问。",
      checkedAt: now,
      updatedAt: now,
    };
  }
  if (binding.mode === "external_path") {
    const executionPath = binding.executionPath ? resolvePath(binding.executionPath) : "";
    const exists = Boolean(executionPath) && isWorkspaceDirectory(executionPath);
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
  const inspection = await inspectManagedWorktree(worktreePath);
  const status = statusFromManagedInspection(binding, inspection);
  return {
    ...binding,
    executionPath: worktreePath,
    worktreePath,
    branchName: binding.branchName ?? directWorktreeBranchName(thread.teammateId, thread.id),
    status,
    createdAt: status === "ready" ? binding.createdAt ?? now : binding.createdAt,
    errorMessage: managedInspectionMessage(status, inspection, "私聊工作区目录不存在。"),
    checkedAt: now,
    updatedAt: now,
  };
}

async function readHandoffBinding(
  value: unknown,
  thread: TeammateDirectThread,
  workspaceCwd: string,
  workspacePaths: LingStackRuntimePaths,
  now: string,
): Promise<DirectWorkspaceBinding> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workspace handoff request must be a JSON object");
  }
  const record = value as { mode?: unknown; executionPath?: unknown };
  const mode = record.mode;
  if (mode !== "local" && mode !== "managed_worktree" && mode !== "external_path") {
    throw new Error("mode must be local, managed_worktree, or external_path");
  }
  if (mode === "local") {
    const available = isWorkspaceDirectory(workspaceCwd);
    return {
      mode,
      status: available ? "ready" : "missing",
      executionPath: workspaceCwd,
      errorMessage: available ? undefined : "Local 私聊工作区目录不存在、不是目录或不可访问。",
      checkedAt: now,
      updatedAt: now,
    };
  }
  if (mode === "external_path") {
    if (typeof record.executionPath !== "string" || !record.executionPath.trim()) {
      throw new Error("executionPath is required for external_path");
    }
    const executionPath = resolvePath(record.executionPath);
    const available = isWorkspaceDirectory(executionPath);
    return {
      mode,
      status: available ? "ready" : "missing",
      executionPath,
      errorMessage: available ? undefined : "外部私聊工作区目录不存在、不是目录或不可访问。",
      checkedAt: now,
      updatedAt: now,
    };
  }
  const existing = thread.workspaceBinding;
  if (existing?.mode !== "managed_worktree" || !existing.worktreePath) {
    throw new Error("Managed worktree has not been created for this direct chat.");
  }
  return await refreshDirectWorkspaceBinding({ ...thread, workspaceBinding: existing }, workspaceCwd, workspacePaths, now);
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
  const repo = await resolveGitRepoRoot(workspaceCwd);
  if (!repo.ok) {
    return {
      ok: false,
      code: repo.code,
      message: repo.code === "not_git_repository"
        ? "当前工作区不是 Git 仓库，无法创建独立私聊工作区。"
        : repo.message,
    };
  }
  const repoRoot = repo.repoRoot;
  const now = new Date().toISOString();
  const branchName = directWorktreeBranchName(thread.teammateId, thread.id);
  const worktreePath = directWorktreePath(workspaceCwd, thread.teammateId, thread.id, workspacePaths);
  const created = await createManagedGitWorktree({
    repoRoot,
    worktreePath,
    branchName,
    requestedBaseBranch,
  });
  if (!created.ok) {
    return { ok: false, code: created.code, message: created.message.replace("创建 worktree", "创建私聊 worktree") };
  }
  return {
    ok: true,
    binding: {
      mode: "managed_worktree",
      status: "ready",
      executionPath: worktreePath,
      worktreePath,
      branchName,
      baseBranch: created.result.baseBranch,
      baseCommit: created.result.baseCommit,
      createdAt: thread.workspaceBinding?.createdAt ?? now,
      checkedAt: now,
      updatedAt: now,
    },
  };
}

async function createInitialDirectWorkspaceBinding(
  thread: DirectWorktreeTarget,
  workspaceCwd: string,
  workspacePaths: LingStackRuntimePaths,
): Promise<WorkspaceBindingCreateResult<DirectWorkspaceBinding>> {
  return await createInitialWorkspaceBinding({
    createManaged: () => createManagedDirectWorktreeBinding(thread, workspaceCwd, workspacePaths),
    createLocal: () => {
      const now = new Date().toISOString();
      if (!isWorkspaceDirectory(workspaceCwd)) {
        return {
          ok: false,
          code: "workspace_unavailable",
          message: "当前工作区目录不存在、不是目录或不可访问，无法使用 Local 私聊工作区。",
        } as const;
      }
      return {
        ok: true,
        binding: {
          mode: "local",
          status: "ready",
          executionPath: workspaceCwd,
          createdAt: thread.workspaceBinding?.createdAt ?? now,
          checkedAt: now,
          updatedAt: now,
        } satisfies DirectWorkspaceBinding,
      } as const;
    },
  });
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
  return `ling/teammate-${safeGitBranchSegment(teammateId)}-${safeGitBranchSegment(threadId)}`;
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

async function cleanupManagedDirectWorktree(
  thread: TeammateDirectThread,
  workspaceCwd: string,
  workspacePaths: LingStackRuntimePaths,
  now: string,
): Promise<
  | { readonly ok: true; readonly binding: DirectWorkspaceBinding }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly binding?: DirectWorkspaceBinding }
> {
  const binding = thread.workspaceBinding ?? defaultDirectWorkspaceBinding(thread, workspaceCwd, workspacePaths);
  if (binding.mode !== "managed_worktree" || !binding.worktreePath) {
    return { ok: false, code: "workspace_not_managed", message: "私聊工作区不是 Ling 管理的 worktree，无法清理。" };
  }
  const repo = await resolveGitRepoRoot(workspaceCwd);
  if (!repo.ok) {
    return { ok: false, code: repo.code, message: repo.message };
  }
  const cleanup = await removeManagedWorktreeIfClean({
    repoRoot: repo.repoRoot,
    worktreePath: binding.worktreePath,
  });
  if (!cleanup.ok) {
    const status = statusFromManagedInspection(binding, cleanup.inspection);
    return {
      ok: false,
      code: cleanup.code,
      message: cleanup.message,
      binding: {
        ...binding,
        executionPath: binding.worktreePath,
        status,
        errorMessage: managedInspectionMessage(status, cleanup.inspection, cleanup.message),
        checkedAt: now,
        updatedAt: now,
      },
    };
  }
  return {
    ok: true,
    binding: {
      ...binding,
      executionPath: binding.worktreePath,
      status: "not_created",
      errorMessage: undefined,
      checkedAt: now,
      updatedAt: now,
    },
  };
}

function statusFromManagedInspection(binding: DirectWorkspaceBinding, inspection: { readonly status: "ready" | "missing" | "blocked" }): DirectWorkspaceBinding["status"] {
  if (inspection.status === "ready") {
    return "ready";
  }
  if (inspection.status === "blocked") {
    return "blocked";
  }
  return binding.status === "not_created" || !binding.createdAt ? "not_created" : "missing";
}

function managedInspectionMessage(
  status: DirectWorkspaceBinding["status"],
  inspection: { readonly errorMessage?: string },
  fallback: string,
): string | undefined {
  if (status === "ready" || status === "not_created") {
    return undefined;
  }
  return inspection.errorMessage ?? fallback;
}
