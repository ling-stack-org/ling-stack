import type { ChannelMessage, RunStore } from "@ling-stack/core";

export function filterQueuedChannelReplyMessages(
  store: RunStore,
  messages: readonly ChannelMessage[],
  isClassificationPending: (message: ChannelMessage) => boolean = () => false,
): readonly ChannelMessage[] {
  if (messages.length === 0) {
    return messages;
  }
  const hiddenMessageIds = new Set(
    store.listRunInterventions({
      mode: "queue_followup",
      sourceMessageIds: messages.map((message) => message.id),
      limit: Math.min(messages.length, 500),
    })
      .filter((intervention) => (
        !intervention.startedAt &&
        intervention.idempotencyKey.startsWith("channel_message:") &&
        intervention.messagePayload?.sourceMessageId
      ))
      .map((intervention) => intervention.messagePayload!.sourceMessageId!),
  );
  return messages.filter((message) => (
    !hiddenMessageIds.has(message.id) && !isClassificationPending(message)
  ));
}
