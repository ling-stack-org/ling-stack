import type {
  ConversationTimelineDiagnosticItem,
  ConversationTimelineItem,
  ConversationTimelineSubAgentItem,
  TimelineRunLifecycle,
} from "@ling-stack/conversation-ui-core";
import type { ConversationDisclosureState } from "../view-store/conversation-view-store.js";
import { shouldDefaultExpandConversationTimelineSubAgent } from "./conversation-timeline-sub-agent-disclosure.js";
import { conversationTimelineSubAgentDisclosureKey } from "./conversation-timeline-view-retain-keys.js";
import { projectTimelineProcessSections, timelineItemNeedsVisibleAttention, type TimelineProcessGroup, type TimelineProcessSection } from "./timeline-process-presentation.js";

interface ConversationTimelineDisplayRowBase {
  readonly rowKey: string;
  readonly item: ConversationTimelineItem;
  readonly depth: 0 | 1;
  readonly parentBatchId?: string;
  readonly batchDisclosure?: ConversationTimelineBatchDisclosure;
}

export interface ConversationTimelineBatchDisclosure {
  readonly id: string;
  readonly groupId: string;
  readonly expanded: boolean;
}

export interface ConversationTimelineItemDisplayRow extends ConversationTimelineDisplayRowBase {
  readonly kind: "item";
  readonly depth: 0;
}

export interface ConversationTimelineSubAgentHeaderDisplayRow extends ConversationTimelineDisplayRowBase {
  readonly kind: "subAgentHeader";
  readonly item: ConversationTimelineSubAgentItem;
  readonly depth: 0;
  readonly groupId: string;
  readonly expanded: boolean;
}

export interface ConversationTimelineSubAgentChildDisplayRow extends ConversationTimelineDisplayRowBase {
  readonly kind: "subAgentChild";
  readonly depth: 1;
  readonly parentSubAgentId: string;
  readonly parentLabel: string;
  readonly groupId: string;
  readonly childIndex: number;
  readonly childCount: number;
}

export interface ConversationTimelineProcessHeaderDisplayRow extends ConversationTimelineDisplayRowBase {
  readonly kind: "processHeader";
  readonly depth: 0 | 1;
  readonly process: TimelineProcessGroup;
  readonly groupId: string;
  readonly expanded: boolean;
  readonly parentSubAgentId?: string;
}

export type ConversationTimelineDisplayRow =
  | ConversationTimelineItemDisplayRow
  | ConversationTimelineSubAgentHeaderDisplayRow
  | ConversationTimelineSubAgentChildDisplayRow
  | ConversationTimelineProcessHeaderDisplayRow;

export type ConversationTimelineDisplaySegment =
  | {
      readonly kind: "processGroup";
      readonly headerRow: ConversationTimelineProcessHeaderDisplayRow;
      readonly childSegments: readonly ConversationTimelineDisplaySegment[];
      readonly groupId: string;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "row";
      readonly row: ConversationTimelineItemDisplayRow | ConversationTimelineSubAgentChildDisplayRow;
    }
  | {
      readonly kind: "batchGroup";
      readonly headerRow: ConversationTimelineItemDisplayRow | ConversationTimelineSubAgentChildDisplayRow;
      readonly childSegments: readonly ConversationTimelineDisplaySegment[];
      readonly groupId: string;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "subAgentGroup";
      readonly item: ConversationTimelineSubAgentItem;
      readonly headerRow: ConversationTimelineSubAgentHeaderDisplayRow;
      readonly childSegments: readonly ConversationTimelineDisplaySegment[];
      readonly groupId: string;
      readonly expanded: boolean;
    };

export interface ConversationTimelineDisplayLocation {
  readonly rowKey: string;
  readonly parentSubAgentId?: string;
  readonly visible: boolean;
  /** View-only ancestors to reveal, outermost first. Never execution evidence. */
  readonly disclosurePath: readonly string[];
}

export interface ConversationTimelineDisplayModel {
  readonly rows: readonly ConversationTimelineDisplayRow[];
  readonly segments: readonly ConversationTimelineDisplaySegment[];
  readonly potentialRowCount: number;
  readonly locationByItemId: ReadonlyMap<string, ConversationTimelineDisplayLocation>;
}

/**
 * Builds one visible range, including batch atoms and Agent children. Groups
 * provide disclosure/ARIA structure only; every mounted fact is a root row.
 */
export function projectConversationTimelineDisplayModel(
  items: readonly ConversationTimelineItem[],
  disclosureById: ReadonlyMap<string, ConversationDisclosureState>,
  runLifecycles?: ReadonlyMap<string, TimelineRunLifecycle>,
): ConversationTimelineDisplayModel {
  const rows: ConversationTimelineDisplayRow[] = [];
  const segments: ConversationTimelineDisplaySegment[] = [];
  const locationByItemId = new Map<string, ConversationTimelineDisplayLocation>();
  let potentialRowCount = 0;

  interface ParentAgent {
    readonly item: ConversationTimelineSubAgentItem;
    readonly groupId: string;
    readonly childCount: number;
    childIndex: number;
  }

  const projectItem = (
    item: ConversationTimelineItem,
    visible: boolean,
    disclosurePath: readonly string[],
    parent?: ParentAgent,
    parentBatchId?: string,
  ): ConversationTimelineDisplaySegment => {
    const visibleItem = item.kind === "subAgentActivity" ? nestedDepthExceededDiagnostic(item) : item;
    const batch = visibleItem.kind === "commandBatch" || visibleItem.kind === "explorationBatch" ? visibleItem : undefined;
    const batchDisclosure = batch ? {
      id: batch.batch.id,
      groupId: `conversation-batch-detail-${encodeURIComponent(batch.id)}`,
      expanded: resolveDisclosureExpanded(batch.batch.id, batch.batch.revisionKey, batch.batch.defaultExpanded, disclosureById),
    } : undefined;
    const base = {
      rowKey: displayRowKey(visibleItem, parent ? 1 : 0, parent?.item.id),
      item: visibleItem,
      ...(parentBatchId ? { parentBatchId } : {}),
      ...(batchDisclosure ? { batchDisclosure } : {}),
    };
    const row: ConversationTimelineItemDisplayRow | ConversationTimelineSubAgentChildDisplayRow = parent ? {
      ...base, kind: "subAgentChild", depth: 1, parentSubAgentId: parent.item.id,
      parentLabel: parent.item.label, groupId: parent.groupId,
      childIndex: parent.childIndex, childCount: parent.childCount,
    } : { ...base, kind: "item", depth: 0 };
    if (visible) {
      rows.push(row);
      if (parent) parent.childIndex += 1;
    }
    potentialRowCount += 1;
    registerLocation(locationByItemId, item.id, row.rowKey, visible, parent?.item.id, disclosurePath);
    if (visibleItem.id !== item.id) {
      registerLocation(locationByItemId, visibleItem.id, row.rowKey, visible, parent?.item.id, disclosurePath);
    }
    if (!batch || !batchDisclosure) return { kind: "row", row };
    const childSegments = batchChildren(batch).map((child) => projectItem(
      child, visible && batchDisclosure.expanded, [...disclosurePath, batchDisclosure.id], parent, batch.id,
    ));
    return { kind: "batchGroup", headerRow: row, childSegments,
      groupId: batchDisclosure.groupId, expanded: batchDisclosure.expanded };
  };

  const projectScope = (sections: readonly TimelineProcessSection[], visible: boolean, path: readonly string[], parent?: ParentAgent): ConversationTimelineDisplaySegment[] =>
    sections.map(section => {
      if (section.kind === "item") return projectItem(section.item, visible, path, parent);
      const process = section.group;
      const expanded = process.mustExpand || resolveDisclosureExpanded(process.id, process.revisionKey, process.defaultExpanded, disclosureById);
      const groupId = `conversation-process-detail-${encodeURIComponent(process.id)}`;
      const headerRow: ConversationTimelineProcessHeaderDisplayRow = {
        kind: "processHeader", item: process.items[0]!, process, expanded, groupId,
        rowKey: process.id, depth: parent ? 1 : 0, parentSubAgentId: parent?.item.id,
      };
      if (visible) rows.push(headerRow);
      potentialRowCount += 1;
      const childSegments = process.items.map(item => projectItem(item, visible && expanded, [...path, process.id], parent));
      return { kind: "processGroup", headerRow, groupId, expanded, childSegments };
    });

  for (const section of projectTimelineProcessSections(items, "root", runLifecycles)) {
    if (section.kind === "process") {
      segments.push(...projectScope([section], true, []));
      continue;
    }
    const item = section.item;
    if (item.kind !== "subAgentActivity") {
      segments.push(projectItem(item, true, []));
      continue;
    }

    const groupId = conversationTimelineSubAgentGroupId(item.id);
    const expanded = item.childItems.length > 0 && resolveSubAgentExpanded(item, disclosureById);
    const headerRow: ConversationTimelineSubAgentHeaderDisplayRow = {
      kind: "subAgentHeader",
      rowKey: displayRowKey(item, 0),
      item,
      depth: 0,
      groupId,
      expanded,
    };
    rows.push(headerRow);
    const childSections = projectTimelineProcessSections(item.childItems, item.id, runLifecycles);
    const parent: ParentAgent = { item, groupId, childIndex: 0,
      childCount: childSections.reduce((count, section) => count + (section.kind === "item"
        ? visibleItemCount(section.item, disclosureById)
        : section.group.mustExpand || resolveDisclosureExpanded(section.group.id, section.group.revisionKey, section.group.defaultExpanded, disclosureById)
          ? section.group.items.reduce((sum, child) => sum + visibleItemCount(child, disclosureById), 0) : 0), 0) };
    const childSegments = projectScope(childSections, expanded, [conversationTimelineSubAgentDisclosureKey(item.id)], parent);
    segments.push({ kind: "subAgentGroup", item, headerRow, childSegments, groupId, expanded });
    potentialRowCount += 1;
    registerLocation(locationByItemId, item.id, headerRow.rowKey, true);
  }

  return { rows, segments, potentialRowCount, locationByItemId };
}

export function conversationTimelineSubAgentGroupId(itemId: string): string {
  return `conversation-sub-agent-detail-${encodeURIComponent(itemId)}`;
}

function resolveSubAgentExpanded(
  item: ConversationTimelineSubAgentItem,
  disclosureById: ReadonlyMap<string, ConversationDisclosureState>,
): boolean {
  return resolveDisclosureExpanded(conversationTimelineSubAgentDisclosureKey(item.id),
    String(item.revision), shouldDefaultExpandConversationTimelineSubAgent(item), disclosureById) ||
    item.childItems.some(timelineItemNeedsVisibleAttention);
}

function resolveDisclosureExpanded(
  id: string,
  revisionKey: string,
  defaultExpanded: boolean,
  disclosureById: ReadonlyMap<string, ConversationDisclosureState>,
): boolean {
  const current = disclosureById.get(id);
  if (current?.revisionKey === revisionKey || current?.touched) {
    return current.expanded;
  }
  return defaultExpanded;
}

function batchChildren(item: Extract<ConversationTimelineItem, { kind: "commandBatch" | "explorationBatch" }>): readonly ConversationTimelineItem[] {
  return item.kind === "commandBatch"
    ? item.batch.commands.flatMap((command) => [...(command.leadingItems ?? []), command])
    : item.batch.children;
}

function visibleItemCount(item: ConversationTimelineItem, disclosure: ReadonlyMap<string, ConversationDisclosureState>): number {
  if (item.kind !== "commandBatch" && item.kind !== "explorationBatch") return 1;
  return 1 + (resolveDisclosureExpanded(item.batch.id, item.batch.revisionKey, item.batch.defaultExpanded, disclosure)
    ? batchChildren(item).reduce((count, child) => count + visibleItemCount(child, disclosure), 0) : 0);
}

function displayRowKey(
  item: ConversationTimelineItem,
  depth: 0 | 1,
  parentSubAgentId = "root",
): string {
  return [
    "timeline-row",
    depth,
    encodeURIComponent(parentSubAgentId),
    encodeURIComponent(item.id),
    item.threadSequence,
    item.partIndex,
  ].join(":");
}

function registerLocation(
  locations: Map<string, ConversationTimelineDisplayLocation>,
  itemId: string,
  rowKey: string,
  visible: boolean,
  parentSubAgentId?: string,
  disclosurePath: readonly string[] = [],
): void {
  if (locations.has(itemId)) return;
  locations.set(itemId, {
    rowKey,
    visible,
    disclosurePath,
    ...(parentSubAgentId ? { parentSubAgentId } : {}),
  });
}

function nestedDepthExceededDiagnostic(
  item: ConversationTimelineSubAgentItem,
): ConversationTimelineDiagnosticItem {
  return {
    id: `diagnostic:nested-depth:${item.id}`,
    kind: "diagnostic",
    code: "nested_depth_exceeded",
    revision: item.revision,
    threadSequence: item.threadSequence,
    partIndex: item.partIndex,
    status: "blocked",
    turnId: item.turnId,
    itemId: item.itemId,
    ...(item.actionId ? { actionId: item.actionId } : {}),
    ...(item.runId ? { runId: item.runId } : {}),
    ...(item.attemptId ? { attemptId: item.attemptId } : {}),
    participantId: item.participantId,
    workflowStepId: item.workflowStepId,
    sourceRefs: item.sourceRefs,
    title: "Nested Agent activity unavailable",
    description: "Nested Agent activity is hidden beyond the visible depth limit.",
    summary: "Nested Agent activity is hidden beyond the visible depth limit.",
    diagnosticRef: item.sourceRefs[0],
  };
}
