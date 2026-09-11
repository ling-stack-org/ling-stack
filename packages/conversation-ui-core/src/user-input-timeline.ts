import type { CanonicalConversationItem, CanonicalTranscriptScope } from "./canonical-transcript-projector.js";
import { isCanonicalUserInputRunEventPosition, reconcileCanonicalUserInputs, type CanonicalUserInput } from "./user-input-transcript-snapshot.js";
import type { ConversationTimelineItemStatus, ConversationTimelineUserInputItem } from "./transcript-item.js";

/**
 * Read-only projection of public hydration onto the validated canonical spine.
 * No clock, tool inference or selected-surface metadata can supply missing ownership.
 * Missing hydration is a partial read; an anchored unavailable record is a neutral
 * history placeholder. Unanchored replay tombstones never produce UI.
 */
export function projectCanonicalUserInputTimeline(input: {
  readonly scope: CanonicalTranscriptScope;
  readonly items: readonly CanonicalConversationItem[];
  readonly userInputs?: readonly CanonicalUserInput[];
}): readonly ConversationTimelineUserInputItem[] {
  const { scope } = input;
  const normalized = reconcileCanonicalUserInputs({ scope, incoming: input, mode: "page" });
  const byId = new Map(normalized.userInputs.map(record => [record.itemId, record]));
  return normalized.items.flatMap<ConversationTimelineUserInputItem>(anchor => {
    const record = byId.get(anchor.id);
    if (!record || (scope.turnId && anchor.turnId !== scope.turnId)) return [];
    const base = { id: "user-input:" + anchor.id, itemId: anchor.id,
      threadSequence: anchor.sequence, partIndex: 0, turnId: anchor.turnId };
    if (record.availability === "unavailable") {
      // A private/child selection cannot supply the missing participant or attempt.
      if (scope.surface === "child" || scope.runId || scope.attemptId || scope.participantId) return [];
      return [{ ...base, kind: record.kind === "user_input_request" ? "userInputRequest" : "userInputAnswer",
        revision: anchor.revision, sourceRefs: [{ kind: "conversation_item", id: anchor.id }], userInput: record }];
    }
    const source = record.source;
    if ((scope.runId && source.runId !== scope.runId)
      || (scope.attemptId && source.attemptId !== scope.attemptId)
      || (scope.participantId && source.participantId !== scope.participantId)
      || (scope.surface === "child" && (!scope.runId || !scope.participantId))) return [];
    const sourceRefs = [
      { kind: "conversation_item", id: anchor.id },
      { kind: "run", id: source.runId }, { kind: "attempt", id: source.attemptId },
      { kind: "participant", id: source.participantId }, { kind: "work_unit", id: source.workUnitId },
      ...(source.workflowStepId ? [{ kind: "workflow_step", id: source.workflowStepId }] : []),
      ...(record.runEventPosition?.afterEventId ? [{ kind: "run_event", id: record.runEventPosition.afterEventId }] : []),
    ];
    const lineage = { runId: source.runId, attemptId: source.attemptId, participantId: source.participantId,
      workUnitId: source.workUnitId, workflowStepId: source.workflowStepId ?? null, sourceRefs };
    const status: ConversationTimelineItemStatus | undefined = record.kind === "user_input_request"
      ? record.status === "pending" ? record.waitMode === "required" ? "waiting" : "pending"
        : record.status === "cancelled" ? "cancelled" : undefined
      : record.delivery.status === "pending" || record.delivery.status === "claimed" ? "waiting"
        : record.delivery.status === "failed" ? "failed" : undefined;
    return record.kind === "user_input_request"
      ? [{ ...base, ...lineage, status, kind: "userInputRequest", revision: record.statusRevision, userInput: record }]
      : [{ ...base, ...lineage, status, kind: "userInputAnswer", revision: record.delivery.revision, userInput: record }];
  });
}

/** Defensive typed-row boundary. Renderers only receive the public payload shape. */
export function isUserInputTimelinePayload(value: unknown, kind: string, itemId: unknown): boolean {
  if (!isRecord(value) || typeof itemId !== "string" || value.itemId !== itemId
    || value.kind !== (kind === "userInputRequest" ? "user_input_request" : "user_input_answer")) return false;
  if (value.availability === "unavailable") return true;
  if (value.availability !== "available" || !nonempty(value.requestId) || !positive(value.requestVersion)
    || !isRecord(value.source) || !["workspaceId", "threadId", "turnId", "runId", "attemptId", "participantId", "workUnitId", "sourceItemId"]
      .every(key => nonempty(value.source && (value.source as Record<string, unknown>)[key]))
    || (value.source.workflowStepId !== undefined && !nonempty(value.source.workflowStepId))) return false;
  if (value.runEventPosition !== undefined && (!isCanonicalUserInputRunEventPosition(value.runEventPosition)
    || value.runEventPosition.runId !== value.source.runId || value.runEventPosition.attemptId !== value.source.attemptId)) return false;
  if (kind === "userInputRequest") return positive(value.statusRevision)
    && ["pending", "answered", "skipped", "cancelled", "expired", "superseded"].includes(String(value.status))
    && (value.waitMode === "optional" || value.waitMode === "required")
    && Array.isArray(value.questions) && value.questions.every(q => isRecord(q) && nonempty(q.questionId)
      && typeof q.prompt === "string" && typeof q.required === "boolean" && typeof q.allowFreeText === "boolean"
      && Array.isArray(q.options) && q.options.every(o => isRecord(o) && nonempty(o.optionId) && typeof o.label === "string"));
  return nonempty(value.answerId) && isRecord(value.delivery) && positive(value.delivery.revision)
    && ["pending", "claimed", "applied", "failed", "obsolete"].includes(String(value.delivery.status))
    && Array.isArray(value.answers) && value.answers.every(a => isRecord(a) && nonempty(a.questionId)
      && typeof a.prompt === "string" && (a.kind === "text" ? typeof a.text === "string"
        : a.kind === "option" && nonempty(a.optionId) && typeof a.label === "string"));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): boolean { return typeof value === "string" && value.trim().length > 0; }
function positive(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
