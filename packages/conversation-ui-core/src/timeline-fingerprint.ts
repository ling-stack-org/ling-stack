import type { ConversationTimelineItem, ConversationTimelineItemKind } from "./transcript-item.js";

/**
 * Stable semantic identity for parity tests. This is deliberately not a pixel
 * hash: shell chrome, avatars, and theme tokens may vary by surface while the
 * timeline grammar must remain identical.
 */
export interface ConversationTimelineFingerprint {
  readonly rendererKeys: readonly string[];
  readonly itemKinds: readonly ConversationTimelineItemKind[];
  readonly itemIds: readonly string[];
  readonly disclosureCount: number;
}

export function fingerprintConversationTimeline(
  items: readonly ConversationTimelineItem[],
): ConversationTimelineFingerprint {
  const rendererKeys: string[] = [];
  const itemKinds: ConversationTimelineItemKind[] = [];
  const itemIds: string[] = [];
  let disclosureCount = 0;

  const visit = (item: ConversationTimelineItem): void => {
    itemKinds.push(item.kind);
    itemIds.push(item.id);
    rendererKeys.push(conversationTimelineRendererKey(item.kind));
    if (hasDisclosure(item.kind)) disclosureCount += 1;
    if (item.kind === "commandBatch") {
      item.batch.commands.forEach(visit);
    } else if (item.kind === "explorationBatch") {
      item.batch.children.forEach(visit);
    } else if (item.kind === "subAgentActivity") {
      item.childItems.forEach(visit);
    }
  };

  items.forEach(visit);
  return { rendererKeys, itemKinds, itemIds, disclosureCount };
}

/** Stable dotted renderer key shared by fingerprinting and DOM semantics. */
export function conversationTimelineRendererKey(kind: ConversationTimelineItemKind): string {
  if (kind === "userMessage" || kind === "agentMessage") return "message.document";
  if (kind === "reasoning") return "message.reasoning";
  if (kind === "plan") return "fact.plan";
  if (kind === "commandExecution") return "fact.command";
  if (kind === "fileChange") return "fact.file";
  if (kind === "exploration") return "fact.exploration";
  if (kind === "mcpToolCall" || kind === "dynamicToolCall" || kind === "collabAgentToolCall") return "fact.tool";
  if (kind === "approval") return "fact.approval";
  if (kind === "imageView") return "fact.image";
  if (kind === "contextCompaction") return "system.compaction";
  if (kind === "terminalReport") return "result.terminal";
  if (kind === "protocolEvent") return "fact.protocol";
  if (kind === "subAgentActivity") return "agent.nested";
  if (kind === "commandBatch") return "batch.command";
  if (kind === "explorationBatch") return "batch.exploration";
  return "diagnostic.blocked";
}

function hasDisclosure(kind: ConversationTimelineItemKind): boolean {
  return kind !== "userMessage" && kind !== "agentMessage";
}
