import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ConversationTimelineItem, ConversationTimelineSubAgentItem, TimelineRunLifecycle } from "@ling-stack/conversation-ui-core";
import type { ConversationDisclosureState } from "../view-store/conversation-view-store.js";
import { useConversationViewStore } from "../view-store/conversation-view-provider.js";
import { shouldDefaultExpandConversationTimelineSubAgent } from "./conversation-timeline-sub-agent-disclosure.js";
import { conversationTimelineSubAgentDisclosureKey, timelineActivityDisclosureKey } from "./conversation-timeline-view-retain-keys.js";
import { projectTimelineProcessSections } from "./timeline-process-presentation.js";
import { projectTimelineActivitySections } from "./timeline-activity-presentation.js";
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
  runLifecycles?: ReadonlyMap<string, TimelineRunLifecycle>,
  contextSegments?: ReadonlyMap<string, string>,
): ConversationTimelineDisplayController {
  const store = useConversationViewStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot().blockDisclosureById, [store]);
  const disclosureById = useSyncExternalStore(subscribe, getSnapshot, () => emptyDisclosureMap);
  useEffect(() => {
    const ensure = (item: ConversationTimelineItem, parentId?: string): void => {
      if (item.kind === "commandBatch" || item.kind === "explorationBatch") {
        // A core batch and its earlier two-operation fold share the first
        // atom's disclosure, so grouping never resets a user's preference.
        const id = timelineActivityDisclosureKey(item, parentId) ?? item.batch.id;
        const legacy = store.getSnapshot().blockDisclosureById.get(item.batch.id);
        const migrate = id !== item.batch.id && legacy?.touched && !store.getSnapshot().blockDisclosureById.has(id);
        store.ensureDisclosure({ id, kind: "block", revisionKey: item.batch.revisionKey,
          defaultExpanded: item.batch.defaultExpanded, preserveTouchedStateOnRevision: true });
        if (migrate) store.setDisclosureExpanded("block", id, legacy.expanded);
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
      item.childItems.forEach((child) => { if (child.kind !== "subAgentActivity") ensure(child, item.id); });
    };
    const ensureScope = (scoped: readonly ConversationTimelineItem[], parentId?: string): void => {
      const ensureSections = (sections: ReturnType<typeof projectTimelineProcessSections>): void => {
        for (const section of sections) if (section.kind === "process") {
          store.ensureDisclosure({ id: section.group.id, kind: "block",
            revisionKey: section.group.revisionKey, defaultExpanded: section.group.defaultExpanded, preserveTouchedStateOnRevision: true });
          if (section.group.presentation === "process") ensureSections(projectTimelineActivitySections(section.group.items, parentId, contextSegments));
        }
      };
      ensureSections(projectTimelineProcessSections(scoped, parentId, runLifecycles, contextSegments));
      for (const item of scoped) if (item.kind === "subAgentActivity") ensureScope(item.childItems, item.id);
    };
    items.forEach(item => ensure(item));
    ensureScope(items);
  }, [store, items, runLifecycles, contextSegments]);

  const model = useMemo(
    () => projectConversationTimelineDisplayModel(items, disclosureById, runLifecycles, contextSegments),
    [disclosureById, items, runLifecycles, contextSegments],
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
