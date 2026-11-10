import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
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
  readonly preserveTouchedStateOnRevision?: boolean;
}): ConversationBlockViewState {
  const store = useOptionalConversationViewStore();
  const [localState, setLocalState] = useState(() => ({
    blockId: input.blockId,
    revisionKey: input.revisionKey,
    expanded: input.defaultExpanded,
    touched: false,
  }));
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => undefined), [store]);
  const getSnapshot = useCallback(
    () => store
      ? selectDisclosureExpanded(store.getSnapshot(), "block", input.blockId, input.defaultExpanded)
      : localState.blockId === input.blockId && localState.revisionKey === input.revisionKey
        ? localState.expanded
        : input.preserveTouchedStateOnRevision && localState.blockId === input.blockId && localState.touched
          ? localState.expanded
        : input.defaultExpanded,
    [input.blockId, input.defaultExpanded, input.preserveTouchedStateOnRevision, input.revisionKey, localState.blockId, localState.expanded, localState.revisionKey, localState.touched, store],
  );
  const expanded = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => input.defaultExpanded,
  );

  useLayoutEffect(() => {
    if (!store) {
      setLocalState((current) => (
        current.blockId === input.blockId && current.revisionKey === input.revisionKey
          ? current
          : {
              blockId: input.blockId,
              revisionKey: input.revisionKey,
              expanded: input.preserveTouchedStateOnRevision && current.blockId === input.blockId && current.touched
                ? current.expanded
                : input.defaultExpanded,
              touched: input.preserveTouchedStateOnRevision && current.blockId === input.blockId
                ? current.touched
                : false,
            }
      ));
      return;
    }
    store.ensureDisclosure({
      id: input.blockId,
      kind: "block",
      revisionKey: input.revisionKey,
      defaultExpanded: input.defaultExpanded,
      preserveTouchedStateOnRevision: input.preserveTouchedStateOnRevision,
    });
  }, [input.blockId, input.defaultExpanded, input.preserveTouchedStateOnRevision, input.revisionKey, store]);

  const setExpanded = useCallback((nextExpanded: boolean) => {
    if (store) {
      store.setDisclosureExpanded("block", input.blockId, nextExpanded);
      return;
    }
    setLocalState({
      blockId: input.blockId,
      revisionKey: input.revisionKey,
      expanded: nextExpanded,
      touched: true,
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
      touched: true,
    }));
  }, [input.blockId, input.revisionKey, store]);

  return { expanded, setExpanded, toggleExpanded };
}
