import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID, LING_AGENT_ID, isLingAgentTeammateId, createBuiltinAiTeammateId,
  type MemoryRecallRequest, type MemoryRecallResult, type RunStore,
} from "@ling-stack/core";

export type MemoryRecallStore = Pick<RunStore, "recallMemory" | "getAiTeammate" | "getChannel" |
  "getTask" | "getRun" | "listTeammateChannelMemberships"> & Partial<Pick<RunStore, "getLingTurnForRun" | "getLingThread" | "appendControlPlaneEvent" | "paths">>;

/** Resolve automatic context from durable owners, never grant an owner merely because the request names it. */
export function resolveAutomaticMemoryRecallScope(
  store: MemoryRecallStore, input: MemoryRecallRequest,
): MemoryRecallRequest | undefined {
  const run = input.runId ? store.getRun(input.runId) : undefined;
  if (input.runId && (!run || (input.taskId && input.taskId !== run.taskId) ||
    (input.channelId && input.channelId !== run.channelId) ||
    (input.teammateId && input.teammateId !== run.teammateId && !isLingAgentTeammateId(input.teammateId)))) return undefined;
  // A durable Run supplies missing lineage. Explicit conflicting owners never widen access.
  if (run) input = { ...input, taskId: input.taskId ?? run.taskId, channelId: input.channelId ?? run.channelId,
    teammateId: input.teammateId ?? run.teammateId };
  const teammate = input.teammateId ? store.getAiTeammate(input.teammateId)
    ?? store.getAiTeammate(createBuiltinAiTeammateId(input.teammateId)) : undefined;
  const systemAgent = isLingAgentTeammateId(input.teammateId);
  if (input.teammateId && !teammate && !systemAgent) return undefined;
  if (teammate?.status === "disabled") return undefined;
  const channel = input.channelId ? store.getChannel(input.channelId) : undefined;
  if (input.channelId && (!channel || channel.status === "archived")) return undefined;
  const workspaceId = channel?.workspaceId ?? teammate?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if ((input.workspaceId && input.workspaceId !== workspaceId) || (teammate && teammate.workspaceId !== workspaceId)) return undefined;
  if (channel && teammate && !systemAgent && !store.listTeammateChannelMemberships(teammate.id)
    .some(membership => membership.channelId === channel.id)) return undefined;

  // New task requests may not have been persisted yet. They get shared context, never an unverified task owner.
  const task = input.taskId ? store.getTask(input.taskId) : undefined;
  if (task && (task.workspaceId !== workspaceId || task.channelId !== channel?.id ||
    (task.assigneeTeammateId && task.assigneeTeammateId !== teammate?.id && !systemAgent))) return undefined;
  const turn = run && !task ? store.getLingTurnForRun?.(run.id) : undefined;
  const thread = turn ? store.getLingThread?.(turn.threadId) : undefined;
  const durableConversation = Boolean(run && turn && thread && thread.status !== "archived" &&
    run.threadId === thread.id && turn.workspaceId === workspaceId && thread.workspaceId === workspaceId &&
    turn.channelId === channel?.id && thread.channelId === channel?.id &&
    (channel ? (!turn.teammateId || turn.teammateId === run.teammateId) &&
      (!thread.teammateId || thread.teammateId === run.teammateId) :
      turn.teammateId === run.teammateId && thread.teammateId === run.teammateId) &&
    (!turn.taskId || turn.taskId === run.taskId));
  if (input.runId && (!run || (!task && !durableConversation) || (task && run.taskId !== task.id) || run.channelId !== channel?.id ||
    run.teammateId !== (teammate?.id ?? (systemAgent ? LING_AGENT_ID : undefined)))) return undefined;
  return { ...input, workspaceId, teammateId: teammate?.id ?? (systemAgent ? LING_AGENT_ID : undefined),
    channelId: channel?.id, taskId: task?.id, runId: run?.id,
    includeDisabled: false, includePrivate: false, includeSecretAdjacent: false };
}

/** Async boundary shared by all callers; optional providers belong here, outside synchronous SQLite stores. */
export async function recallMemory(
  store: MemoryRecallStore, input: MemoryRecallRequest,
): Promise<MemoryRecallResult> {
  // Search/review are explicit local management operations, with their existing inspection semantics.
  const resolved = input.intent === "search" || input.intent === "review" ? input : resolveAutomaticMemoryRecallScope(store, input);
  const result: MemoryRecallResult = resolved ? store.recallMemory(resolved) : { request: input, memories: [], policyVersion: "ling-memory-scope-v1",
    audit: { strategy: "scan", candidateCount: 0, selectedMemoryIds: [], scopeRejected: true } };
  if (!store.appendControlPlaneEvent || !store.paths || !result.audit) return result;
  const traceId = `memory_recall_${randomUUID()}`;
  // Query text, excluded IDs and source content never enter the scope-selection audit.
  // UsedMemoryEvent remains the separate durable record of context actually supplied.
  store.appendControlPlaneEvent({ workspaceId: resolved?.workspaceId ?? DEFAULT_WORKSPACE_ID, cwd: store.paths.cwd,
    domain: "memory", entityType: "memory", entityId: traceId, action: "memory.recall_selected",
    data: { ...result.audit, intent: input.intent, ...(resolved ? { runId: resolved.runId,
      taskId: resolved.taskId, teammateId: resolved.teammateId, channelId: resolved.channelId } : {}) } }, new Date().toISOString());
  return { ...result, audit: { ...result.audit, traceId } };
}
