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
  readonly threadId?: string;
  /** The creation idempotency key, never a reusable channel-wide draft ID. */
  readonly draftId?: string;
  readonly workspaceCwd: string;
  readonly policyRevision: string;
}): FullAccessConfirmationScope {
  return {
    workspaceCwd: resolveChannelFullAccessCwd(input.channel, input.workspaceCwd),
    conversationId: channelFullAccessConversationId(input),
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
  const threadId = typeof request?.threadId === "string" ? request.threadId.trim() : "";
  const conversationId = channelId && channelId !== "workspace"
    ? threadId
      ? channelFullAccessConversationId({ workspaceCwd: input.fallbackWorkspaceCwd, channelId, threadId, branchId: "" })
      // Unowned legacy work must not borrow the currently selected conversation's grant.
      : `channel-work-v2:${JSON.stringify([input.fallbackWorkspaceCwd.trim(), channelId, taskId || "unowned"])}`
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

function channelFullAccessConversationId(input: {
  readonly workspaceCwd: string;
  readonly channelId: string;
  readonly branchId: string;
  readonly threadId?: string;
  readonly draftId?: string;
}): string {
  const owner = [input.workspaceCwd.trim(), input.channelId.trim() || "none"];
  if (input.threadId?.trim()) return `channel-thread-v2:${JSON.stringify([...owner, input.threadId.trim()])}`;
  if (input.draftId?.trim()) return `channel-draft-v2:${JSON.stringify([...owner, input.draftId.trim()])}`;
  // During legacy navigation resolution this cannot match a canonical thread or an old v1 grant.
  return `channel-unresolved-v2:${JSON.stringify([...owner, input.branchId.trim()])}`;
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
