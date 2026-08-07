import type { ChannelMessage, RunIntervention, RunSession, RunStore } from "@ling-stack/core";
import { buildChannelReplyContextPack, renderContextPack } from "./context-packs.js";
import { resolveChannelReplyExecutionTarget } from "./channel-reply-execution-target.js";
import { buildLingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";
import { resolveChannelResponseLanguage, responseLanguageInstruction } from "./response-language.js";

export interface ChannelReplyContinuationContext {
  readonly title: string;
  readonly prompt: string;
  readonly systemPromptInstruction: string;
  readonly targetTeammateId: string;
  readonly providerPresetId: string;
  readonly runnerId?: string;
}

export function buildChannelReplyContinuationContext(input: {
  readonly store: RunStore;
  readonly sourceRun: RunSession;
  readonly intervention: RunIntervention;
  readonly sourceMessageId: string;
}): ChannelReplyContinuationContext {
  const channelId = input.sourceRun.channelId;
  if (!channelId) {
    throw new Error(`Channel continuation source run has no channel: ${input.sourceRun.id}`);
  }
  const channel = input.store.getChannel(channelId);
  if (!channel) {
    throw new Error(`Channel continuation channel was not found: ${channelId}`);
  }
  const sourceMessage = input.store.getChannelMessage(input.sourceMessageId);
  if (
    !sourceMessage ||
    sourceMessage.channelId !== channel.id ||
    sourceMessage.authorType !== "local-user" ||
    sourceMessage.kind !== "message"
  ) {
    throw new Error(`Channel guidance source message is invalid: ${input.sourceMessageId}`);
  }

  const target = resolveChannelReplyExecutionTarget({
    store: input.store,
    channel,
    requestedTeammateId: input.intervention.messagePayload?.targetTeammateId ?? input.sourceRun.teammateId,
    now: input.intervention.createdAt,
  });
  if (target.teammate && target.teammate.status !== "active") {
    throw new Error(`AI teammate is ${target.teammate.status}: ${target.teammateId}`);
  }
  if (!target.providerPresetId) {
    throw new Error(`AI teammate is not configured for this channel: ${target.teammateId}`);
  }
  const turnEnvelope = buildLingAgentTurnEnvelope({
    store: input.store,
    channel,
    sourceMessage,
  });
  const contextPack = buildChannelReplyContextPack({
    store: input.store,
    channel,
    sourceMessage,
    turnEnvelope,
    providerPresetId: target.providerPresetId,
    teammate: target.teammate,
    canonicalTeammateId: target.teammateId,
    additionalContextMessages: listEarlierCompletedGuidanceReplies(input.store, input.sourceRun, input.intervention),
  });

  const responseLanguage = resolveChannelResponseLanguage({
    store: input.store,
    channel,
    sourceText: sourceMessage.body,
  }).language;
  return {
    title: `Channel follow-up in ${channel.name}`,
    prompt: renderContextPack(contextPack),
    systemPromptInstruction: [
      "You are an AI teammate inside a Ling Stack channel.",
      "Reply concisely and only to the current channel discussion.",
      responseLanguageInstruction(responseLanguage),
      "Do not perform tool use or side effects.",
      "Do not include hidden proposal blocks. Do not create or suggest tasks, runs, workflows, branches, approvals, or side effects.",
      "Treat the latest queued follow-up as the current user message.",
      "Recent channel messages are context only; do not restart, repeat, or continue an earlier reply unless the latest message explicitly asks for it.",
      "Respond directly to the latest request. Do not acknowledge receipt, queueing, or continuation mechanics.",
    ].join("\n"),
    targetTeammateId: target.teammateId,
    providerPresetId: target.providerPresetId,
    ...(target.teammate?.runnerId ? { runnerId: target.teammate.runnerId } : {}),
  };
}

function listEarlierCompletedGuidanceReplies(
  store: RunStore,
  sourceRun: RunSession,
  currentIntervention: RunIntervention,
): readonly ChannelMessage[] {
  const interventions = store.listRunInterventions({ sourceRunId: sourceRun.id, limit: 100 });
  const currentIndex = interventions.findIndex((intervention) => intervention.id === currentIntervention.id);
  if (currentIndex <= 0) {
    return [];
  }
  return interventions
    .slice(0, currentIndex)
    .flatMap((intervention): ChannelMessage[] => {
      if (!intervention.completedAt || !intervention.continuationWorkUnitId) {
        return [];
      }
      const workUnit = store.getWorkUnit(intervention.continuationWorkUnitId);
      const reply = workUnit?.linkedMessageId ? store.getChannelMessage(workUnit.linkedMessageId) : undefined;
      if (!reply || reply.channelId !== sourceRun.channelId || reply.status !== "ready") {
        return [];
      }
      return [reply];
    })
    .slice(-6);
}
