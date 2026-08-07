import type { ChannelMention, ConversationActiveReplyTarget, RunIntervention, RunSession, WorkUnit } from "../../types.js";

export interface ChannelGuidanceTarget {
  readonly activeReply: ConversationActiveReplyTarget;
  readonly run?: RunSession;
  readonly label: string;
}

export function deriveChannelReplyGuidanceTargets(input: {
  readonly channelId: string;
  readonly runs: readonly RunSession[];
  readonly workUnits: readonly WorkUnit[];
  readonly transientReplies?: readonly ConversationActiveReplyTarget[];
  readonly teammateLabel: (teammateId: string | undefined) => string;
}): readonly ChannelGuidanceTarget[] {
  if (!input.channelId) return [];

  const byRunId = new Map<string, ChannelGuidanceTarget>();
  for (const reply of input.transientReplies ?? []) {
    if (reply.channelId !== input.channelId || !activeReplyStatus(reply.status)) continue;
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
    byRunId.set(run.id, {
      activeReply: {
        runId: run.id,
        sourceRunId: run.parentRunId ?? run.id,
        workUnitId: workUnit.id,
        channelId: run.channelId,
        threadId: run.threadId,
        teammateId: run.teammateId ?? workUnit.teammateId,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      },
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
  readonly fallbackRun?: RunSession;
  readonly teammateLabel: (teammateId: string | undefined) => string;
}): ChannelGuidanceTarget | undefined {
  const selectedTarget = input.replyTargets[0];
  if (selectedTarget) return selectedTarget;
  if (
    !input.fallbackRun ||
    !activeReplyStatus(input.fallbackRun.status)
  ) return undefined;
  return {
    activeReply: {
      runId: input.fallbackRun.id,
      sourceRunId: input.fallbackRun.parentRunId ?? input.fallbackRun.id,
      workUnitId: input.fallbackRun.workUnitId,
      channelId: input.fallbackRun.channelId,
      threadId: input.fallbackRun.threadId,
      teammateId: input.fallbackRun.teammateId ?? "ling_agent",
      status: input.fallbackRun.status,
      createdAt: input.fallbackRun.createdAt,
      updatedAt: input.fallbackRun.updatedAt,
    },
    run: input.fallbackRun,
    label: input.teammateLabel(input.fallbackRun.teammateId),
  };
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

function normalizeLingAgentId(teammateId: string | undefined): string {
  return teammateId === "ling-agent" || teammateId === "ling_agent" ? "ling_agent" : teammateId ?? "";
}
