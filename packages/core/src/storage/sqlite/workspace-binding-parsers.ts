import {
  type ChannelWorkspaceBinding,
  type DirectWorkspaceBinding,
} from "../../workspace-types.js";
import { omitUndefined, parseJsonObject } from "./helpers.js";

export function parseNullableChannelWorkspaceBinding(value: string | undefined): ChannelWorkspaceBinding | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJsonObject(value);
  return normalizeChannelWorkspaceBinding(parsed);
}

export function parseNullableDirectWorkspaceBinding(value: string | undefined): DirectWorkspaceBinding | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJsonObject(value);
  return normalizeChannelWorkspaceBinding(parsed) as DirectWorkspaceBinding | undefined;
}

function normalizeChannelWorkspaceBinding(value: Record<string, unknown>): ChannelWorkspaceBinding | undefined {
  const mode = value.mode;
  if (mode !== "local" && mode !== "managed_worktree" && mode !== "external_path") {
    return undefined;
  }
  const normalizedMode: ChannelWorkspaceBinding["mode"] = mode;
  const status = value.status;
  const normalizedStatus: ChannelWorkspaceBinding["status"] =
    status === "ready" || status === "not_created" || status === "missing" || status === "unsupported" || status === "blocked"
      ? status
      : normalizedMode === "local" || normalizedMode === "external_path" ? "ready" : "not_created";
  return omitUndefined({
    mode: normalizedMode,
    status: normalizedStatus,
    executionPath: typeof value.executionPath === "string" && value.executionPath.trim() ? value.executionPath : undefined,
    worktreePath: typeof value.worktreePath === "string" && value.worktreePath.trim() ? value.worktreePath : undefined,
    branchName: typeof value.branchName === "string" && value.branchName.trim() ? value.branchName : undefined,
    baseBranch: typeof value.baseBranch === "string" && value.baseBranch.trim() ? value.baseBranch : undefined,
    baseCommit: typeof value.baseCommit === "string" && value.baseCommit.trim() ? value.baseCommit : undefined,
    errorMessage: typeof value.errorMessage === "string" && value.errorMessage.trim() ? value.errorMessage : undefined,
    createdAt: typeof value.createdAt === "string" && value.createdAt.trim() ? value.createdAt : undefined,
    checkedAt: typeof value.checkedAt === "string" && value.checkedAt.trim() ? value.checkedAt : undefined,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt : new Date().toISOString(),
  });
}
