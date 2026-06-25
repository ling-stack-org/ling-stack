import { useEffect } from "react";
import { useOptionalConversationViewStore } from "./conversation-view-provider.js";
import type { ConversationViewRetainKeys } from "./conversation-view-store.js";

export function useConversationViewReconciliation(retainKeys: ConversationViewRetainKeys | undefined): void {
  const store = useOptionalConversationViewStore();

  useEffect(() => {
    if (!store || !retainKeys) {
      return;
    }
    store.reconcileRetainedKeys(retainKeys);
  }, [retainKeys, store]);
}
