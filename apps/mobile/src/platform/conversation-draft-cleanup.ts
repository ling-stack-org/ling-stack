const DRAFT_PREFIX = "ling.mobile.draft.v1.";

/** The AsyncStorage 2.x operations required for namespace-scoped draft cleanup. */
export interface ConversationDraftRemovalStorage {
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: readonly string[]): Promise<void>;
}

/** Preserve the existing draft key format shared by reads, writes, and cleanup. */
export function draftNamespacePrefix(workspaceBindingId: string): string {
  // TODO: v1's unescaped "." separator is ambiguous for dotted binding IDs.
  // Full isolation needs a separate versioned-key migration, not an SDK-only change.
  return `${DRAFT_PREFIX}${encodeURIComponent(workspaceBindingId)}.`;
}

/** Remove drafts under the persisted binding prefix; propagate native storage failures. */
export async function removeConversationDraftsFromStorage(
  storage: ConversationDraftRemovalStorage,
  workspaceBindingId: string,
): Promise<void> {
  const prefix = draftNamespacePrefix(workspaceBindingId);
  const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(prefix));
  if (keys.length > 0) {
    await storage.multiRemove(keys);
  }
}
