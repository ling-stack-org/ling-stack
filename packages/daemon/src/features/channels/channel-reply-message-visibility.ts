import type { ChannelMessage, RunStore } from "@ling-stack/core";

export function filterQueuedChannelReplyMessages(
  store: RunStore,
  messages: readonly ChannelMessage[],
  isClassificationPending: (message: ChannelMessage) => boolean = () => false,
): readonly ChannelMessage[] {
  const hiddenMessageIds = new Set(
    store.listRunInterventions({ mode: "queue_followup", limit: 500 })
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
