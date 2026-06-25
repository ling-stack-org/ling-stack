import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createConversationViewStore, type ConversationViewStore } from "./conversation-view-store.js";

const ConversationViewStoreContext = createContext<ConversationViewStore | undefined>(undefined);

export interface ConversationViewProviderProps {
  readonly surfaceId: string;
  readonly children: ReactNode;
}

export function ConversationViewProvider({
  surfaceId,
  children,
}: ConversationViewProviderProps): JSX.Element {
  const store = useMemo(() => createConversationViewStore(surfaceId), [surfaceId]);
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
