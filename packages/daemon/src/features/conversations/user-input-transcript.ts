import type { ConversationItemV1, UserInputTranscriptItemV1 } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";

/**
 * Shared Host hydration for normal, private and paged channel history. Only
 * canonical question/answer anchors select content; no title/text/Run guessing.
 */
export function projectConversationUserInputs(
  store: Pick<RunStore, "readUserInputTranscript">,
  threadId: string,
  items: readonly ConversationItemV1[],
): { readonly conversationItems: readonly ConversationItemV1[]; readonly userInputs: readonly UserInputTranscriptItemV1[] } {
  const anchorIds = [...new Set(items.filter(isUserInputAnchor).map(item => item.id))];
  const userInputs: UserInputTranscriptItemV1[] = [];
  for (let offset = 0; offset < anchorIds.length; offset += 500) {
    userInputs.push(...store.readUserInputTranscript({ threadId, itemIds: anchorIds.slice(offset, offset + 500) }));
  }
  const visibleIds = new Set(userInputs.map(item => item.itemId));
  return {
    // Omitted hydration means inaccessible, not an unavailable private placeholder.
    conversationItems: items.filter(item => !isUserInputAnchor(item) || visibleIds.has(item.id)),
    userInputs,
  };
}
function isUserInputAnchor(item: ConversationItemV1): boolean {
  return item.kind === "user_input_request" || item.kind === "user_input_answer";
}
