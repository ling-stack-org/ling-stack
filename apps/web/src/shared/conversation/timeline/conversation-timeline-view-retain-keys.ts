import type { ConversationTimelineItem } from "@ling-stack/conversation-ui-core";
import type { ConversationViewRetainKeys } from "../view-store/conversation-view-store.js";

export function timelineProcessScopeKey(item: ConversationTimelineItem): string | undefined {
  if (!item.turnId || !item.runId || !item.attemptId || !item.participantId) return undefined;
  return JSON.stringify([item.turnId, item.runId, item.attemptId, item.participantId, item.workflowStepId ?? null]);
}

export function timelineProcessDisclosureKey(item: ConversationTimelineItem, parentId = "root"): string | undefined {
  const scope = timelineProcessScopeKey(item);
  if (!scope) return undefined;
  const atomId = item.kind === "commandBatch" ? item.batch.commands[0]?.leadingItems?.[0]?.id ?? item.batch.commands[0]?.id
    : item.kind === "explorationBatch" ? item.batch.children[0]?.id : item.id;
  return `timeline-process:${JSON.stringify([parentId, scope, atomId ?? item.id])}`;
}

export function timelineActivityDisclosureKey(item: ConversationTimelineItem, parentId = "root"): string | undefined {
  return timelineProcessDisclosureKey(item, parentId)?.replace("timeline-process:", "timeline-activity:");
}

/** Stable view-store identity for the single disclosure owned by an Agent span. */
export function conversationTimelineSubAgentDisclosureKey(itemId: string): string {
  return `timeline-sub-agent:${itemId}`;
}

/**
 * Collects every view-store identity owned by a Timeline snapshot. The walk is
 * intentionally recursive because collapsed batches and nested Agent timelines
 * still own disclosure state that must survive an SSE/revision replacement.
 */
export function collectConversationTimelineViewRetainKeys(
  items: readonly ConversationTimelineItem[],
  seed?: ConversationViewRetainKeys,
): ConversationViewRetainKeys {
  const blockIds = new Set(seed?.blockIds ?? []);
  const spanIds = new Set(seed?.spanIds ?? []);
  const actionIds = new Set(seed?.actionIds ?? []);

  const collect = (item: ConversationTimelineItem): void => {
    if (item.actionId) actionIds.add(item.actionId);

    if (item.kind === "commandBatch") {
      blockIds.add(item.batch.id);
      item.actionIds.forEach((actionId) => actionIds.add(actionId));
      item.childActionIds.forEach((actionId) => actionIds.add(actionId));
      for (const command of item.batch.commands) {
        collect(command);
        command.leadingItems?.forEach(collect);
      }
      return;
    }

    if (item.kind === "explorationBatch") {
      blockIds.add(item.batch.id);
      item.actionIds.forEach((actionId) => actionIds.add(actionId));
      item.childActionIds.forEach((actionId) => actionIds.add(actionId));
      item.batch.children.forEach(collect);
      return;
    }

    if (item.kind === "subAgentActivity") {
      blockIds.add(conversationTimelineSubAgentDisclosureKey(item.id));
      item.childItems.forEach(collect);
      return;
    }

    if (item.kind !== "userMessage" && item.kind !== "agentMessage") {
      blockIds.add(`timeline-item:${item.id}`);
    }
  };

  const collectProcess = (scoped: readonly ConversationTimelineItem[], parentId?: string): void => {
    // Retain all possible starting atoms, including unloaded group boundaries.
    // This requires no lifecycle projection and survives paging/batch changes.
    for (const item of scoped) {
      const key = timelineProcessDisclosureKey(item, parentId);
      if (key) blockIds.add(key);
      const activityKey = timelineActivityDisclosureKey(item, parentId);
      if (activityKey) blockIds.add(activityKey);
    }
    for (const item of scoped) if (item.kind === "subAgentActivity") collectProcess(item.childItems, item.id);
  };
  items.forEach(collect);
  collectProcess(items);
  return { blockIds, spanIds, actionIds };
}
