import type { ChannelMention, ChannelMessage, ConversationActiveReplyTarget, RunIntervention, RunSession, WorkUnit } from "../../types.js";

export interface ChannelGuidanceTarget {
  readonly activeReply: ConversationActiveReplyTarget;
  readonly run?: RunSession;
  readonly label: string;
}

export function deriveChannelReplyGuidanceTargets(input: {
  readonly channelId: string;
  readonly conversationLineThreadId?: string;
  readonly channelMessages: readonly ChannelMessage[];
  readonly runs: readonly RunSession[];
  readonly workUnits: readonly WorkUnit[];
  readonly transientReplies?: readonly ConversationActiveReplyTarget[];
  readonly teammateLabel: (teammateId: string | undefined) => string;
}): readonly ChannelGuidanceTarget[] {
  if (!input.channelId) return [];

  const channelMessageById = new Map(input.channelMessages.map((message) => [message.id, message]));
  const byRunId = new Map<string, ChannelGuidanceTarget>();
  for (const reply of input.transientReplies ?? []) {
    if (!activeReplyBelongsToConversationLine(reply, input, channelMessageById)) continue;
    byRunId.set(reply.runId, {
      activeReply: reply,
      label: input.teammateLabel(reply.teammateId),
    });
  }

  const workUnitById = new Map(input.workUnits.map((workUnit) => [workUnit.id, workUnit]));
  for (const run of input.runs) {
    if (run.channelId !== input.channelId || !activeReplyStatus(run.status)) continue;
    const workUnit = run.workUnitId ? workUnitById.get(run.workUnitId) : undefined;
    if (!workUnit || workUnit.kind !== "channel_ai_reply") continue;
    const sourceMessageId = readSnapshotString(run.requestSnapshot, "sourceMessageId");
    const activeReply: ConversationActiveReplyTarget = {
      runId: run.id,
      sourceRunId: run.parentRunId ?? run.id,
      workUnitId: workUnit.id,
      channelId: run.channelId,
      threadId: run.threadId,
      ...(sourceMessageId ? { sourceMessageId } : {}),
      teammateId: run.teammateId ?? workUnit.teammateId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
    if (!activeReplyBelongsToConversationLine(activeReply, input, channelMessageById)) continue;
    byRunId.set(run.id, {
      activeReply,
      run,
      label: input.teammateLabel(run.teammateId ?? workUnit.teammateId),
    });
  }

  return [...byRunId.values()].sort((left, right) => (
    left.activeReply.createdAt.localeCompare(right.activeReply.createdAt)
  ));
}

export function resolveChannelGuidanceTarget(input: {
  readonly replyTargets: readonly ChannelGuidanceTarget[];
}): ChannelGuidanceTarget | undefined {
  return input.replyTargets[0];
}

export function resolveChannelMessageTargetTeammateId(input: {
  readonly mentions: readonly ChannelMention[];
}): string {
  const aiMentions = input.mentions.filter((mention) => mention.kind === "ai-teammate");
  if (aiMentions.length > 1) return "ling_agent";
  return normalizeLingAgentId(aiMentions[0]?.id ?? "ling_agent");
}

export function filterQueuedChannelGuidanceInterventions(
  interventions: readonly RunIntervention[],
  visibleSourceMessageIds: ReadonlySet<string>,
): readonly RunIntervention[] {
  return interventions.filter((intervention) => {
    const sourceMessageId = intervention.messagePayload?.sourceMessageId;
    return !sourceMessageId || !visibleSourceMessageIds.has(sourceMessageId);
  });
}

function activeReplyStatus(status: string): status is ConversationActiveReplyTarget["status"] {
  return status === "queued" || status === "running" || status === "waiting_for_approval";
}

function activeReplyBelongsToConversationLine(
  reply: ConversationActiveReplyTarget,
  input: {
    readonly channelId: string;
    readonly conversationLineThreadId?: string;
  },
  channelMessageById: ReadonlyMap<string, ChannelMessage>,
): boolean {
  if (reply.channelId !== input.channelId || !activeReplyStatus(reply.status) || !reply.sourceMessageId) {
    return false;
  }
  const sourceMessage = channelMessageById.get(reply.sourceMessageId);
  if (!sourceMessage || sourceMessage.channelId !== input.channelId) {
    return false;
  }
  return (sourceMessage.threadId ?? undefined) === input.conversationLineThreadId;
}

function readSnapshotString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function normalizeLingAgentId(teammateId: string | undefined): string {
  return teammateId === "ling-agent" || teammateId === "ling_agent" ? "ling_agent" : teammateId ?? "";
}
