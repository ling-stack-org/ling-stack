import type { Channel } from "../types.js";

export interface FullAccessConfirmationScope {
  readonly workspaceCwd: string;
  readonly conversationId: string;
  readonly policyRevision: string;
}

export interface FullAccessPolicyRevisionInput {
  readonly defaultAuthorizationMode?: string;
  readonly defaultWorkspaceAccessMode?: string;
  readonly defaultPermissionMode?: string;
  readonly defaultPermissionPreset?: string;
  readonly approvalPolicyUpdatedAt?: string;
}

export function fullAccessConfirmationScopeKey(scope: FullAccessConfirmationScope): string {
  return JSON.stringify([
    scope.workspaceCwd.trim(),
    scope.conversationId.trim(),
    scope.policyRevision.trim(),
  ]);
}

export function fullAccessConfirmationScopeStorageId(scope: FullAccessConfirmationScope): string {
  return `scope-v1:${opaqueScopeHash(fullAccessConfirmationScopeKey(scope))}`;
}

export function fullAccessPolicyRevision(input: FullAccessPolicyRevisionInput): string {
  return JSON.stringify([
    input.defaultAuthorizationMode ?? "",
    input.defaultWorkspaceAccessMode ?? "",
    input.defaultPermissionMode ?? "",
    input.defaultPermissionPreset ?? "",
    input.approvalPolicyUpdatedAt ?? "",
  ]);
}

export function normalConversationFullAccessScope(input: {
  readonly workspaceCwd: string;
  readonly conversationIdentity: string;
  readonly policyRevision: string;
}): FullAccessConfirmationScope {
  return {
    workspaceCwd: input.workspaceCwd.trim(),
    conversationId: `conversation:${input.conversationIdentity}`,
    policyRevision: input.policyRevision,
  };
}

export function channelFullAccessScope(input: {
  readonly channel: Channel | undefined;
  readonly channelId: string;
  readonly branchId: string;
  readonly workspaceCwd: string;
  readonly policyRevision: string;
}): FullAccessConfirmationScope {
  return {
    workspaceCwd: resolveChannelFullAccessCwd(input.channel, input.workspaceCwd),
    conversationId: channelFullAccessConversationId(input.channelId, input.branchId),
    policyRevision: input.policyRevision,
  };
}

export function teammateFullAccessScope(input: {
  readonly workspaceCwd: string;
  readonly teammateId: string | undefined;
  readonly policyRevision: string;
}): FullAccessConfirmationScope {
  return {
    workspaceCwd: input.workspaceCwd.trim(),
    conversationId: `teammate:${input.teammateId ?? "none"}`,
    policyRevision: input.policyRevision,
  };
}

export function fullAccessRunScope(input: {
  readonly requestBody: unknown;
  readonly fallbackWorkspaceCwd: string;
  readonly selectedChannelId: string;
  readonly selectedChannelBranchId: string;
  readonly policyRevision: string;
}): FullAccessConfirmationScope {
  const request = readRecord(input.requestBody);
  const task = readRecord(request?.task);
  const channelId = typeof task?.channelId === "string" ? task.channelId.trim() : "";
  const taskId = typeof task?.id === "string" ? task.id.trim() : "";
  const workspaceCwd = typeof request?.cwd === "string" && request.cwd.trim()
    ? request.cwd.trim()
    : input.fallbackWorkspaceCwd.trim();
  const conversationId = channelId && channelId !== "workspace"
    ? channelFullAccessConversationId(
      channelId,
      channelId === input.selectedChannelId ? input.selectedChannelBranchId : "",
    )
    : `workspace-run:${taskId || "default"}`;
  return {
    workspaceCwd,
    conversationId,
    policyRevision: input.policyRevision,
  };
}

function resolveChannelFullAccessCwd(channel: Channel | undefined, workspaceCwd: string): string {
  if (channel?.workspaceBinding?.mode === "managed_worktree" && channel.workspaceBinding.worktreePath) {
    return channel.workspaceBinding.worktreePath.trim();
  }
  if (channel?.workspaceBinding?.mode === "external_path" && channel.workspaceBinding.executionPath) {
    return channel.workspaceBinding.executionPath.trim();
  }
  return channel?.boundPath?.trim() || workspaceCwd.trim();
}

function channelFullAccessConversationId(channelId: string, branchId: string): string {
  const normalizedChannelId = channelId.trim() || "none";
  const normalizedBranchId = branchId.trim();
  return normalizedBranchId
    ? `channel:${normalizedChannelId}:branch:${normalizedBranchId}`
    : `channel:${normalizedChannelId}:root`;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function opaqueScopeHash(value: string): string {
  let first = 0xdeadbeef ^ value.length;
  let second = 0x41c6ce57 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
