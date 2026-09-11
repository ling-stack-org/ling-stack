import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ConversationTimelineItem, ConversationTimelineSubAgentItem } from "@ling-stack/conversation-ui-core";
import type { ConversationDisclosureState } from "../view-store/conversation-view-store.js";
import { useConversationViewStore } from "../view-store/conversation-view-provider.js";
import { shouldDefaultExpandConversationTimelineSubAgent } from "./conversation-timeline-sub-agent-disclosure.js";
import { conversationTimelineSubAgentDisclosureKey } from "./conversation-timeline-view-retain-keys.js";
import {
  projectConversationTimelineDisplayModel,
  type ConversationTimelineDisplayModel,
} from "./conversation-timeline-display-model.js";

const emptyDisclosureMap: ReadonlyMap<string, ConversationDisclosureState> = new Map();

export interface ConversationTimelineDisplayController {
  readonly model: ConversationTimelineDisplayModel;
  readonly setSubAgentExpanded: (item: ConversationTimelineSubAgentItem, expanded: boolean) => void;
  readonly setBlockExpanded: (id: string, expanded: boolean) => void;
  readonly revealDisclosurePath: (ids: readonly string[]) => void;
}

/**
 * One root-level subscription drives Agent disclosure and display-row
 * projection. Hooks must not be created per projected row because expansion
 * changes the row count and virtual rows routinely unmount.
 */
export function useConversationTimelineDisplayModel(
  items: readonly ConversationTimelineItem[],
): ConversationTimelineDisplayController {
  const store = useConversationViewStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot().blockDisclosureById, [store]);
  const disclosureById = useSyncExternalStore(subscribe, getSnapshot, () => emptyDisclosureMap);
  useEffect(() => {
    const ensure = (item: ConversationTimelineItem): void => {
      if (item.kind === "commandBatch" || item.kind === "explorationBatch") {
        store.ensureDisclosure({ id: item.batch.id, kind: "block", revisionKey: item.batch.revisionKey,
          defaultExpanded: item.batch.defaultExpanded, preserveTouchedStateOnRevision: true });
        return;
      }
      if (item.kind !== "subAgentActivity") return;
      store.ensureDisclosure({
        id: conversationTimelineSubAgentDisclosureKey(item.id),
        kind: "block",
        revisionKey: String(item.revision),
        defaultExpanded: shouldDefaultExpandConversationTimelineSubAgent(item),
        preserveTouchedStateOnRevision: true,
      });
      item.childItems.forEach((child) => { if (child.kind !== "subAgentActivity") ensure(child); });
    };
    items.forEach(ensure);
  }, [store, items]);

  const model = useMemo(
    () => projectConversationTimelineDisplayModel(items, disclosureById),
    [disclosureById, items],
  );
  const setSubAgentExpanded = useCallback((item: ConversationTimelineSubAgentItem, expanded: boolean) => {
    store.setDisclosureExpanded(
      "block",
      conversationTimelineSubAgentDisclosureKey(item.id),
      expanded,
    );
  }, [store]);

  const setBlockExpanded = useCallback((id: string, expanded: boolean) => {
    store.setDisclosureExpanded("block", id, expanded);
  }, [store]);
  const revealDisclosurePath = useCallback((ids: readonly string[]) => {
    for (const id of ids) store.setDisclosureExpanded("block", id, true);
  }, [store]);

  return { model, setSubAgentExpanded, setBlockExpanded, revealDisclosurePath };
}
