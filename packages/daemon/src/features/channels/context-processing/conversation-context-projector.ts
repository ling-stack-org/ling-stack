import { createHash } from "node:crypto";
import type {
  ContextSegment,
  ConversationContextSnapshot,
  ConversationContextProjectionMetadata,
  ConversationContextSummary,
  ConversationDomainRef,
  ConversationItemV1,
  TurnContextAssignment,
} from "@ling-stack/contracts";
import {
  projectConversationItemToChannelMessage,
  type ChannelMessage,
  type RunStore,
} from "@ling-stack/core";

export const CONVERSATION_CONTEXT_PROJECTOR_POLICY_VERSION = "continuity-v2-projector-v1";

export type ConversationContextProjectionView =
  | "selector"
  | "reply"
  | "resolver"
  | "proposal"
  | "workflow_step"
  | "specialist"
  | "inspect";

export interface BuildConversationContextProjectionInput {
  readonly store: RunStore;
  readonly sourceItemId: string;
  readonly view: ConversationContextProjectionView;
  readonly consumerTeammateId?: string;
  readonly maxTailTextChars?: number;
  readonly explicitItemIds?: readonly string[];
  /**
   * Include the other committed Items from the source Turn as explicit context.
   * Normal user-facing projections keep this enabled so a topic can inherit a
   * complete source Turn. Agent-result freshness checks disable it because
   * result Items are produced after the agent consumed its input projection and
   * must not make that input appear stale.
   */
  readonly includeSourceTurnItems?: boolean;
}

export interface ConversationContextProjection {
  readonly metadata: ConversationContextProjectionMetadata;
  readonly segment: ContextSegment;
  readonly assignment: TurnContextAssignment;
  readonly forkSnapshot?: ConversationContextSnapshot;
  readonly summaries: readonly ConversationContextSummary[];
  readonly items: readonly ConversationItemV1[];
  readonly sharedCore: {
    readonly objectives: readonly string[];
    readonly decisions: readonly string[];
    readonly constraints: readonly string[];
    readonly openQuestions: readonly string[];
    readonly activeWorkRefs: readonly ConversationDomainRef[];
  };
}

export function buildConversationContextProjection(
  input: BuildConversationContextProjectionInput,
): ConversationContextProjection {
  const sourceItem = input.store.getEffectiveConversationItem(input.sourceItemId);
  if (!sourceItem?.turnId || sourceItem.status !== "committed") {
    throw new Error(`Conversation projection source must be a committed turn item: ${input.sourceItemId}`);
  }
  const thread = input.store.getLingThread(sourceItem.threadId);
  if (!thread || thread.archivedAt || thread.status === "archived") {
    throw new Error(`Conversation projection thread is not active: ${sourceItem.threadId}`);
  }
  const forkSnapshot = thread.forkContextSnapshotId
    ? input.store.getConversationContextSnapshot(thread.forkContextSnapshotId)
    : undefined;
  if (thread.forkContextSnapshotId && !forkSnapshot) {
    throw new Error(`Conversation projection fork snapshot is missing: ${thread.forkContextSnapshotId}`);
  }
  const assignment = input.store.getEffectiveTurnContextAssignment(sourceItem.turnId);
  if (!assignment) {
    throw new Error(`Conversation projection turn has no context assignment: ${sourceItem.turnId}`);
  }
  const segment = input.store.getContextSegment(assignment.segmentId);
  if (!segment || segment.threadId !== sourceItem.threadId || segment.state === "archived" || segment.state === "merged") {
    throw new Error(`Conversation projection assignment references an unavailable segment: ${assignment.segmentId}`);
  }

  const inheritedSummaries = forkSnapshot
    ? forkSnapshot.summaryIds.map((summaryId) => {
        const summary = input.store.getConversationContextSummary(summaryId);
        if (!summary) throw new Error(`Conversation projection fork summary is missing: ${summaryId}`);
        return { ...summary, status: "active" as const };
      })
    : [];
  const summaries = uniqueSummaries([
    ...inheritedSummaries,
    ...effectiveProjectionSummaries(input.store, sourceItem, segment.id),
  ]);
  assertProjectionSummarySourceRefsVisible({
    store: input.store,
    sourceItem,
    summaries,
    view: input.view,
    consumerTeammateId: input.consumerTeammateId,
    inheritedSummaryIds: new Set(inheritedSummaries.map((summary) => summary.id)),
  });
  const coveredThroughSequence = summaries
    .filter((summary) => summary.segmentId === segment.id && summary.scope === "segment")
    .reduce((maximum, summary) => Math.max(maximum, summary.coveredThroughSequence), 0);
  const tail = input.store.listConversationItemsForSegment({
    threadId: sourceItem.threadId,
    segmentId: segment.id,
    throughSequence: sourceItem.sequence,
    afterSequence: Math.min(coveredThroughSequence, sourceItem.sequence),
    limit: 500,
  });
  const explicitItemIds = explicitProjectionItemIds(
    sourceItem,
    assignment,
    thread.anchorItemId,
    input.explicitItemIds,
  );
  const explicitItems = explicitItemIds.map((itemId) => {
    const item = input.store.getEffectiveConversationItem(itemId);
    if (!item || item.status !== "committed") {
      throw new Error(`Conversation projection source ref is missing or stale: ${itemId}`);
    }
    if (!canProjectItem(item, input.view, input.consumerTeammateId)) {
      throw new Error(`Conversation projection source ref is not visible to this consumer: ${itemId}`);
    }
    return item;
  });
  const explicitTurnItems = input.includeSourceTurnItems === false
    ? []
    : uniqueItems(explicitItems.flatMap((item) =>
      item.turnId ? input.store.listConversationItemsForTurn({ turnId: item.turnId }) : [item]))
    .filter((item) => canProjectItem(item, input.view, input.consumerTeammateId));
  const explicitTurnItemIds = new Set(explicitTurnItems.map((item) => item.id));
  const inheritedItems = forkSnapshot
    ? forkSnapshot.sourceRefs
        .filter((ref) => ref.type === "conversation_item" || ref.type === "message")
        .map((ref) => {
          const item = input.store.getConversationItem(ref.id);
          if (!item || item.status !== "committed") {
            throw new Error(`Conversation projection fork item is missing: ${ref.id}`);
          }
          if (!canProjectItem(item, input.view, input.consumerTeammateId)) {
            throw new Error(`Conversation projection fork item is not visible to this consumer: ${ref.id}`);
          }
          return item;
        })
    : [];
  const historicalGuidanceItemIds = historicalRunGuidanceItemIds(input.store);
  const visibleItems = uniqueItems([...inheritedItems, ...tail, ...explicitItems, ...explicitTurnItems, sourceItem])
    .filter((item) => item.id === sourceItem.id || !historicalGuidanceItemIds.has(item.id))
    .filter((item) => canProjectItem(item, input.view, input.consumerTeammateId))
    .filter((item) =>
      item.sequence <= sourceItem.sequence
      || explicitItemIds.includes(item.id)
      || explicitTurnItemIds.has(item.id));
  const items = trimProjectionItemsByTextBudget(
    visibleItems,
    sourceItem.id,
    input.maxTailTextChars ?? 32_768,
  );
  const visibilityFingerprint = fingerprint({
    scope: projectionVisibilityScope(input.view, input.consumerTeammateId),
    forkSnapshotId: forkSnapshot?.id ?? null,
    visibleItemScopes: items.map((item) => [item.id, item.visibility, item.visibilityOwnerId ?? null]),
  });
  const sourceRefs = uniqueDomainRefs([
    { type: "thread", id: thread.id },
    { type: "turn", id: sourceItem.turnId },
    { type: "conversation_item", id: sourceItem.id },
    ...(forkSnapshot ? [{ type: "context_snapshot" as const, id: forkSnapshot.id }] : []),
    ...assignment.evidenceRefs,
    ...summaries.flatMap((summary) => [
      { type: "context_summary" as const, id: summary.id },
      ...summary.sourceRefs,
    ]),
    ...items.flatMap((item) => item.domainRefs),
    ...items.map((item) => ({ type: "conversation_item" as const, id: item.id })),
  ]);
  const sourceStateFingerprint = fingerprint({
    assignment: {
      id: assignment.id,
      revision: assignment.revision,
      status: assignment.status,
      evidenceRefs: assignment.evidenceRefs,
    },
    summaries: summaries.map((summary) => ({
      id: summary.id,
      version: summary.version,
      status: inheritedSummaries.some((inherited) => inherited.id === summary.id) ? "snapshot" : summary.status,
      coveredFromSequence: summary.coveredFromSequence,
      coveredThroughSequence: summary.coveredThroughSequence,
      sourceRefs: summary.sourceRefs,
    })),
    items: items.map((item) => ({
      id: item.id,
      revision: item.revision,
      status: item.status,
      visibility: item.visibility,
      visibilityOwnerId: item.visibilityOwnerId ?? null,
      supersedesItemId: item.supersedesItemId ?? null,
      domainRefs: item.domainRefs,
      updatedAt: item.updatedAt,
    })),
  });
  const projectionVersion = fingerprint({
    policyVersion: CONVERSATION_CONTEXT_PROJECTOR_POLICY_VERSION,
    thread: {
      id: thread.id,
      surfaceKind: thread.surfaceKind,
      relationKind: thread.relationKind,
      anchorItemId: thread.anchorItemId ?? null,
      forkContextSnapshotId: thread.forkContextSnapshotId ?? null,
    },
    turnId: sourceItem.turnId,
    segment: { id: segment.id, revision: segment.revision },
    assignment: { id: assignment.id, revision: assignment.revision },
    summaries: summaries.map((summary) => [
      summary.id,
      summary.version,
      inheritedSummaries.some((inherited) => inherited.id === summary.id) ? "snapshot" : summary.status,
    ]),
    throughItemSequence: sourceItem.sequence,
    visibilityFingerprint,
    sourceStateFingerprint,
  });
  return {
    metadata: {
      projectionVersion,
      sourceStateFingerprint,
      threadId: thread.id,
      turnId: sourceItem.turnId,
      segmentId: segment.id,
      throughItemSequence: sourceItem.sequence,
      summaryIds: summaries.map((summary) => summary.id),
      sourceRefs,
      policyVersion: CONVERSATION_CONTEXT_PROJECTOR_POLICY_VERSION,
      visibilityFingerprint,
    },
    segment,
    assignment,
    ...(forkSnapshot ? { forkSnapshot } : {}),
    summaries,
    items,
    sharedCore: {
      objectives: uniqueStrings(summaries.flatMap((summary) => summary.objective ? [summary.objective] : [])),
      decisions: uniqueStrings(summaries.flatMap((summary) => summary.decisions)),
      constraints: uniqueStrings(summaries.flatMap((summary) => summary.constraints)),
      openQuestions: uniqueStrings(summaries.flatMap((summary) => summary.openQuestions)),
      activeWorkRefs: uniqueDomainRefs([
        ...summaries.flatMap((summary) => summary.activeWorkRefs),
        ...items.flatMap((item) => item.domainRefs.filter(isActiveWorkRef)),
      ]),
    },
  };
}

export function projectConversationContextMessages(
  projection: ConversationContextProjection,
  store: Pick<RunStore, "getLingTurn">,
): readonly ChannelMessage[] {
  return projection.items
    .filter((item) => item.channelId && (item.kind === "user_message" || item.kind === "assistant_message" || item.kind === "system_event"))
    .map((item) => {
      const turn = item.turnId ? store.getLingTurn(item.turnId) : undefined;
      return projectConversationItemToChannelMessage(item, {
        linkedRunId: turn?.activeRunId ?? turn?.lastRunId,
      });
    });
}

function effectiveProjectionSummaries(
  store: RunStore,
  sourceItem: ConversationItemV1,
  segmentId: string,
): readonly ConversationContextSummary[] {
  const candidates = store.listConversationContextSummaries({
    threadId: sourceItem.threadId,
    statuses: ["active"],
    throughSequence: sourceItem.sequence,
    limit: 200,
  }).filter((summary) => summary.segmentId === segmentId || summary.segmentId === undefined);
  const byScope = new Map<string, ConversationContextSummary>();
  for (const summary of candidates) {
    const key = `${summary.scope}:${summary.segmentId ?? "thread"}`;
    const current = byScope.get(key);
    if (!current
      || summary.coveredThroughSequence > current.coveredThroughSequence
      || (summary.coveredThroughSequence === current.coveredThroughSequence && summary.version > current.version)) {
      byScope.set(key, summary);
    }
  }
  return [...byScope.values()].sort((left, right) =>
    left.coveredThroughSequence - right.coveredThroughSequence
    || left.version - right.version
    || left.id.localeCompare(right.id));
}

function assertProjectionSummarySourceRefsVisible(input: {
  readonly store: RunStore;
  readonly sourceItem: ConversationItemV1;
  readonly summaries: readonly ConversationContextSummary[];
  readonly view: ConversationContextProjectionView;
  readonly consumerTeammateId?: string;
  readonly inheritedSummaryIds: ReadonlySet<string>;
}): void {
  for (const summary of input.summaries) {
    for (const ref of summary.sourceRefs) {
    if (ref.type === "conversation_item" || ref.type === "message") {
      const item = input.inheritedSummaryIds.has(summary.id)
        ? input.store.getConversationItem(ref.id)
        : input.store.getEffectiveConversationItem(ref.id);
      if (!item || item.status !== "committed") {
        throw new Error(`Conversation projection summary source ref is missing or stale: ${ref.type}:${ref.id}`);
      }
      if (!canProjectItem(item, input.view, input.consumerTeammateId)) {
        throw new Error(`Conversation projection summary source ref is not visible to this consumer: ${ref.type}:${ref.id}`);
      }
      continue;
    }
    if (ref.type !== "memory") {
      continue;
    }
    const memory = input.store.getMemoryObject(ref.id);
    if (!memory || !memory.enabled || memory.reviewState !== "active") {
      throw new Error(`Conversation projection summary memory ref is missing or inactive: ${ref.id}`);
    }
    if (memory.sensitivity === "secret-adjacent") {
      throw new Error(`Conversation projection summary memory ref is secret-adjacent: ${ref.id}`);
    }
    if (memory.sensitivity === "private") {
      const matchingPrivateConsumer = (input.view === "workflow_step" || input.view === "specialist")
        && Boolean(input.consumerTeammateId)
        && memory.scopeType === "teammate"
        && memory.ownerId === input.consumerTeammateId;
      if (!matchingPrivateConsumer) {
        throw new Error(`Conversation projection summary memory ref is private to another consumer: ${ref.id}`);
      }
    }
    if (memory.scopeType === "channel" && memory.ownerId !== input.sourceItem.channelId) {
      throw new Error(`Conversation projection summary memory ref belongs to another channel: ${ref.id}`);
    }
    }
  }
}

function explicitProjectionItemIds(
  sourceItem: ConversationItemV1,
  assignment: TurnContextAssignment,
  anchorItemId: string | undefined,
  additional: readonly string[] | undefined,
): string[] {
  return uniqueStrings([
    anchorItemId,
    ...(sourceItem.kind === "user_message"
      ? [sourceItem.payload.replyToItemId, ...(sourceItem.payload.quotedItemIds ?? [])]
      : []),
    ...sourceItem.domainRefs.filter((ref) => ref.type === "conversation_item").map((ref) => ref.id),
    ...assignment.evidenceRefs.filter((ref) => ref.type === "conversation_item").map((ref) => ref.id),
    ...(additional ?? []),
  ].filter((id): id is string => Boolean(id)));
}

function isActiveWorkRef(ref: ConversationDomainRef): boolean {
  return ref.type === "run"
    || ref.type === "task"
    || ref.type === "workflow"
    || ref.type === "workflow_step"
    || ref.type === "approval"
    || ref.type === "artifact"
    || ref.type === "handoff"
    || ref.type === "operation"
    || ref.type === "external_work"
    || ref.type === "automation";
}

function historicalRunGuidanceItemIds(store: RunStore): ReadonlySet<string> {
  const itemIds = new Set<string>();
  for (const intervention of store.listRunInterventions({ limit: 500 })) {
    const prefix = "channel_message:";
    const suffix = ":queue_followup";
    if (intervention.idempotencyKey.startsWith(prefix) && intervention.idempotencyKey.endsWith(suffix)) {
      const itemId = intervention.idempotencyKey.slice(prefix.length, -suffix.length);
      if (itemId) itemIds.add(itemId);
    }
  }
  return itemIds;
}

function canProjectItem(
  item: ConversationItemV1,
  view: ConversationContextProjectionView,
  consumerTeammateId: string | undefined,
): boolean {
  if (item.visibility === "channel" || item.visibility === "thread_participants") return true;
  if (item.visibility === "operator") return view === "inspect";
  return item.visibility === "agent_private"
    && Boolean(consumerTeammateId)
    && item.visibilityOwnerId === consumerTeammateId
    && (view === "specialist" || view === "workflow_step" || view === "inspect");
}

function projectionVisibilityScope(
  view: ConversationContextProjectionView,
  consumerTeammateId: string | undefined,
): string {
  if (view === "workflow_step" || view === "specialist") {
    return `role:${consumerTeammateId ?? "unassigned"}`;
  }
  return view === "inspect" ? "operator" : "channel_shared";
}

function trimProjectionItemsByTextBudget(
  items: readonly ConversationItemV1[],
  sourceItemId: string,
  maxTextChars: number,
): readonly ConversationItemV1[] {
  const safeMax = Math.min(Math.max(Math.floor(maxTextChars), 1_024), 256_000);
  const selected: ConversationItemV1[] = [];
  let used = 0;
  const sourceThreadId = items.find((item) => item.id === sourceItemId)?.threadId;
  const ordered = [...items].sort((left, right) => {
    const leftCurrent = left.threadId === sourceThreadId ? 1 : 0;
    const rightCurrent = right.threadId === sourceThreadId ? 1 : 0;
    return leftCurrent - rightCurrent
      || left.sequence - right.sequence
      || left.id.localeCompare(right.id);
  });
  for (const item of [...ordered].reverse()) {
    const size = projectionItemText(item).length;
    if (item.id !== sourceItemId && selected.length > 0 && used + size > safeMax) continue;
    selected.push(item);
    used += size;
  }
  return selected.reverse();
}

function projectionItemText(item: ConversationItemV1): string {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
      return item.payload.body;
    case "tool_call":
      return item.payload.inputSummary ?? item.payload.title ?? item.payload.toolName;
    case "tool_result":
      return item.payload.outputSummary ?? item.payload.errorCode ?? item.payload.status;
    case "approval_request":
      return item.payload.summary ?? item.payload.title;
    case "approval_decision":
      return item.payload.reason ?? item.payload.decision;
    case "handoff":
      return item.payload.summary;
    case "operation_state":
      return item.payload.summary ?? item.payload.title;
    case "artifact_ref":
      return item.payload.title ?? item.payload.artifactId;
    case "terminal_report":
      return item.payload.outcomeStatus;
    case "system_event":
      return item.payload.summary;
  }
}

function uniqueItems(items: readonly ConversationItemV1[]): ConversationItemV1[] {
  const byId = new Map<string, ConversationItemV1>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()];
}

function uniqueSummaries(
  summaries: readonly ConversationContextSummary[],
): ConversationContextSummary[] {
  const byId = new Map<string, ConversationContextSummary>();
  for (const summary of summaries) byId.set(summary.id, summary);
  return [...byId.values()];
}

function uniqueDomainRefs(refs: readonly ConversationDomainRef[]): ConversationDomainRef[] {
  const byKey = new Map<string, ConversationDomainRef>();
  for (const ref of refs) byKey.set(`${ref.type}:${ref.id}`, ref);
  return [...byKey.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function fingerprint(value: unknown): string {
  return `ctxv2_${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
