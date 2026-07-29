export function isConversationGuidanceQueueVisible(status: string): boolean {
  return status === "queued" || status === "cancelling_source";
}
