import type { CanonicalConversationItem, CanonicalTranscriptScope, CanonicalTurnRunLink } from "./canonical-transcript-projector.js";
import type { ConversationTimelineMessageItem } from "./transcript-item.js";
import { projectConversationRunNarration, type ConversationRunNarrationSegment } from "./run-narration.js";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function hasCommittedRunNarration(item: CanonicalConversationItem): boolean {
  return item.kind === "assistant_message" && record(item.payload) && item.payload.runNarration !== undefined;
}

/** Structural mirror at the UI boundary. Host validates the full wire schema and SQLite lineage. */
export function projectCommittedRunNarration(
  item: CanonicalConversationItem, scope: CanonicalTranscriptScope,
  items: ReadonlyMap<string, CanonicalConversationItem>, turnRuns: readonly CanonicalTurnRunLink[],
): readonly ConversationTimelineMessageItem[] | undefined {
  const payload = item.payload;
  if (!record(payload) || !record(payload.runNarration)) return undefined;
  const saved = payload.runNarration, source = saved.source;
  if (!record(source) || saved.schemaVersion !== 1 || !text(saved.messageId) || !text(saved.sourceItemId)
    || !text(saved.throughEventId) || !positive(saved.throughEventSequence) || payload.streaming !== false
    || payload.presentationRole !== "narration" || typeof payload.body !== "string"
    || payload.body.length > 128_000 || !["ready", "failed", "blocked"].includes(String(payload.deliveryStatus))
    || !["normal", "private", "run_detail"].includes(scope.surface)
    || source.workspaceId !== scope.workspaceId || source.workspaceId !== item.workspaceId
    || source.threadId !== scope.threadId || source.threadId !== item.threadId || source.turnId !== item.turnId
    || source.participantId !== item.actorId || !["ling_agent", "teammate"].includes(item.actorType)
    || ![source.workspaceId, source.threadId, source.turnId, source.runId, source.attemptId, source.workUnitId, source.participantId].every(text)
    || (scope.runId !== undefined && source.runId !== scope.runId)
    || (scope.turnId !== undefined && source.turnId !== scope.turnId)
    || (scope.attemptId !== undefined && source.attemptId !== scope.attemptId)
    || (scope.participantId !== undefined && source.participantId !== scope.participantId)
    || !turnRuns.some(link => link.runId === source.runId && link.turnId === source.turnId)
    || !Array.isArray(saved.segments) || !saved.segments.length || saved.sourceItemId === item.id) return undefined;
  const runRefs = item.domainRefs?.filter(ref => ref.type === "run") ?? [];
  const effective = turnRuns.filter(link => link.turnId === item.turnId && link.role !== "validation")
    .sort((a, b) => a.attemptNumber - b.attemptNumber || a.runId.localeCompare(b.runId)).at(-1);
  if (!scope.runId && effective && effective.runId !== source.runId) return [];
  if (runRefs.length !== 1 || runRefs[0]!.id !== source.runId
    || !item.domainRefs?.some(ref => ref.type === "conversation_item" && ref.id === saved.sourceItemId)) return undefined;
  const segments: ConversationRunNarrationSegment[] = [];
  let previousEnd = 0;
  for (const segment of saved.segments) {
    if (!record(segment) || typeof segment.content !== "string" || !segment.content.length
      || !text(segment.firstEventId) || !text(segment.lastEventId) || typeof segment.completed !== "boolean"
      || !positive(segment.startEventSequence) || !positive(segment.endEventSequence)
      || segment.startEventSequence <= previousEnd || segment.endEventSequence < segment.startEventSequence
      || segment.endEventSequence > saved.throughEventSequence
      || (payload.deliveryStatus === "ready" && !segment.completed)) return undefined;
    previousEnd = segment.endEventSequence;
    segments.push({ content: segment.content, firstEventId: segment.firstEventId, lastEventId: segment.lastEventId,
      startEventSequence: segment.startEventSequence, endEventSequence: segment.endEventSequence, completed: segment.completed,
      source: source as unknown as NonNullable<ConversationRunNarrationSegment["source"]> });
  }
  if (payload.body !== segments.map(segment => segment.content).join("\n\n")) return undefined;
  const anchor = items.get(saved.sourceItemId);
  if (anchor && (anchor.threadId !== item.threadId || anchor.workspaceId !== item.workspaceId || anchor.turnId !== item.turnId)) return undefined;
  const message: ConversationTimelineMessageItem = {
    logicalMessageId: saved.messageId,
    id: `message:agent:${saved.messageId}`, kind: "agentMessage", itemId: item.id, markdown: payload.body,
    revision: item.revision, threadSequence: item.sequence, partIndex: 0, turnId: item.turnId,
    phase: payload.deliveryStatus === "ready" ? "final" : "commentary",
    status: payload.deliveryStatus === "ready" ? "succeeded" : payload.deliveryStatus === "failed" ? "failed" : "cancelled",
    sourceRefs: [{ kind: "conversation_item", id: item.id }],
  };
  return projectConversationRunNarration({
    message, runId: source.runId as string, segments,
    anchor: { ...message, itemId: saved.sourceItemId, threadSequence: anchor?.sequence ?? item.sequence,
      sourceRefs: [{ kind: "conversation_item", id: saved.sourceItemId }] },
  }).map(row => ({ ...row, sourceRefs: [...row.sourceRefs, { kind: "conversation_item", id: item.id }] }));
}
