import type { RunStore } from "@ling-stack/core";
import {
  buildConversationContextProjection,
  type ConversationContextProjection,
} from "./context-processing/conversation-context-projector.js";

export interface ChannelOperationVisibleSource {
  readonly itemId: string;
  readonly body: string;
  readonly revision: number;
  readonly actorType: "local_user" | "ling_agent" | "teammate";
}

/**
 * The continuity projector owns segment/anchor/visibility selection. This registry
 * does not widen it by fetching arbitrary model-supplied IDs or scanning history.
 * Assistant material may supply content or a target; only the current user item
 * can supply a new operation's execution instruction.
 */
export function channelOperationVisibleSources(input: {
  readonly store: RunStore;
  readonly sourceItemId: string;
  readonly projection?: ConversationContextProjection;
}): readonly ChannelOperationVisibleSource[] {
  const projection = input.projection ?? buildConversationContextProjection({
    store: input.store, sourceItemId: input.sourceItemId, view: "selector",
  });
  return projection.items.flatMap((item): ChannelOperationVisibleSource[] => {
    if (item.status !== "committed" || (item.kind !== "user_message" && item.kind !== "assistant_message")
      || (item.actorType !== "local_user" && item.actorType !== "ling_agent" && item.actorType !== "teammate")) return [];
    return [{ itemId: item.id, body: item.payload.body, revision: item.revision, actorType: item.actorType }];
  });
}
