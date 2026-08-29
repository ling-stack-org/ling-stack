import type { ConversationDetailResponse, ConversationTranscriptMessage, LingThread } from "../../types.js";

/**
 * Merge a fetched conversation detail into the currently displayed detail.
 *
 * Continuity history is append-only and action-like records are revisioned. A
 * reconnect response can therefore be older than a live event already in the
 * client, or can contain only part of the newest projection while a refresh is
 * in flight. This helper keeps the union and selects the greatest durable
 * revision without using arrival order as the authority.
 */
export function mergeConversationDetailSnapshots(
  current: ConversationDetailResponse | undefined,
  incoming: ConversationDetailResponse,
): ConversationDetailResponse {
  if (!current || current.thread.id !== incoming.thread.id) return incoming;

  return {
    ...incoming,
    thread: newerByTimestamp(current.thread, incoming.thread, (thread) => thread.updatedAt),
    turns: mergeVersioned(current.turns, incoming.turns, (turn) => turn.id, (turn) => turn.updatedAt, true),
    conversationItems: mergeVersioned(current.conversationItems, incoming.conversationItems, (item) => item.id, (item) => item.revision, true),
    runLinks: mergeUnique(current.runLinks, incoming.runLinks, (link) => `${link.runId}:${link.turnId}:${link.attemptNumber}:${link.role}`),
    runs: mergeVersioned(current.runs, incoming.runs, (run) => run.id, (run) => run.updatedAt, true),
    executionActions: mergeVersioned(current.executionActions, incoming.executionActions, (action) => action.id, (action) => action.revision, true),
    approvals: mergeVersioned(current.approvals, incoming.approvals, (approval) => approval.id, approvalFreshness, true),
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
