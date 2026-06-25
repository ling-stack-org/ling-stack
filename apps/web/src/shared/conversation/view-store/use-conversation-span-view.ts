import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { selectDisclosureExpanded } from "./conversation-view-selectors.js";
import { useOptionalConversationViewStore } from "./conversation-view-provider.js";

export interface ConversationSpanViewState {
  readonly expanded: boolean;
  readonly setExpanded: (expanded: boolean) => void;
  readonly toggleExpanded: () => void;
}

export function useConversationSpanView(input: {
  readonly spanId: string;
  readonly revisionKey: string;
  readonly defaultExpanded: boolean;
}): ConversationSpanViewState {
  const store = useOptionalConversationViewStore();
  const [localState, setLocalState] = useState(() => ({
    spanId: input.spanId,
    revisionKey: input.revisionKey,
    expanded: input.defaultExpanded,
  }));
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => undefined), [store]);
  const getSnapshot = useCallback(
    () => store
      ? selectDisclosureExpanded(store.getSnapshot(), "span", input.spanId, input.defaultExpanded)
      : localState.spanId === input.spanId && localState.revisionKey === input.revisionKey
        ? localState.expanded
        : input.defaultExpanded,
    [input.defaultExpanded, input.revisionKey, input.spanId, localState.expanded, localState.revisionKey, localState.spanId, store],
  );
  const expanded = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => input.defaultExpanded,
  );

  useEffect(() => {
    if (!store) {
      setLocalState((current) => (
        current.spanId === input.spanId && current.revisionKey === input.revisionKey
          ? current
          : { spanId: input.spanId, revisionKey: input.revisionKey, expanded: input.defaultExpanded }
      ));
      return;
    }
    store.ensureDisclosure({
      id: input.spanId,
      kind: "span",
      revisionKey: input.revisionKey,
      defaultExpanded: input.defaultExpanded,
    });
  }, [input.defaultExpanded, input.revisionKey, input.spanId, store]);

  const setExpanded = useCallback((nextExpanded: boolean) => {
    if (store) {
      store.setDisclosureExpanded("span", input.spanId, nextExpanded);
      return;
    }
    setLocalState({
      spanId: input.spanId,
      revisionKey: input.revisionKey,
      expanded: nextExpanded,
    });
  }, [input.revisionKey, input.spanId, store]);

  const toggleExpanded = useCallback(() => {
    if (store) {
      store.toggleDisclosure("span", input.spanId);
      return;
    }
    setLocalState((current) => ({
      spanId: input.spanId,
      revisionKey: input.revisionKey,
      expanded: !current.expanded,
    }));
  }, [input.revisionKey, input.spanId, store]);

  return { expanded, setExpanded, toggleExpanded };
}
