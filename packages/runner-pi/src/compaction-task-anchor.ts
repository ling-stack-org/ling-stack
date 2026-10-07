import { isRecord } from "./utils.js";

/** Compaction summaries are progress, never the authority for an accepted task. */
export function hasCompactionSummary(messages: readonly unknown[]): boolean {
  return messages.some((message) => isRecord(message) && message.role === "compactionSummary");
}

/** Exact user content only; neither a summary nor a tool echo is an anchor. */
export function hasAcceptedTaskAnchor(messages: readonly unknown[], acceptedTaskPrompt: string): boolean {
  return messages.some((message) => {
    if (!isRecord(message) || message.role !== "user") return false;
    if (typeof message.content === "string") return message.content === acceptedTaskPrompt;
    return Array.isArray(message.content) && message.content.every((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string") &&
      message.content.map((block) => (block as { text: string }).text).join("") === acceptedTaskPrompt;
  });
}

/**
 * Project ordinary user constraints after the first SDK summary. The same pure
 * view is used for provider context and Host seals; never mutate SDK history,
 * split tool pairs, append a new turn, or promote user text to system authority.
 */
export function projectCompactionTaskView(messages: readonly unknown[], acceptedTaskPrompt: string): readonly unknown[] {
  const summaryIndex = messages.findIndex((message) => isRecord(message) && message.role === "compactionSummary");
  if (summaryIndex < 0) return messages;
  if (!acceptedTaskPrompt.trim()) throw new Error("Compaction accepted task anchor is empty");
  if (hasAcceptedTaskAnchor(messages, acceptedTaskPrompt)) return messages;
  const summary = messages[summaryIndex] as Record<string, unknown>;
  // SDK conversion metadata only, not a new canonical conversation timestamp.
  const timestamp = typeof summary.timestamp === "number" && Number.isFinite(summary.timestamp) ? summary.timestamp : 0;
  return [...messages.slice(0, summaryIndex + 1),
    { role: "user", content: [{ type: "text", text: acceptedTaskPrompt }], timestamp },
    ...messages.slice(summaryIndex + 1)];
}

/** A swallowed SDK context-hook failure must not permit a lossy task dispatch. */
export function assertAcceptedTaskAnchor(messages: readonly unknown[], acceptedTaskPrompt: string): void {
  if (!acceptedTaskPrompt.trim() || !hasAcceptedTaskAnchor(messages, acceptedTaskPrompt)) {
    throw new Error("Compaction model context is missing the accepted task anchor");
  }
}
