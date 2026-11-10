import type { ConversationNarrationSegment, ConversationNarrationSource } from "./conversations.js";

/** Immutable terminal narration, not execution evidence or a UI activity batch. */
export interface CommittedRunNarrationV1 {
  readonly schemaVersion: 1;
  /** Stable UI identity across streaming and publication; storage identity remains per Run. */
  readonly messageId: string;
  readonly sourceItemId: string;
  readonly source: ConversationNarrationSource;
  readonly throughEventSequence: number;
  readonly throughEventId: string;
  readonly segments: readonly Omit<ConversationNarrationSegment, "source" | "sourceRevision">[];
}

const keys = ["schemaVersion", "messageId", "sourceItemId", "source", "throughEventSequence", "throughEventId", "segments"];
const sourceKeys = ["workspaceId", "threadId", "turnId", "runId", "workUnitId", "attemptId", "participantId"];
const segmentKeys = ["content", "firstEventId", "lastEventId", "startEventSequence", "endEventSequence", "completed"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Validate bounded message boundaries and event identity without trusting caller ordering. */
export function isCommittedRunNarrationV1(value: unknown): value is CommittedRunNarrationV1 {
  if (!record(value) || !only(value, keys) || value.schemaVersion !== 1 || !text(value.messageId)
    || !text(value.sourceItemId) || !text(value.throughEventId) || !positive(value.throughEventSequence)
    || !record(value.source) || !only(value.source, sourceKeys)
    || !sourceKeys.every(key => text((value.source as Record<string, unknown>)[key]))
    || !Array.isArray(value.segments) || !value.segments.length || value.segments.length > 128_000) return false;
  const ids = new Map<string, number>();
  const sequences = new Map<number, string>();
  const bind = (id: string, sequence: number) => {
    if ((ids.has(id) && ids.get(id) !== sequence) || (sequences.has(sequence) && sequences.get(sequence) !== id)) return false;
    ids.set(id, sequence); sequences.set(sequence, id); return true;
  };
  let end = 0;
  let length = 0;
  for (const segment of value.segments) {
    if (!record(segment) || !only(segment, segmentKeys) || typeof segment.content !== "string" || !segment.content.length
      || !text(segment.firstEventId) || !text(segment.lastEventId) || typeof segment.completed !== "boolean"
      || !positive(segment.startEventSequence) || !positive(segment.endEventSequence)
      || segment.startEventSequence <= end || segment.endEventSequence < segment.startEventSequence
      || segment.endEventSequence > value.throughEventSequence
      || !bind(segment.firstEventId, segment.startEventSequence) || !bind(segment.lastEventId, segment.endEventSequence)) return false;
    end = segment.endEventSequence;
    length += segment.content.length + (length ? 2 : 0);
    if (length > 128_000 || (!segment.completed && segment !== value.segments.at(-1))) return false;
  }
  return bind(value.throughEventId, value.throughEventSequence);
}

/** Join the validated payload to its canonical Item scope; database lineage is checked again by Host. */
export function hasConsistentCommittedRunNarration(item: Record<string, unknown>): boolean {
  if (!record(item.payload) || item.payload.runNarration === undefined) return true;
  const payload = item.payload;
  const narration = payload.runNarration;
  if (!isCommittedRunNarrationV1(narration) || item.status !== "committed" || item.channelId !== undefined || item.turnId !== narration.source.turnId
    || item.workspaceId !== narration.source.workspaceId || item.threadId !== narration.source.threadId
    || item.actorId !== narration.source.participantId || (item.actorType !== "ling_agent" && item.actorType !== "teammate")
    || narration.sourceItemId === item.id || payload.streaming !== false || payload.presentationRole !== "narration"
    || payload.body !== narration.segments.map(segment => segment.content).join("\n\n")
    || !narration.segments.some(segment => segment.content.trim().length > 0)
    || (payload.deliveryStatus === "ready" && narration.segments.some(segment => !segment.completed))
    || !Array.isArray(item.domainRefs)) return false;
  const refs = item.domainRefs.filter(record);
  const runs = refs.filter(ref => ref.type === "run");
  return runs.length === 1 && runs[0]!.id === narration.source.runId
    && refs.some(ref => ref.type === "conversation_item" && ref.id === narration.sourceItemId);
}
