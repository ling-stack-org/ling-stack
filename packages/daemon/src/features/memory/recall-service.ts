import { randomUUID } from "node:crypto";
import { getMemorySemanticService } from "./semantic-registry.js";
import {
  DEFAULT_WORKSPACE_ID, LING_AGENT_ID, isLingAgentTeammateId, createBuiltinAiTeammateId,
  classifyWorkflowStepStartOwner, workflowStepStartAuthorityBasis,
  type MemoryRecallRequest, type MemoryRecallResult, type RunStore,
} from "@ling-stack/core";
import { resolveWorkflowParticipantRunProfile } from "../channels/workflow-participant-run-profile.js";

export type MemoryRecallStore = RunStore;

/** Host call-site evidence only; this is never accepted by the public recall request parser. */
export interface MemoryRecallHostContext { readonly workflowStepId: string }

/** Resolve automatic context from durable owners, never grant an owner merely because the request names it. */
export function resolveAutomaticMemoryRecallScope(
  store: MemoryRecallStore, input: MemoryRecallRequest, host?: MemoryRecallHostContext,
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
  const workflowAuthority = host ? hasWorkflowRecallAuthority(store, input, host, workspaceId, channel?.id, teammate?.id) : false;
  if (host && !workflowAuthority) return undefined;
  if (channel && teammate && !systemAgent && !workflowAuthority && !store.listTeammateChannelMemberships(teammate.id)
    .some(membership => membership.channelId === channel.id)) return undefined;
  return { ...input, workspaceId, teammateId: teammate?.id ?? (systemAgent ? LING_AGENT_ID : undefined),
    channelId: channel?.id, taskId: task?.id, runId: run?.id,
    includeDisabled: false, includePrivate: false, includeSecretAdjacent: false };
}

function hasWorkflowRecallAuthority(store: RunStore, input: MemoryRecallRequest, host: MemoryRecallHostContext,
  workspaceId: string, channelId: string | undefined, teammateId: string | undefined): boolean {
  if (input.intent !== "task-run" || !channelId || !teammateId) return false;
  const step = store.getChannelWorkflowStep(host.workflowStepId);
  const workflow = step ? store.getChannelWorkflow(step.workflowId) : undefined;
  const channel = store.getChannel(channelId);
  if (!step || !workflow || !channel || step.workspaceId !== workspaceId || workflow.workspaceId !== workspaceId ||
    step.channelId !== channel.id || workflow.channelId !== channel.id || step.toParticipantId !== teammateId ||
    !workflowStepStartAuthorityBasis(store, step)) return false;
  const profile = resolveWorkflowParticipantRunProfile({ store, channel, step, requestedAssigneeTeammateId: teammateId,
    requiredTools: step.metadata?.requiredTools ?? [] });
  if (profile.kind !== "ready" || profile.teammateId !== teammateId) return false;
  if (input.taskId || input.runId) {
    // A caller-supplied step id cannot turn an unrelated/new task into a workflow owner.
    const task = input.taskId ? store.getTask(input.taskId) : undefined;
    if (!task || step.taskId !== task.id || task.channelId !== channel.id || task.assigneeTeammateId !== teammateId) return false;
    const owner = classifyWorkflowStepStartOwner(store, step, new Date().toISOString(),
      { requireActiveLease: false, allowWaitingForInput: true });
    if (owner.status === "invalid" || owner.owner.taskId !== task.id) return false;
    if (input.runId) {
      const run = store.getRun(input.runId);
      if (!run || step.runId !== run.id || run.workflowStepId !== step.id || run.taskId !== task.id) return false;
    }
    return true;
  }
  // Preparation precedes task creation, including retry and an approved pre-start gate.
  return ["draft", "ready", "running", "blocked"].includes(workflow.status) &&
    ["queued", "blocked", "claimed", "running"].includes(step.status) &&
    !step.taskId && !step.runId && !step.metadata?.startOwner;
}

/** Async boundary shared by all callers; optional providers belong here, outside synchronous SQLite stores. */
export async function recallMemory(
  store: MemoryRecallStore, input: MemoryRecallRequest, host?: MemoryRecallHostContext,
): Promise<MemoryRecallResult> {
  // Search/review are explicit local management operations, with their existing inspection semantics.
  let resolved = input.intent === "search" || input.intent === "review" ? input : resolveAutomaticMemoryRecallScope(store, input, host);
  let result: MemoryRecallResult = resolved ? store.recallMemory(resolved) : { request: input, memories: [], policyVersion: "ling-memory-scope-v1",
    audit: { strategy: "scan", candidateCount: 0, selectedMemoryIds: [], scopeRejected: true } };
  const semantic = resolved ? getMemorySemanticService(store) : undefined;
  if (resolved && semantic && semantic.status().status !== "not_configured") {
    const matches = await semantic.search(resolved);
    // Re-resolve ownership AND lexical content after asynchronous provider work.
    const current = input.intent === "search" || input.intent === "review" ? input : resolveAutomaticMemoryRecallScope(store, input, host);
    resolved = current;
    result = current ? store.recallMemory(current) : recallMemoryWithoutSource(input);
    if (current && matches.length > 0) {
      const ranked = new Map<string, { item: MemoryRecallResult["memories"][number]; rank: number }>();
      const currentMatches = semantic.revalidate(current, matches);
      for (const list of [result.memories, currentMatches]) list.forEach((item, index) => {
        const existing = ranked.get(item.memory.id);
        ranked.set(item.memory.id, { item: existing?.item ?? item, rank: (existing?.rank ?? 0) + 1 / (60 + index + 1) });
      });
      const limit = Math.max(1, Math.min(20, Math.trunc(input.maxResults ?? 8)));
      const memories = [...ranked.values()].sort((a, b) => {
        // Exact ids/tags retain priority; incomparable raw provider scores are never added.
        const exact = (item: typeof a) => item.item.memory.id.toLowerCase() === input.query.toLowerCase().trim() ||
          item.item.memory.tags.some(tag => tag.toLowerCase() === input.query.toLowerCase().trim());
        return Number(exact(b)) - Number(exact(a)) || b.rank - a.rank || a.item.memory.id.localeCompare(b.item.memory.id);
      }).slice(0, limit).map(value => value.item);
      result = { ...result, memories, policyVersion: `${result.policyVersion}+rrf-v1`,
        audit: result.audit ? { ...result.audit, selectedMemoryIds: memories.map(item => item.memory.id) } : undefined };
    }
    if (result.audit) result = { ...result, audit: { ...result.audit, semanticCandidateCount: current ? matches.length : 0,
      semanticStatus: semantic.status().status } };
  }
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

function recallMemoryWithoutSource(input: MemoryRecallRequest): MemoryRecallResult {
  return { request: input, memories: [], policyVersion: "ling-memory-scope-v1",
    audit: { strategy: "scan", candidateCount: 0, selectedMemoryIds: [], scopeRejected: true } };
}
