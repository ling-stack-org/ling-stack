import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createConversationViewStore, type ConversationViewStore } from "./conversation-view-store.js";
import { conversationReadingStorage } from "./conversation-reading-storage.js";

const ConversationViewStoreContext = createContext<ConversationViewStore | undefined>(undefined);

export interface ConversationViewProviderProps {
  readonly surfaceId: string;
  readonly readingScopeKey?: string;
  readonly children: ReactNode;
}

export function ConversationViewProvider({
  surfaceId,
  readingScopeKey,
  children,
}: ConversationViewProviderProps): React.JSX.Element {
  const store = useMemo(() => createConversationViewStore(surfaceId, readingScopeKey ? {
    read: (kind, id) => conversationReadingStorage.readDisclosure(readingScopeKey, kind, id),
    write: (kind, id, expanded) => conversationReadingStorage.writeDisclosure(readingScopeKey, kind, id, expanded),
  } : undefined), [surfaceId, readingScopeKey]);
  return (
    <ConversationViewStoreContext.Provider value={store}>
      {children}
    </ConversationViewStoreContext.Provider>
  );
}

export function useConversationViewStore(): ConversationViewStore {
  const store = useOptionalConversationViewStore();
  if (!store) {
    throw new Error("ConversationViewProvider is required before using conversation view state.");
  }
  return store;
}

export function useOptionalConversationViewStore(): ConversationViewStore | undefined {
  return useContext(ConversationViewStoreContext);
}
