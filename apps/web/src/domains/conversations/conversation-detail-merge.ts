import { isUserInputAnchor, reconcileCanonicalUserInputs } from "@ling-stack/conversation-ui-core";
import type {
  ConversationDetailResponse,
  ConversationItemV1,
  ConversationSupersessionTombstones,
  ConversationTranscriptMessage,
} from "../../types.js";

/**
 * Merge a fetched conversation detail into the currently displayed detail.
 *
 * Continuity history is append-only and action-like records are revisioned. A
 * reconnect response can therefore be older than a live event already in the
 * client, or can contain only part of the newest projection while a refresh is
 * in flight. This helper keeps the union and selects the greatest durable
 * revision without using arrival order as the authority. Message edits are the
 * exception: Host-issued tombstones are also append-only, and are applied after
 * every union so stale/reordered snapshots cannot resurrect old lineage.
 * Question visibility is not append-only: its separate reconciler retains
 * only content-free tombstones after an authoritative withdrawal.
 */
export function mergeConversationDetailSnapshots(
  current: ConversationDetailResponse | undefined,
  incoming: ConversationDetailResponse,
): ConversationDetailResponse {
  if (current?.cwd !== incoming.cwd || current?.thread.id !== incoming.thread.id
    || current?.thread.workspaceId !== incoming.thread.workspaceId || current?.thread.kind !== incoming.thread.kind
    || current?.thread.teammateId !== incoming.thread.teammateId || current?.thread.channelId !== incoming.thread.channelId) current = undefined;
  const supersessionTombstones = mergeSupersessionTombstones(
    current?.supersessionTombstones,
    incoming.supersessionTombstones,
  );
  const hydration = reconcileCanonicalUserInputs({
    scope: { workspaceId: incoming.thread.workspaceId, threadId: incoming.thread.id,
      ...(incoming.thread.kind === "teammate_direct" ? { participantId: incoming.thread.teammateId ?? "" } : {}) },
    current: current ? { items: current.conversationItems, userInputs: current.userInputs } : undefined,
    incoming: { items: incoming.conversationItems, userInputs: incoming.userInputs }, mode: "full",
  });
  const conversationItems = [
    ...mergeVersioned(current?.conversationItems ?? [], incoming.conversationItems, (item) => item.id, (item) => item.revision, true)
      .filter(item => !isUserInputAnchor(item)),
    ...hydration.items,
  ].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  const merged: ConversationDetailResponse = !current ? {
    ...incoming,
    conversationItems,
    userInputs: hydration.userInputs,
    supersessionTombstones,
  } : {
    ...incoming,
    thread: newerByTimestamp(current.thread, incoming.thread, (thread) => thread.updatedAt),
    turns: mergeVersioned(current.turns, incoming.turns, (turn) => turn.id, (turn) => turn.updatedAt, true),
    conversationItems,
    userInputs: hydration.userInputs,
    supersessionTombstones,
    runLinks: mergeUnique(current.runLinks, incoming.runLinks, (link) => `${link.runId}:${link.turnId}:${link.attemptNumber}:${link.role}`),
    runs: mergeVersioned(current.runs, incoming.runs, (run) => run.id, (run) => run.updatedAt, true),
    reasoningSummaries: mergeVersioned(current.reasoningSummaries ?? [], incoming.reasoningSummaries ?? [], (summary) => summary.id, (summary) => summary.revision, true),
    executionActions: mergeVersioned(current.executionActions, incoming.executionActions, (action) => action.id, (action) => action.revision, true),
    approvals: mergeVersioned(current.approvals, incoming.approvals, (approval) => approval.id, approvalFreshness, true),
    approvalCheckpoints: mergeVersioned(current.approvalCheckpoints, incoming.approvalCheckpoints, (checkpoint) => checkpoint.id, (checkpoint) => checkpoint.revision, true),
    interventions: mergeVersioned(current.interventions, incoming.interventions, (intervention) => intervention.id, (intervention) => intervention.updatedAt, true),
    terminalReports: mergeVersioned(current.terminalReports, incoming.terminalReports, (report) => report.id, (report) => report.committedAt, true),
    artifacts: mergeVersioned(current.artifacts, incoming.artifacts, (artifact) => artifact.id, (artifact) => artifact.createdAt, true),
    ...(current.plans || incoming.plans ? { plans: mergeVersioned(current.plans ?? [], incoming.plans ?? [], (plan) => plan.id, (plan) => plan.updatedAt, true) } : {}),
    ...(current.compactionCheckpoints || incoming.compactionCheckpoints ? { compactionCheckpoints: mergeVersioned(current.compactionCheckpoints ?? [], incoming.compactionCheckpoints ?? [], (checkpoint) => checkpoint.id, (checkpoint) => checkpoint.createdAt, true) } : {}),
    ...(current.contextSnapshots || incoming.contextSnapshots ? { contextSnapshots: mergeVersioned(current.contextSnapshots ?? [], incoming.contextSnapshots ?? [], (snapshot) => snapshot.id, (snapshot) => snapshot.createdAt, true) } : {}),
    ...(current.contextSummaries || incoming.contextSummaries ? { contextSummaries: mergeVersioned(current.contextSummaries ?? [], incoming.contextSummaries ?? [], (summary) => summary.id, (summary) => summary.createdAt, true) } : {}),
    messages: mergeMessages(current.messages, incoming.messages),
    generatedMedia: mergeVersioned(current.generatedMedia, incoming.generatedMedia, (media) => media.mediaJobId, (media) => media.updatedAt, true),
  };
  return removeSupersededConversationLineage(removeReplacedToolActions(merged));
}

function removeReplacedToolActions(detail: ConversationDetailResponse): ConversationDetailResponse {
  const replacedIds = new Set(detail.executionActions.flatMap((action) =>
    action.approvalId && action.id === `approval:${action.approvalId}` && action.runId && action.toolCallId
      ? [`tool:${action.runId}:${action.toolCallId}`]
      : []));
  if (replacedIds.size === 0) return detail;
  return {
    ...detail,
    // Host replaces the provisional tool row with one approval-correlated
    // action. An append-only client union must not resurrect the old row.
    executionActions: detail.executionActions.filter((action) => !replacedIds.has(action.id)),
  };
}

function mergeSupersessionTombstones(
  current: ConversationSupersessionTombstones | undefined,
  incoming: ConversationSupersessionTombstones,
): ConversationSupersessionTombstones {
  return {
    turnIds: mergeStringSets(current?.turnIds, incoming.turnIds),
    runIds: mergeStringSets(current?.runIds, incoming.runIds),
    responseMessageIds: mergeStringSets(current?.responseMessageIds, incoming.responseMessageIds),
  };
}

function mergeStringSets(
  current: readonly string[] | undefined,
  incoming: readonly string[],
): readonly string[] {
  return [...new Set([...(current ?? []), ...incoming])].sort();
}

function removeSupersededConversationLineage(
  detail: ConversationDetailResponse,
): ConversationDetailResponse {
  const turnIds = new Set(detail.supersessionTombstones.turnIds);
  const runIds = new Set(detail.supersessionTombstones.runIds);
  const suppressedItemIds = collectSupersededItemIds(
    detail.conversationItems,
    turnIds,
    runIds,
    new Set(detail.supersessionTombstones.responseMessageIds),
  );
  const sourceIsSuperseded = (source: {
    readonly sourceTurnId?: string;
    readonly sourceRunId?: string;
    readonly sourceMessageId?: string;
  }): boolean => Boolean(
    source.sourceTurnId && turnIds.has(source.sourceTurnId)
    || source.sourceRunId && runIds.has(source.sourceRunId)
    || source.sourceMessageId && suppressedItemIds.has(source.sourceMessageId)
  );
  return {
    ...detail,
    turns: detail.turns.filter((turn) => !turnIds.has(turn.id)),
    conversationItems: detail.conversationItems.filter((item) => !suppressedItemIds.has(item.id)),
    userInputs: detail.userInputs.filter((item) => !suppressedItemIds.has(item.itemId)
      && (item.availability === "unavailable"
        || (!turnIds.has(item.source.turnId) && !runIds.has(item.source.runId)))),
    runLinks: detail.runLinks.filter((link) => !turnIds.has(link.turnId) && !runIds.has(link.runId)),
    runs: detail.runs.filter((run) => !runIds.has(run.id)),
    reasoningSummaries: (detail.reasoningSummaries ?? []).filter((summary) =>
      !turnIds.has(summary.turnId)
      && !runIds.has(summary.runId)
      && !suppressedItemIds.has(summary.anchorItemId)),
    executionActions: detail.executionActions.filter((action) => !(
      action.runId && runIds.has(action.runId)
      || refsContainSupersededLineage(action.sourceRefs, turnIds, runIds, suppressedItemIds)
    )),
    approvalCheckpoints: detail.approvalCheckpoints.filter((checkpoint) => !checkpoint.runId || !runIds.has(checkpoint.runId)),
    approvals: detail.approvals.filter((approval) => !approval.runId || !runIds.has(approval.runId)),
    interventions: detail.interventions.filter((intervention) =>
      !runIds.has(intervention.sourceRunId)
      && (!intervention.continuationRunId || !runIds.has(intervention.continuationRunId))),
    terminalReports: detail.terminalReports.filter((report) => !(
      report.turnId && turnIds.has(report.turnId)
      || report.source.kind === "turn" && turnIds.has(report.source.id)
      || report.source.kind === "run" && runIds.has(report.source.id)
      || suppressedItemIds.has(report.resultItemId)
    )),
    artifacts: detail.artifacts.filter((artifact) => !artifact.runId || !runIds.has(artifact.runId)),
    ...(detail.plans ? { plans: detail.plans.filter((plan) => !sourceIsSuperseded(plan)) } : {}),
    ...(detail.compactionCheckpoints ? {
      compactionCheckpoints: detail.compactionCheckpoints.filter((checkpoint) =>
        !turnIds.has(checkpoint.sourceTurnId)
        && !checkpoint.coveredTurnIds.some((turnId) => turnIds.has(turnId))
        && !refsContainSupersededLineage(checkpoint.sourceRefs, turnIds, runIds, suppressedItemIds)),
    } : {}),
    ...(detail.contextSnapshots ? {
      contextSnapshots: detail.contextSnapshots.filter((snapshot) =>
        !refsContainSupersededLineage(snapshot.sourceRefs, turnIds, runIds, suppressedItemIds)),
    } : {}),
    ...(detail.contextSummaries ? {
      contextSummaries: detail.contextSummaries.filter((summary) =>
        !refsContainSupersededLineage(summary.sourceRefs, turnIds, runIds, suppressedItemIds)
        && !refsContainSupersededLineage(summary.activeWorkRefs, turnIds, runIds, suppressedItemIds)),
    } : {}),
    messages: detail.messages.filter((message) => !(
      detail.supersessionTombstones.responseMessageIds.includes(message.id)
      || message.turnId && turnIds.has(message.turnId)
      || message.runId && runIds.has(message.runId)
    )),
    generatedMedia: detail.generatedMedia.filter((media) =>
      !runIds.has(media.runId) && (!media.messageId || !suppressedItemIds.has(media.messageId))),
  };
}

function collectSupersededItemIds(
  items: readonly ConversationItemV1[],
  turnIds: ReadonlySet<string>,
  runIds: ReadonlySet<string>,
  responseMessageIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const suppressed = new Set(responseMessageIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (suppressed.has(item.id)) continue;
      if (item.turnId && turnIds.has(item.turnId)
        || refsContainSupersededLineage(item.domainRefs, turnIds, runIds, suppressed)) {
        suppressed.add(item.id);
        changed = true;
      }
    }
  }
  return suppressed;
}

function refsContainSupersededLineage(
  refs: readonly { readonly type?: string; readonly kind?: string; readonly id: string }[],
  turnIds: ReadonlySet<string>,
  runIds: ReadonlySet<string>,
  itemIds: ReadonlySet<string>,
): boolean {
  return refs.some((ref) => {
    const type = ref.type ?? ref.kind;
    return type === "turn" && turnIds.has(ref.id)
      || type === "run" && runIds.has(ref.id)
      || (type === "conversation_item" || type === "message") && itemIds.has(ref.id);
  });
}

function mergeMessages(
  current: readonly ConversationTranscriptMessage[],
  incoming: readonly ConversationTranscriptMessage[],
): readonly ConversationTranscriptMessage[] {
  const merged = mergeVersioned(
    current,
    incoming,
    conversationMessageMergeKey,
    (message) => message.revision ?? message.updatedAt,
    false,
  );
  return [...merged].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function conversationMessageMergeKey(message: ConversationTranscriptMessage): string {
  return message.turnId && (message.role === "user" || message.role === "assistant")
    ? `${message.role}:${message.turnId}`
    : message.id;
}

function approvalFreshness(approval: ConversationDetailResponse["approvals"][number]): string {
  return approval.resolvedAt ?? approval.expiresAt ?? approval.createdAt;
}

function mergeVersioned<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (record: T) => string,
  freshnessOf: (record: T) => number | string | undefined,
  preserveEqualConflicts: boolean,
): readonly T[] {
  const groups = new Map<string, T[]>();
  for (const record of [...current, ...incoming]) {
    const group = groups.get(keyOf(record)) ?? [];
    group.push(record);
    groups.set(keyOf(record), group);
  }
  const output: T[] = [];
  for (const group of groups.values()) {
    const maxFreshness = Math.max(...group.map((record) => freshnessRank(freshnessOf(record))));
    const latest = group
      .filter((record) => freshnessRank(freshnessOf(record)) === maxFreshness)
      .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
    const unique = new Map(latest.map((record) => [stableSerialize(record), record]));
    output.push(...(preserveEqualConflicts ? unique.values() : [...unique.values()].slice(-1)));
  }
  return output.sort((left, right) => keyOf(left).localeCompare(keyOf(right)) || stableSerialize(left).localeCompare(stableSerialize(right)));
}

function mergeUnique<T>(current: readonly T[], incoming: readonly T[], keyOf: (record: T) => string): readonly T[] {
  const byKey = new Map<string, T>();
  for (const record of [...current, ...incoming]) {
    if (!byKey.has(keyOf(record))) byKey.set(keyOf(record), record);
  }
  return [...byKey.values()].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
}

function newerByTimestamp<T>(current: T, incoming: T, timestampOf: (record: T) => string): T {
  const currentTime = freshnessRank(timestampOf(current));
  const incomingTime = freshnessRank(timestampOf(incoming));
  if (incomingTime !== currentTime) return incomingTime > currentTime ? incoming : current;
  return stableSerialize(incoming).localeCompare(stableSerialize(current)) >= 0 ? incoming : current;
}

function freshnessRank(value: number | string | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}
