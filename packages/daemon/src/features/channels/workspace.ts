import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createChannelWorkspaceSnapshot,
  resolveChannelExecutionCwd,
  type Channel,
  type ChannelWorkspaceBinding,
  type LingStackRuntimePaths,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { buildUnavailableWorkspaceGitStatus, inspectWorkspaceGitStatus } from "./git-status.js";
import {
  createManagedGitWorktree,
  inspectManagedWorktree,
  removeManagedWorktreeIfClean,
  resolveGitRepoRoot,
} from "../workspaces/managed-worktrees.js";

type ChannelWorktreeTarget = Pick<Channel, "id" | "boundPath" | "workspaceBinding">;

export function defaultChannelWorkspaceBinding(channel: Channel, workspaceCwd: string): ChannelWorkspaceBinding {
  return {
    mode: "local",
    status: "ready",
    executionPath: channel.boundPath ?? workspaceCwd,
    updatedAt: channel.updatedAt,
  };
}

export function assertChannelWorkspaceReady(channel: Channel, workspaceCwd: string): { readonly ok: true; readonly executionCwd: string } | { readonly ok: false; readonly message: string } {
  const binding = channel.workspaceBinding;
  const executionCwd = resolveChannelExecutionCwd(channel, workspaceCwd);
  if (!binding || binding.mode === "local") {
    return { ok: true, executionCwd };
  }
  if (binding.status !== "ready") {
    return { ok: false, message: "频道工作区不可用，请恢复工作区或切回 Local。" };
  }
  if (!existsSync(executionCwd)) {
    return { ok: false, message: "频道工作区目录不存在，请刷新状态、恢复工作区或切回 Local。" };
  }
  return { ok: true, executionCwd };
}

export async function handleChannelWorkspace(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  action?: "create-worktree" | "handoff" | "refresh" | "cleanup" | "git-status",
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (!action && request.method === "GET") {
      writeJson(response, 200, buildChannelWorkspaceResponse(cwd, channel));
      return;
    }

    if (action === "git-status" && request.method === "GET") {
      const binding = channel.workspaceBinding ?? defaultChannelWorkspaceBinding(channel, cwd);
      const channelWithBinding = { ...channel, workspaceBinding: binding };
      const snapshot = createChannelWorkspaceSnapshot(channelWithBinding, cwd);
      const ready = assertChannelWorkspaceReady(channelWithBinding, cwd);
      const checkedAt = new Date().toISOString();
      const gitStatus = ready.ok
        ? await inspectWorkspaceGitStatus(ready.executionCwd, checkedAt)
        : buildUnavailableWorkspaceGitStatus(snapshot.executionCwd, checkedAt, ready.message);
      writeJson(response, 200, {
        cwd,
        channelId: channel.id,
        binding,
        snapshot,
        gitStatus,
      });
      return;
    }

    if (action === "refresh" && request.method === "POST") {
      const binding = await refreshChannelWorkspaceBinding(channel, cwd, new Date().toISOString());
      const updated = store.updateChannel(channelId, { workspaceBinding: binding }, binding.updatedAt) ?? channel;
      writeJson(response, 200, buildChannelWorkspaceResponse(cwd, updated));
      return;
    }

    if (action === "handoff" && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const binding = await readHandoffBinding(body, channel, cwd, new Date().toISOString());
      const updated = store.updateChannel(channelId, { workspaceBinding: binding }, binding.updatedAt) ?? channel;
      writeJson(response, 200, buildChannelWorkspaceResponse(cwd, updated));
      return;
    }

    if (action === "cleanup" && request.method === "POST") {
      const result = await cleanupManagedChannelWorktree(channel, cwd, new Date().toISOString());
      if (!result.ok) {
        if (result.binding) {
          const updated = store.updateChannel(channelId, { workspaceBinding: result.binding }, result.binding.updatedAt) ?? channel;
          writeJson(response, result.code === "worktree_dirty" ? 409 : 400, {
            error: result.code,
            message: result.message,
            ...buildChannelWorkspaceResponse(cwd, updated),
          });
          return;
        }
        writeJson(response, 400, { error: result.code, message: result.message });
        return;
      }
      const updated = store.updateChannel(channelId, { workspaceBinding: result.binding }, result.binding.updatedAt) ?? channel;
      writeJson(response, 200, buildChannelWorkspaceResponse(cwd, updated));
      return;
    }

    if (action === "create-worktree" && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes).catch(() => ({}));
      const baseBranch = typeof body === "object" && body !== null && !Array.isArray(body) && typeof (body as { baseBranch?: unknown }).baseBranch === "string"
        ? (body as { baseBranch: string }).baseBranch.trim()
        : "";
      const result = await createManagedWorktreeBinding(channel, cwd, store.paths, baseBranch || undefined);
      if (!result.ok) {
        writeJson(response, 400, { error: result.code, message: result.message });
        return;
      }
      const updated = store.updateChannel(channelId, { workspaceBinding: result.binding }, result.binding.updatedAt) ?? channel;
      writeJson(response, 200, buildChannelWorkspaceResponse(cwd, updated));
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel workspace` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildChannelWorkspaceResponse(cwd: string, channel: Channel) {
  const binding = channel.workspaceBinding ?? defaultChannelWorkspaceBinding(channel, cwd);
  return {
    cwd,
    channelId: channel.id,
    binding,
    snapshot: createChannelWorkspaceSnapshot({ ...channel, workspaceBinding: binding }, cwd),
  };
}

async function refreshChannelWorkspaceBinding(channel: Channel, workspaceCwd: string, now: string): Promise<ChannelWorkspaceBinding> {
  const binding = channel.workspaceBinding ?? defaultChannelWorkspaceBinding(channel, workspaceCwd);
  const executionPath = resolveChannelExecutionCwd({ ...channel, workspaceBinding: binding }, workspaceCwd);
  if (binding.mode === "local") {
    return { ...binding, executionPath, status: "ready", checkedAt: now, updatedAt: now };
  }
  if (binding.mode === "external_path") {
    const exists = existsSync(executionPath);
    return {
      ...binding,
      executionPath,
      status: exists ? "ready" : "missing",
      errorMessage: exists ? undefined : "频道工作区目录不存在。",
      checkedAt: now,
      updatedAt: now,
    };
  }
  if (!binding.worktreePath) {
    return {
      ...binding,
      executionPath: undefined,
      status: "not_created",
      errorMessage: undefined,
      checkedAt: now,
      updatedAt: now,
    };
  }
  const inspection = await inspectManagedWorktree(binding.worktreePath);
  const status = statusFromManagedInspection(binding, inspection);
  return {
    ...binding,
    executionPath: binding.worktreePath,
    status,
    errorMessage: managedInspectionMessage(status, inspection, "频道工作区目录不存在。"),
    checkedAt: now,
    updatedAt: now,
  };
}

async function readHandoffBinding(value: unknown, channel: Channel, workspaceCwd: string, now: string): Promise<ChannelWorkspaceBinding> {
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
      executionPath: channel.boundPath ?? workspaceCwd,
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
      errorMessage: existsSync(executionPath) ? undefined : "外部工作区目录不存在。",
      checkedAt: now,
      updatedAt: now,
    };
  }
  const existing = channel.workspaceBinding;
  if (existing?.mode !== "managed_worktree" || !existing.worktreePath) {
    throw new Error("Managed worktree has not been created for this channel.");
  }
  return await refreshChannelWorkspaceBinding({ ...channel, workspaceBinding: existing }, workspaceCwd, now);
}

export async function createManagedWorktreeBinding(
  channel: ChannelWorktreeTarget,
  workspaceCwd: string,
  workspacePaths: LingStackRuntimePaths,
  requestedBaseBranch?: string,
): Promise<
  | { readonly ok: true; readonly binding: ChannelWorkspaceBinding }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const root = channel.boundPath ?? workspaceCwd;
  const repo = await resolveGitRepoRoot(root);
  if (!repo.ok) {
    return { ok: false, code: "not_git_repository", message: "当前工作区不是 Git 仓库，无法创建独立频道工作区。" };
  }
  const repoRoot = repo.repoRoot;
  const now = new Date().toISOString();
  const branchName = `ling/channel-${channel.id}`;
  const worktreePath = resolvePath(workspacePaths.worktreesDir, "channels", channel.id);
  const created = await createManagedGitWorktree({
    repoRoot,
    worktreePath,
    branchName,
    requestedBaseBranch,
  });
  if (!created.ok) {
    return { ok: false, code: created.code, message: created.message.replace("创建 worktree", "创建频道 worktree") };
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
      createdAt: channel.workspaceBinding?.createdAt ?? now,
      checkedAt: now,
      updatedAt: now,
    },
  };
}

export async function createInitialChannelWorkspaceBinding(
  channel: ChannelWorktreeTarget,
  workspaceCwd: string,
  workspacePaths: LingStackRuntimePaths,
): Promise<
  | { readonly ok: true; readonly binding: ChannelWorkspaceBinding }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const managed = await createManagedWorktreeBinding(channel, workspaceCwd, workspacePaths);
  if (managed.ok || managed.code !== "not_git_repository") {
    return managed;
  }
  const now = new Date().toISOString();
  return {
    ok: true,
    binding: {
      mode: "local",
      status: "ready",
      executionPath: channel.boundPath ?? workspaceCwd,
      createdAt: channel.workspaceBinding?.createdAt ?? now,
      checkedAt: now,
      updatedAt: now,
    },
  };
}

async function cleanupManagedChannelWorktree(
  channel: Channel,
  workspaceCwd: string,
  now: string,
): Promise<
  | { readonly ok: true; readonly binding: ChannelWorkspaceBinding }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly binding?: ChannelWorkspaceBinding }
> {
  const binding = channel.workspaceBinding;
  if (binding?.mode !== "managed_worktree" || !binding.worktreePath) {
    return { ok: false, code: "workspace_not_managed", message: "频道工作区不是 Ling 管理的 worktree，无法清理。" };
  }
  const repo = await resolveGitRepoRoot(channel.boundPath ?? workspaceCwd);
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

function statusFromManagedInspection(binding: ChannelWorkspaceBinding, inspection: { readonly status: "ready" | "missing" | "blocked" }): ChannelWorkspaceBinding["status"] {
  if (inspection.status === "ready") {
    return "ready";
  }
  if (inspection.status === "blocked") {
    return "blocked";
  }
  return binding.status === "not_created" || !binding.createdAt ? "not_created" : "missing";
}

function managedInspectionMessage(
  status: ChannelWorkspaceBinding["status"],
  inspection: { readonly errorMessage?: string },
  fallback: string,
): string | undefined {
  if (status === "ready" || status === "not_created") {
    return undefined;
  }
  return inspection.errorMessage ?? fallback;
}
