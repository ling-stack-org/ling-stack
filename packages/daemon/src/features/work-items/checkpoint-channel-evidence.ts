import { projectConversationItemToChannelMessage, type RunStore, type WorkItemEvidenceEntry } from "@ling-stack/core";
import { buildConversationSupersessionProjection, projectChannelMessageRevisionMetadata } from "../conversations/supersession-projection.js";

export function readCheckpointChannelEvidence(store: RunStore, threadId: string, channelId: string,
  entries: readonly WorkItemEvidenceEntry[]): WorkItemEvidenceEntry[] {
  const superseded = buildConversationSupersessionProjection(store, {
    surfaces: ["channel_root", "channel_branch", "topic_reply"], ownerId: channelId,
  });
  return entries.filter(entry => entry.visibility === "work_item" && entry.sourceRefs.some(ref => {
    if (ref.type !== "conversation_item" || superseded.supersededResponseMessageIds.has(ref.id)) return false;
    const item = store.getEffectiveConversationItem(ref.id);
    if (item?.id !== ref.id || item.threadId !== threadId || item.channelId !== channelId
      || item.status !== "committed" || item.visibility !== "channel" || String(item.revision) !== ref.revision
      || item.kind !== "user_message" && item.kind !== "assistant_message") return false;
    return projectChannelMessageRevisionMetadata(store, projectConversationItemToChannelMessage(item)).body === entry.content;
  }));
}
