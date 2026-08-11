import type { ChannelMessage, RunIntervention, RunSession, RunStore } from "@ling-stack/core";
import { buildChannelReplyContextPack, renderContextPack } from "./context-packs.js";
import { ensureChannelReplyThread } from "./channel-reply-execution.js";
import { resolveChannelReplyExecutionTarget } from "./channel-reply-execution-target.js";
import { buildLingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";
import { resolveChannelResponseLanguage, responseLanguageInstruction } from "./response-language.js";
import { getChannelMessageView } from "./conversation-item-messages.js";

export interface ChannelReplyContinuationContext {
  readonly title: string;
  readonly prompt: string;
  readonly systemPromptInstruction: string;
  readonly targetTeammateId: string;
  readonly providerPresetId: string;
  readonly threadId: string;
  readonly turnId: string;
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
  const sourceMessage = getChannelMessageView(input.store, input.sourceMessageId);
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
  const threadId = ensureChannelReplyThread(input.store, channel, sourceMessage).id;
  const sourceItem = input.store.getConversationItem(input.sourceMessageId);
  if (!sourceItem?.turnId || sourceItem.threadId !== threadId) {
    throw new Error(`Channel guidance source item has no owning turn: ${input.sourceMessageId}`);
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
    threadId,
    turnId: sourceItem.turnId,
    ...(target.teammate?.runnerId ? { runnerId: target.teammate.runnerId } : {}),
  };
}

function listEarlierCompletedGuidanceReplies(
  store: RunStore,
  sourceRun: RunSession,
  currentIntervention: RunIntervention,
): readonly ChannelMessage[] {
  if (!sourceRun.channelId) {
    return [];
  }
  return store.listPriorRunInterventionReplyMessages({
    sourceRunId: sourceRun.id,
    beforeInterventionId: currentIntervention.id,
    channelId: sourceRun.channelId,
  });
}
