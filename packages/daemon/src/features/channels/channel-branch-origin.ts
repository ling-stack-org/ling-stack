import type { Channel, CreateChannelBranchInput, RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { resolveChannelConversationThread } from "./conversation-thread-resolution.js";
import { buildConversationContextProjection } from "./context-processing/conversation-context-projector.js";

/** Sidebar lanes start at the channel root's current committed boundary. */
export function buildChannelBranchOrigin(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly name: string;
  readonly now: string;
}): NonNullable<CreateChannelBranchInput["conversationThread"]> {
  const { store, channel, now } = input;
  const parent = resolveChannelConversationThread({ store, channel, now });
  const base = { surfaceKind: "branch" as const, channelId: channel.id, parentThreadId: parent.id,
    title: input.name || "Channel branch", objective: `Conversation branch "${input.name || "Channel branch"}" for ${channel.name}.` };
  let beforeSequence: number | undefined;
  do {
    const page = store.listConversationItemsPage({ threadId: parent.id, beforeSequence, effectiveOnly: true, limit: 100 });
    const anchor = [...page.items].reverse().find(item => item.status === "committed" && item.turnId);
    if (anchor?.turnId) {
      const projection = buildConversationContextProjection({ store, sourceItemId: anchor.id, view: "reply" });
      return { ...base, parentTurnId: anchor.turnId, forkContextSnapshot: {
        segmentId: projection.metadata.segmentId, projectionVersion: projection.metadata.projectionVersion,
        throughItemSequence: projection.metadata.throughItemSequence, summaryIds: projection.metadata.summaryIds,
        sourceRefs: projection.metadata.sourceRefs, policyVersion: projection.metadata.policyVersion,
      } };
    }
    beforeSequence = page.nextBeforeSequence;
  } while (beforeSequence !== undefined);
  if (parent.nextItemSequence !== 1 || store.listLingTurns({ threadId: parent.id, limit: 1 }).length) {
    throw new HttpError(409, "branch_context_unavailable", "Channel branch requires a committed parent context boundary.");
  }
  return { ...base, forkContextSnapshot: { projectionVersion: "continuity-v2-empty-fork-v1", throughItemSequence: 0,
    summaryIds: [], sourceRefs: [{ type: "thread", id: parent.id }], policyVersion: "continuity-v2-empty-fork-v1" } };
}
