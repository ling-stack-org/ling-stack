import type { ConversationItemV1 } from "@ling-stack/contracts";
import type { ConversationContextProjectionView } from "./conversation-context-projector.js";

/** Visibility only. Source, owner, segment and budget admission are separate checks. */
export function isConversationContextItemVisible(
  item: ConversationItemV1,
  view: ConversationContextProjectionView,
  consumerTeammateId: string | undefined,
): boolean {
  if (item.visibility === "channel" || item.visibility === "thread_participants") return true;
  if (item.visibility === "operator") return view === "inspect";
  return item.visibility === "agent_private"
    && Boolean(consumerTeammateId)
    && item.visibilityOwnerId === consumerTeammateId
    && (view === "specialist" || view === "workflow_step" || view === "inspect");
}
