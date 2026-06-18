import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

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
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (!action && request.method === "GET") {
      writeJson(response, 200, buildChannelWorkspaceResponse(cwd, channel));
      return;
    }

    if (action === "refresh" && request.method === "POST") {
      const binding = refreshChannelWorkspaceBinding(channel, cwd, new Date().toISOString());
      const updated = store.updateChannel(channelId, { workspaceBinding: binding }, binding.updatedAt) ?? channel;
      writeJson(response, 200, buildChannelWorkspaceResponse(cwd, updated));
      return;
    }

    if (action === "handoff" && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const binding = readHandoffBinding(body, channel, cwd, new Date().toISOString());
      const updated = store.updateChannel(channelId, { workspaceBinding: binding }, binding.updatedAt) ?? channel;
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

function refreshChannelWorkspaceBinding(channel: Channel, workspaceCwd: string, now: string): ChannelWorkspaceBinding {
  const binding = channel.workspaceBinding ?? defaultChannelWorkspaceBinding(channel, workspaceCwd);
  const executionPath = resolveChannelExecutionCwd({ ...channel, workspaceBinding: binding }, workspaceCwd);
  if (binding.mode === "local") {
    return { ...binding, executionPath, status: "ready", checkedAt: now, updatedAt: now };
  }
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

function readHandoffBinding(value: unknown, channel: Channel, workspaceCwd: string, now: string): ChannelWorkspaceBinding {
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
  return refreshChannelWorkspaceBinding({ ...channel, workspaceBinding: existing }, workspaceCwd, now);
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
  const repo = await git(root, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
  if (!repo?.stdout.trim()) {
    return { ok: false, code: "not_git_repository", message: "当前工作区不是 Git 仓库，无法创建独立频道工作区。" };
  }
  const repoRoot = repo.stdout.trim();
  const now = new Date().toISOString();
  const baseCommit = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const currentBranch = (await git(repoRoot, ["branch", "--show-current"]).catch(() => ({ stdout: "" }))).stdout.trim();
  const baseBranch = requestedBaseBranch || currentBranch || baseCommit;
  const branchName = `ling/channel-${channel.id}`;
  const worktreePath = resolvePath(workspacePaths.worktreesDir, "channels", channel.id);
  if (!existsSync(worktreePath)) {
    await mkdir(dirname(worktreePath), { recursive: true });
    await git(repoRoot, ["worktree", "add", "-B", branchName, worktreePath, baseBranch]).catch((error: unknown) => {
      throw new Error(`创建频道 worktree 失败：${redactGitError(error)}`);
    });
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
      createdAt: channel.workspaceBinding?.createdAt ?? now,
      checkedAt: now,
      updatedAt: now,
    },
  };
}

async function git(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync("git", args, { cwd, timeout: 15000, maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

function redactGitError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\/[^\s"']+/g, "<path>");
}
