import type { TeammateDirectMessage } from "../../types.js";

export function mergeCompanionMessages(
  current: readonly TeammateDirectMessage[],
  incoming: readonly TeammateDirectMessage[],
): readonly TeammateDirectMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    // A history request started before a stream delta may finish after it.
    if (existing && message.status === "pending" && (
      existing.status !== "pending"
      || existing.updatedAt > message.updatedAt
      || existing.body.length > message.body.length
    )) continue;
    byId.set(message.id, message);
  }
  return [...byId.values()];
}
