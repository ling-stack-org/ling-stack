import type {
  ChannelConversationItemDecoration,
  ChannelConversationItemPageResponse,
  ChannelConversationThread,
  ChannelConversationTurnResponse,
  ConversationDomainRef,
  ConversationItemV1,
  ConversationReasoningSummaryRecord,
  ConversationContextCompactionRecord,
  ChannelMessage,
  ConversationGeneratedMedia,
  TurnContextAssignment,
  UserInputTranscriptItemV1,
} from "@ling-stack/contracts";
import { projectConversationItemToChannelMessage } from "@ling-stack/contracts";
import {
  isUserInputAnchor,
  projectCanonicalConversationTimeline,
  reconcileCanonicalUserInputs,
  type CanonicalConversationItem,
  type CanonicalReasoningSummaryRecord,
  type CanonicalTranscriptScope,
  type ConversationTimelineItem,
} from "@ling-stack/conversation-ui-core";

export interface ChannelConversationMessagePage {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly messages: readonly ChannelMessage[];
  /** Canonical items retained for typed transcript presentation. */
  readonly conversationItems: readonly ConversationItemV1[];
  readonly turnContextAssignments: readonly TurnContextAssignment[];
  readonly userInputs?: readonly UserInputTranscriptItemV1[];
  readonly reasoningSummaries: readonly ConversationReasoningSummaryRecord[];
  readonly contextCompactions?: readonly ConversationContextCompactionRecord[];
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly hasMore: boolean;
  readonly nextBeforeSequence?: number;
}

export function projectChannelConversationItemPage(
  response: ChannelConversationItemPageResponse,
): ChannelConversationMessagePage {
  return {
    workspaceId: response.thread.workspaceId,
    threadId: response.thread.id,
    messages: projectMessageItems(response.items, response.decorations, response.thread),
    conversationItems: response.items,
    turnContextAssignments: response.turnContextAssignments,
    ...(response.userInputs !== undefined ? { userInputs: response.userInputs } : {}),
    reasoningSummaries: response.reasoningSummaries ?? [],
    contextCompactions: response.contextCompactions ?? [],
    generatedMedia: response.generatedMedia,
    hasMore: response.hasMore,
    ...(response.nextBeforeSequence !== undefined
      ? { nextBeforeSequence: response.nextBeforeSequence }
      : {}),
  };
}

/** Host cursors describe the selected raw sequence window, before visibility filtering. */
export function mergeChannelUserInputPage(
  current: ChannelConversationMessagePage | undefined,
  incoming: ChannelConversationMessagePage,
  beforeSequence?: number,
): ChannelConversationMessagePage {
  if (current?.workspaceId !== incoming.workspaceId || current?.threadId !== incoming.threadId) current = undefined;
  const hydration = reconcileCanonicalUserInputs({
    scope: incoming,
    current: current ? { items: current.conversationItems, userInputs: current.userInputs } : undefined,
    incoming: { items: incoming.conversationItems, userInputs: incoming.userInputs },
    mode: incoming.hasMore && incoming.nextBeforeSequence === undefined ? "page"
      : { fromSequence: incoming.nextBeforeSequence ?? 0, beforeSequence },
  });
  return {
    ...incoming,
    // The cache retains outside-window anchors for status comparison on paging.
    // Consumers still choose the visible window; cached hydration is not a row.
    conversationItems: [...incoming.conversationItems.filter(item => !isUserInputAnchor(item)), ...hydration.items]
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)),
    turnContextAssignments: mergeTurnContextAssignments(
      current?.turnContextAssignments ?? [],
      incoming.turnContextAssignments,
    ),
    userInputs: hydration.userInputs,
    reasoningSummaries: mergeReasoningSummaries(current?.reasoningSummaries ?? [], incoming.reasoningSummaries ?? []),
    contextCompactions: mergeContextCompactions(current?.contextCompactions ?? [], incoming.contextCompactions ?? []),
  };
}

function mergeContextCompactions(
  current: readonly ConversationContextCompactionRecord[],
  incoming: readonly ConversationContextCompactionRecord[],
): readonly ConversationContextCompactionRecord[] {
  const byId = new Map(current.map(record => [record.id, record]));
  for (const record of incoming) {
    if (record.revision > (byId.get(record.id)?.revision ?? -1)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function mergeReasoningSummaries(
  current: readonly ConversationReasoningSummaryRecord[],
  incoming: readonly ConversationReasoningSummaryRecord[],
): readonly ConversationReasoningSummaryRecord[] {
  const byId = new Map(current.map((summary) => [summary.id, summary]));
  for (const summary of incoming) {
    const existing = byId.get(summary.id);
    if (!existing || summary.revision >= existing.revision) byId.set(summary.id, summary);
  }
  return [...byId.values()].sort((left, right) =>
    left.eventSequence - right.eventSequence || left.id.localeCompare(right.id));
}

/** Latest effective assignment wins; equal/older late pages cannot move a Turn backwards. */
export function mergeTurnContextAssignments(
  current: readonly TurnContextAssignment[],
  incoming: readonly TurnContextAssignment[],
): readonly TurnContextAssignment[] {
  const byTurnId = new Map(current.map((assignment) => [assignment.turnId, assignment]));
  for (const assignment of incoming) {
    const existing = byTurnId.get(assignment.turnId);
    if (!existing || assignment.revision > existing.revision) {
      byTurnId.set(assignment.turnId, assignment);
    }
  }
  return [...byTurnId.values()].sort((left, right) =>
    left.turnId.localeCompare(right.turnId) || left.revision - right.revision
  );
}

/** Display batching consumes only committed Host assignments; provisional context stays atomic. */
export function buildCommittedContextSegmentLookup(
  items: readonly ConversationItemV1[],
  assignments: readonly TurnContextAssignment[],
): ReadonlyMap<string, string> {
  const committedByTurnId = new Map(
    mergeTurnContextAssignments([], assignments)
      .filter((assignment) => assignment.status === "committed")
      .map((assignment) => [assignment.turnId, assignment.segmentId]),
  );
  return new Map(items.flatMap((item) => {
    const segmentId = item.turnId ? committedByTurnId.get(item.turnId) : undefined;
    return segmentId ? [[item.id, segmentId] as const] : [];
  }));
}

export function projectChannelConversationTurn(response: ChannelConversationTurnResponse): {
  readonly message: ChannelMessage;
  readonly conversationItems: readonly ConversationItemV1[];
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
  readonly replyDispatch?: ChannelConversationTurnResponse["replyDispatch"];
  readonly autoStartedWorkflow?: ChannelConversationTurnResponse["autoStartedWorkflow"];
} {
  const message = projectMessageItem(response.userItem, response.decorations, response.thread);
  const aiReplies = projectMessageItems(response.assistantItems ?? [], response.decorations, response.thread);
  return {
    message,
    conversationItems: [response.userItem, ...(response.assistantItems ?? [])],
    ...(aiReplies[0] ? { aiReply: aiReplies[0] } : {}),
    ...(aiReplies.length > 0 ? { aiReplies } : {}),
    ...(response.replyDispatch ? { replyDispatch: response.replyDispatch } : {}),
    ...(response.autoStartedWorkflow ? { autoStartedWorkflow: response.autoStartedWorkflow } : {}),
  };
}

export function mergeConversationItems(
  existingItems: readonly ConversationItemV1[],
  incomingItems: readonly ConversationItemV1[],
): readonly ConversationItemV1[] {
  if (incomingItems.length === 0) return existingItems;
  const byId = new Map(existingItems.map((item) => [item.id, item]));
  for (const item of incomingItems) {
    const existing = byId.get(item.id);
    if (existing && item.revision < existing.revision) {
      continue;
    }
    byId.set(item.id, existing
      ? { ...item, domainRefs: mergeConversationDomainRefs(existing.domainRefs, item.domainRefs) }
      : item);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

export function mergeConversationDomainRefs(
  existing: readonly ConversationDomainRef[],
  incoming: readonly ConversationDomainRef[],
): readonly ConversationDomainRef[] {
  const refs = new Map<string, ConversationDomainRef>();
  for (const ref of [...existing, ...incoming]) {
    refs.set(`${ref.type}:${ref.id}`, ref);
  }
  return [...refs.values()];
}

export function projectMessageItems(
  items: readonly ConversationItemV1[],
  decorations: readonly ChannelConversationItemDecoration[],
  thread?: ChannelConversationThread,
): readonly ChannelMessage[] {
  const decorationsByItemId = new Map(decorations.map((decoration) => [decoration.itemId, decoration]));
  return items
    .filter((item) => item.kind === "user_message" || item.kind === "assistant_message" || item.kind === "system_event")
    .map((item) => projectMessageItemWithDecoration(item, decorationsByItemId.get(item.id), thread));
}

/** Delivery readiness is not a final answer; the canonical role owns that distinction. */
export function channelNarrationItemIds(
  items: readonly ConversationItemV1[],
  scope: { readonly workspaceId?: string; readonly channelId: string; readonly threadId: string },
): ReadonlySet<string> {
  return new Set(items.filter((item) =>
    item.workspaceId === scope.workspaceId && item.channelId === scope.channelId && item.threadId === scope.threadId
    && item.kind === "assistant_message" && item.payload.presentationRole === "narration",
  ).map((item) => item.id));
}

/** Invalidate the report read model from committed Host result anchors, not prose. */
export function channelTerminalReportItemRevisionSignature(
  items: readonly ConversationItemV1[],
  channelId: string,
): string {
  return [...new Set(items.flatMap((item) => {
    if (item.channelId !== channelId || item.kind !== "terminal_report" || item.status !== "committed"
      || (item.visibility !== "channel" && item.visibility !== "thread_participants")) return [];
    const payload = item.payload;
    return [JSON.stringify([item.id, item.threadId, item.turnId, item.revision, payload.reportId,
      payload.generation, payload.sourceKind, payload.sourceId, payload.evidenceFingerprint, payload.outcomeStatus])];
  }))]
    .sort()
    .join("\n");
}

/**
 * Projects canonical envelopes that were not consumed by an ExecutionAction or
 * another Host-owned domain record. The shared projector deliberately turns
 * unverified fact envelopes into blocked diagnostics; this adapter must never
 * upgrade model/tool text into command, file, approval, or tool evidence.
 */
export function projectUncoveredChannelConversationItems(
  items: readonly ConversationItemV1[],
  surface: Extract<CanonicalTranscriptScope["surface"], "channel_root" | "topic" | "branch">,
): readonly ConversationTimelineItem[] {
  const scopedItems = items.filter((item) =>
    item.kind !== "user_message" &&
    item.kind !== "assistant_message" &&
    item.kind !== "user_input_request" &&
    item.kind !== "user_input_answer"
  );
  if (scopedItems.length === 0) return [];

  const byScope = new Map<string, ConversationItemV1[]>();
  for (const item of scopedItems) {
    const key = JSON.stringify([item.workspaceId, item.threadId]);
    byScope.set(key, [...(byScope.get(key) ?? []), item]);
  }

  return [...byScope.values()].flatMap((group) => {
    const first = group[0]!;
    const sourceSequence = group.reduce((max, item) => Math.max(max, item.sequence), 0);
    return projectCanonicalConversationTimeline({
      scope: {
        surface,
        workspaceId: first.workspaceId,
        threadId: first.threadId,
        depth: 0,
      },
      items: group,
      actions: [],
      turnRuns: [],
      sourceSequence,
      sourceRevision: group
        .map((item) => `${item.id}:${item.revision}`)
        .sort()
        .join("|"),
    }).items;
  });
}

/** Project safe summaries and Host compaction facts; message/action rendering stays owned by the channel feed. */
export function projectChannelReasoningSummaryItems(
  items: readonly ConversationItemV1[],
  summaries: readonly ConversationReasoningSummaryRecord[],
  surface: Extract<CanonicalTranscriptScope["surface"], "channel_root" | "topic" | "branch">,
  compactions: readonly ConversationContextCompactionRecord[] = [],
): readonly ConversationTimelineItem[] {
  const first = items[0];
  if (!first || summaries.length === 0 && compactions.length === 0) return [];
  const scopedItems = items
    .filter((item) => item.workspaceId === first.workspaceId && item.threadId === first.threadId)
    .map(toCanonicalChannelItem);
  const scopedSummaries: CanonicalReasoningSummaryRecord[] = summaries
    .filter((summary) => summary.workspaceId === first.workspaceId && summary.threadId === first.threadId)
    .map((summary) => ({ ...summary, sourceRefs: summary.sourceRefs.map((ref) => ({ ...ref })) }));
  const scopedCompactions = compactions.filter(record => record.workspaceId === first.workspaceId && record.threadId === first.threadId);
  if (scopedSummaries.length === 0 && scopedCompactions.length === 0) return [];
  return projectCanonicalConversationTimeline({
    scope: {
      surface,
      workspaceId: first.workspaceId,
      threadId: first.threadId,
      depth: 0,
    },
    items: scopedItems,
    actions: [],
    reasoningSummaries: scopedSummaries,
    compactions: scopedCompactions,
    turnRuns: [],
    sourceSequence: scopedItems.reduce((max, item) => Math.max(max, item.sequence), 0),
    sourceRevision: [...scopedSummaries, ...scopedCompactions]
      .map((summary) => `${summary.id}:${summary.revision}`)
      .sort()
      .join("|"),
  }).items.filter((item) => item.kind === "reasoning" || item.kind === "contextCompaction");
}

function toCanonicalChannelItem(item: ConversationItemV1): CanonicalConversationItem {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    threadId: item.threadId,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    sequence: item.sequence,
    kind: item.kind,
    revision: item.revision,
    status: item.status,
    actorType: item.actorType,
    actorId: item.actorId,
    payload: item.payload,
    domainRefs: item.domainRefs,
  };
}

export function projectMessageItem(
  item: ConversationItemV1,
  decorations: readonly ChannelConversationItemDecoration[],
  thread?: ChannelConversationThread,
): ChannelMessage {
  return projectMessageItemWithDecoration(
    item,
    decorations.find((candidate) => candidate.itemId === item.id),
    thread,
  );
}

function projectMessageItemWithDecoration(
  item: ConversationItemV1,
  decoration: ChannelConversationItemDecoration | undefined,
  thread?: ChannelConversationThread,
): ChannelMessage {
  const message = projectConversationItemToChannelMessage(item, {
    linkedRunId: decoration?.linkedRunId,
  });
  return {
    ...message,
    ...(thread ? {
      threadSurfaceKind: thread.surfaceKind,
      threadRelationKind: thread.relationKind,
      ...(thread.anchorItemId ? { threadAnchorItemId: thread.anchorItemId } : {}),
    } : {}),
    ...(decoration?.editedAt ? { editedAt: decoration.editedAt } : {}),
    ...(decoration?.pendingReplacement ? { pendingReplacement: decoration.pendingReplacement } : {}),
    ...(decoration?.webEvidence ? { webEvidence: decoration.webEvidence } : {}),
  };
}
