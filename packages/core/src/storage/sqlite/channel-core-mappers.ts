import type { SQLOutputValue } from "node:sqlite";
import type { RunTool } from "../../approval-policy.js";
import {
  channelBranchStatuses,
  normalizeChannelRuntimePolicy,
  type Channel,
  type ChannelBranch,
  type ChannelBranchStatus,
  type ChannelResponseLanguage,
  type ChannelRuntimePolicy,
  type ChannelStatus,
} from "../../workspace-types.js";
import {
  omitUndefined,
  parseJsonObject,
  parseJsonStringArray,
  readNullableString,
  readString,
} from "./helpers.js";
import { parseNullableChannelWorkspaceBinding } from "./workspace-binding-parsers.js";

export function mapChannel(row: Record<string, SQLOutputValue>): Channel {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    name: readString(row, "name"),
    status: readString(row, "status") as ChannelStatus,
    boundPath: readNullableString(row, "bound_path"),
    workspaceBinding: parseNullableChannelWorkspaceBinding(readNullableString(row, "workspace_binding_json")),
    defaultProviderPresetId: readNullableString(row, "default_provider_preset_id"),
    defaultTeammateId: readNullableString(row, "default_teammate_id"),
    autoReplyMode: readString(row, "auto_reply_mode") as Channel["autoReplyMode"],
    responseLanguage: parseOptionalChannelResponseLanguage(readNullableString(row, "response_language")),
    allowedTools: parseJsonStringArray(readString(row, "allowed_tools_json")) as RunTool[],
    runtimePolicy: parseChannelRuntimePolicy(readString(row, "runtime_policy_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapChannelBranch(row: Record<string, SQLOutputValue>): ChannelBranch {
  const status = readString(row, "status");
  if (!channelBranchStatuses.includes(status as ChannelBranchStatus)) {
    throw new Error(`Invalid channel branch status: ${status}`);
  }
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    name: readString(row, "name"),
    status: status as ChannelBranchStatus,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    archivedAt: readNullableString(row, "archived_at"),
    deletedAt: readNullableString(row, "deleted_at"),
  });
}

function parseChannelRuntimePolicy(value: string): ChannelRuntimePolicy {
  const parsed = parseJsonObject(value);
  return normalizeChannelRuntimePolicy({
    maxConcurrentRuns: typeof parsed.maxConcurrentRuns === "number" ? parsed.maxConcurrentRuns : undefined,
    executionMode: parsed.executionMode === "parallel" ? "parallel" : parsed.executionMode === "serial" ? "serial" : undefined,
    writeLockScope:
      parsed.writeLockScope === "channel" || parsed.writeLockScope === "boundPath" || parsed.writeLockScope === "workspace"
        ? parsed.writeLockScope
        : undefined,
    allowReadOnlyParallel: typeof parsed.allowReadOnlyParallel === "boolean" ? parsed.allowReadOnlyParallel : undefined,
    queueOnConflict: typeof parsed.queueOnConflict === "boolean" ? parsed.queueOnConflict : undefined,
  });
}

function parseOptionalChannelResponseLanguage(value: unknown): ChannelResponseLanguage | undefined {
  return value === "workspace" || value === "follow_user" || value === "zh-CN" || value === "en-US" ? value : undefined;
}
