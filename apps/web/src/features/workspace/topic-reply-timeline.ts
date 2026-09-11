import {
  createConversationTimelineMessageItem, mergeConversationRunNarration, projectCanonicalConversationTimeline,
  projectCanonicalUserInputTimeline,
  type CanonicalConversationItem,
  type CanonicalReasoningSummaryRecord,
  type ConversationTimelineItem,
} from "@ling-stack/conversation-ui-core";
import type { ChannelMessage, ConversationItemV1, ConversationReasoningSummaryRecord, UserInputTranscriptItemV1 } from "../../types.js";

/**
 * A topic has its own canonical spine. The quoted parent message is a pinned
 * reference, not a row on that spine. Only scoped transient replies may lack an
 * anchor while streaming; cached durable messages cannot cross a topic switch.
 */
export function projectTopicReplyTimeline(input: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly rootMessage: ChannelMessage;
  readonly replies: readonly ChannelMessage[];
  readonly conversationItems: readonly ConversationItemV1[];
  readonly userInputs: readonly UserInputTranscriptItemV1[];
  readonly reasoningSummaries: readonly ConversationReasoningSummaryRecord[];
}): readonly ConversationTimelineItem[] {
  const root = messageItem(input.rootMessage, -1);
  if (!input.threadId?.trim()) return [root];
  const anchors = input.conversationItems.filter(item => item.workspaceId === input.workspaceId
    && item.channelId === input.channelId && item.threadId === input.threadId);
  const byId = new Map(anchors.map(item => [item.id, item]));
  const seen = new Set([input.rootMessage.id]);
  const pending: ChannelMessage[] = [];
  const messages: ConversationTimelineItem[] = [];
  for (const message of input.replies) {
    if (seen.has(message.id) || message.workspaceId !== input.workspaceId
      || message.channelId !== input.channelId || message.threadId !== input.threadId) continue;
    seen.add(message.id);
    const anchor = byId.get(message.id);
    if (anchor && (anchor.kind === "user_message" || anchor.kind === "assistant_message" || anchor.kind === "system_event")) {
      messages.push(messageItem(message, anchor.sequence));
    } else if (!anchor && message.status === "pending") {
      pending.push(message);
    }
  }
  const questions = projectCanonicalUserInputTimeline({
    scope: { surface: "topic", workspaceId: input.workspaceId, threadId: input.threadId, depth: 0 },
    items: anchors,
    userInputs: input.userInputs,
  });
  const history = [...messages, ...questions].sort((a, b) => a.threadSequence - b.threadSequence
    || a.partIndex - b.partIndex || a.id.localeCompare(b.id));
  const reasoning = projectTopicReasoningItems(anchors, input.reasoningSummaries);
  const historyWithReasoning = mergeConversationRunNarration(history, reasoning);
  const tail = anchors.reduce((max, item) => Math.max(max, item.sequence), 0);
  return [root, ...historyWithReasoning, ...pending.map((message, index) => messageItem(message, tail + index + 1))];
}

function projectTopicReasoningItems(
  items: readonly ConversationItemV1[],
  summaries: readonly ConversationReasoningSummaryRecord[],
): readonly ConversationTimelineItem[] {
  const first = items[0];
  if (!first || summaries.length === 0) return [];
  const canonicalItems: CanonicalConversationItem[] = items.map((item) => ({
    id: item.id,
    workspaceId: item.workspaceId,
    threadId: item.threadId,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    sequence: item.sequence,
    kind: item.kind,
    revision: item.revision,
    status: item.status,
    actorType: item.actorType,
    actorId: item.actorId,
    payload: item.payload,
    domainRefs: item.domainRefs,
  }));
  const canonicalSummaries: CanonicalReasoningSummaryRecord[] = summaries
    .filter((summary) => summary.workspaceId === first.workspaceId && summary.threadId === first.threadId)
    .map((summary) => ({ ...summary, sourceRefs: summary.sourceRefs.map((ref) => ({ ...ref })) }));
  if (canonicalSummaries.length === 0) return [];
  return projectCanonicalConversationTimeline({
    scope: { surface: "topic", workspaceId: first.workspaceId, threadId: first.threadId, depth: 0 },
    items: canonicalItems,
    actions: [],
    reasoningSummaries: canonicalSummaries,
    turnRuns: [],
    sourceSequence: canonicalItems.reduce((max, item) => Math.max(max, item.sequence), 0),
    sourceRevision: canonicalSummaries.map((summary) => `${summary.id}:${summary.revision}`).sort().join("|"),
  }).items.filter((item) => item.kind === "reasoning");
}

function messageItem(message: ChannelMessage, sequence: number): ConversationTimelineItem {
  const role = message.authorType === "local-user" ? "user" : "agent";
  return createConversationTimelineMessageItem({
    id: `message:${role}:${message.id}`, role, markdown: message.body, revision: message.revision,
    threadSequence: sequence, itemId: message.id, turnId: message.turnId, fileRefs: message.fileRefs,
    status: message.status === "pending" ? "pending" : message.status === "blocked" ? "blocked"
      : message.status === "failed" ? "failed" : undefined,
  });
}
