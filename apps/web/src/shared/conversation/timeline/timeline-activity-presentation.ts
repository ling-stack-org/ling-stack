import type { ConversationTimelineItem } from "@ling-stack/conversation-ui-core";
import { timelineActivityDisclosureKey, timelineProcessScopeKey } from "./conversation-timeline-view-retain-keys.js";
import type { TimelineProcessSection } from "./timeline-process-presentation.js";

function atoms(item: ConversationTimelineItem): readonly ConversationTimelineItem[] {
  if (item.kind === "commandBatch") return item.batch.commands;
  if (item.kind === "explorationBatch") return item.batch.children;
  return [item];
}

function eligible(item: ConversationTimelineItem): boolean {
  if (item.kind === "commandBatch") return item.batch.commands.length > 0
    && item.batch.commands.every(command => !command.leadingItems?.length && eligible(command));
  if (item.kind === "explorationBatch") return item.batch.children.length > 0 && item.batch.children.every(eligible);
  if (item.status !== "succeeded" || !item.actionId || item.approvalId || !timelineProcessScopeKey(item)) return false;
  if (item.kind === "commandExecution") return item.risk === "low" && item.exitCode === 0;
  return ["exploration", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.kind);
}

function operationScope(item: ConversationTimelineItem, segments?: ReadonlyMap<string, string>): string | undefined {
  const canonicalId = item.itemId ?? item.sourceRefs.find(ref => ref.kind === "conversation_item")?.id;
  const segment = (canonicalId ? segments?.get(canonicalId) : undefined) ?? segments?.get(item.id);
  const scope = timelineProcessScopeKey(item);
  return segment && scope ? JSON.stringify([scope, item.workUnitId ?? null, item.turnRunRole ?? null, segment]) : undefined;
}

/** Reversible view grouping of consecutive settled operations. Live/unknown facts stay visible. */
export function projectTimelineActivitySections(
  items: readonly ConversationTimelineItem[], parentId = "root", contextSegments?: ReadonlyMap<string, string>,
): readonly TimelineProcessSection[] {
  const sections: TimelineProcessSection[] = [];
  let pending: ConversationTimelineItem[] = [];
  let pendingAtoms: ConversationTimelineItem[] = [];
  let pendingScope: string | undefined;
  const flush = (): void => {
    const actions = new Set(pendingAtoms.map(item => item.actionId));
    if (pending.length > 1 && actions.size > 1) {
      sections.push({ kind: "process", group: {
        id: timelineActivityDisclosureKey(pending[0]!, parentId)!, presentation: "activity",
        revisionKey: pendingAtoms.map(item => `${item.id}:${item.revision}`).join("|"),
        items: pendingAtoms, wrappedItemIds: pending.filter(item => item.kind === "commandBatch" || item.kind === "explorationBatch").map(item => item.id),
        status: "completed", mustExpand: false, defaultExpanded: false,
      } });
    } else sections.push(...pending.map(item => ({ kind: "item" as const, item })));
    pending = [];
    pendingAtoms = [];
    pendingScope = undefined;
  };
  for (const item of items) {
    const children = atoms(item);
    const key = eligible(item) && children.length ? operationScope(children[0]!, contextSegments) : undefined;
    const sameScope = Boolean(key && children.every(child => operationScope(child, contextSegments) === key));
    const previous = pendingAtoms.at(-1), next = children[0]!;
    const adjacent = !previous || next && (next.threadSequence === previous.threadSequence && next.partIndex === previous.partIndex + 1
      || next.threadSequence === previous.threadSequence + 1 && next.partIndex === 1);
    if (!sameScope || pendingScope && pendingScope !== key || !adjacent) flush();
    if (sameScope) { pendingScope = key; pending.push(item); pendingAtoms.push(...children); }
    else sections.push({ kind: "item", item });
  }
  flush();
  return sections;
}
