import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { selectDisclosureExpanded } from "./conversation-view-selectors.js";
import { useOptionalConversationViewStore } from "./conversation-view-provider.js";

export interface ConversationBlockViewState {
  readonly expanded: boolean;
  readonly setExpanded: (expanded: boolean) => void;
  readonly toggleExpanded: () => void;
}

export function useConversationBlockView(input: {
  readonly blockId: string;
  readonly revisionKey: string;
  readonly defaultExpanded: boolean;
}): ConversationBlockViewState {
  const store = useOptionalConversationViewStore();
  const [localState, setLocalState] = useState(() => ({
    blockId: input.blockId,
    revisionKey: input.revisionKey,
    expanded: input.defaultExpanded,
  }));
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => undefined), [store]);
  const getSnapshot = useCallback(
    () => store
      ? selectDisclosureExpanded(store.getSnapshot(), "block", input.blockId, input.defaultExpanded)
      : localState.blockId === input.blockId && localState.revisionKey === input.revisionKey
        ? localState.expanded
        : input.defaultExpanded,
    [input.blockId, input.defaultExpanded, input.revisionKey, localState.blockId, localState.expanded, localState.revisionKey, store],
  );
  const expanded = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => input.defaultExpanded,
  );

  useEffect(() => {
    if (!store) {
      setLocalState((current) => (
        current.blockId === input.blockId && current.revisionKey === input.revisionKey
          ? current
          : { blockId: input.blockId, revisionKey: input.revisionKey, expanded: input.defaultExpanded }
      ));
      return;
    }
    store.ensureDisclosure({
      id: input.blockId,
      kind: "block",
      revisionKey: input.revisionKey,
      defaultExpanded: input.defaultExpanded,
    });
  }, [input.blockId, input.defaultExpanded, input.revisionKey, store]);

  const setExpanded = useCallback((nextExpanded: boolean) => {
    if (store) {
      store.setDisclosureExpanded("block", input.blockId, nextExpanded);
      return;
    }
    setLocalState({
      blockId: input.blockId,
      revisionKey: input.revisionKey,
      expanded: nextExpanded,
    });
  }, [input.blockId, input.revisionKey, store]);

  const toggleExpanded = useCallback(() => {
    if (store) {
      store.toggleDisclosure("block", input.blockId);
      return;
    }
    setLocalState((current) => ({
      blockId: input.blockId,
      revisionKey: input.revisionKey,
      expanded: !current.expanded,
    }));
  }, [input.blockId, input.revisionKey, store]);

  return { expanded, setExpanded, toggleExpanded };
}
