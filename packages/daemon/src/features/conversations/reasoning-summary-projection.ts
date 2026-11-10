import type {
  ConversationItemV1,
  ConversationReasoningSummaryRecord,
  ExecutionActionSourceRef,
  LingThread,
  LingTurnRun,
} from "@ling-stack/contracts";
import type { RunEventEnvelope, RunSession, RunStore, WorkUnitAttempt } from "@ling-stack/core";

type ReasoningSummaryProjectionStore = Pick<
  RunStore,
  "listEvents" | "listWorkUnitAttempts"
>;

export interface ProjectConversationReasoningSummariesInput {
  readonly store: ReasoningSummaryProjectionStore;
  readonly thread: LingThread;
  readonly runLinks: readonly LingTurnRun[];
  readonly runs: readonly RunSession[];
  readonly items: readonly ConversationItemV1[];
}

/**
 * Build a restart-safe, read-only projection of provider-safe reasoning
 * summaries. RunEvents remain authoritative; no ConversationItem is created or
 * mutated, and raw provider reasoning is never inspected.
 */
export function projectConversationReasoningSummaries(
  input: ProjectConversationReasoningSummariesInput,
): readonly ConversationReasoningSummaryRecord[] {
  const linksByRunId = new Map(input.runLinks.map((link) => [link.runId, link]));
  const anchorsByRunId = assistantAnchorsByRunId(input.thread, input.items);
  const output: ConversationReasoningSummaryRecord[] = [];

  for (const run of input.runs) {
    if (run.threadId && run.threadId !== input.thread.id) continue;
    const link = linksByRunId.get(run.id);
    const anchor = selectAnchor(anchorsByRunId.get(run.id) ?? [], link?.turnId);
    if (!anchor || !anchor.turnId) continue;
    if (link && link.turnId !== anchor.turnId) continue;

    const attempts = run.workUnitId
      ? [...input.store.listWorkUnitAttempts(run.workUnitId)].sort(byAttemptNumber)
      : [];
    for (const event of listAllRunEvents(input.store, run.id)) {
      if (event.type !== "assistant_reasoning_summary") continue;
      const attemptId = event.data.attemptId ?? attemptAt(attempts, event.ts)?.id;
      const participantId = run.teammateId ?? assistantParticipantId(anchor);
      const sourceRefs = uniqueSourceRefs([
        { kind: "conversation_item", id: anchor.id },
        { kind: "thread", id: input.thread.id },
        { kind: "turn", id: anchor.turnId },
        { kind: "run", id: run.id },
        { kind: "run_event", id: event.id },
        ...(attemptId ? [{ kind: "attempt", id: attemptId }] : []),
        ...(run.workUnitId ? [{ kind: "work_unit", id: run.workUnitId }] : []),
        ...(participantId ? [{ kind: "participant", id: participantId }] : []),
        ...(run.workflowStepId ? [{ kind: "workflow_step", id: run.workflowStepId }] : []),
      ]);
      output.push({
        id: `reasoning-summary:${event.id}`,
        revision: event.seq,
        workspaceId: input.thread.workspaceId,
        threadId: input.thread.id,
        turnId: anchor.turnId,
        runId: run.id,
        ...(attemptId ? { attemptId } : {}),
        ...(participantId ? { participantId } : {}),
        ...(run.workUnitId ? { workUnitId: run.workUnitId } : {}),
        ...(run.workflowStepId ? { workflowStepId: run.workflowStepId } : {}),
        anchorItemId: anchor.id,
        eventId: event.id,
        eventSequence: event.seq,
        text: event.data.text,
        parts: event.data.parts,
        semantic: event.data.semantic,
        source: event.data.source,
        truncated: event.data.truncated,
        sourceRefs,
        createdAt: event.ts,
      });
    }
  }

  const sequenceByItemId = new Map(input.items.map((item) => [item.id, item.sequence]));
  return output.sort((left, right) => {
    const leftAnchor = sequenceByItemId.get(left.anchorItemId) ?? Number.MAX_SAFE_INTEGER;
    const rightAnchor = sequenceByItemId.get(right.anchorItemId) ?? Number.MAX_SAFE_INTEGER;
    return leftAnchor - rightAnchor
      || left.runId.localeCompare(right.runId)
      || left.eventSequence - right.eventSequence
      || left.id.localeCompare(right.id);
  });
}

function assistantAnchorsByRunId(
  thread: LingThread,
  items: readonly ConversationItemV1[],
): ReadonlyMap<string, readonly Extract<ConversationItemV1, { readonly kind: "assistant_message" }>[]> {
  const byRunId = new Map<string, Extract<ConversationItemV1, { readonly kind: "assistant_message" }>[]>();
  for (const item of items) {
    if (item.kind !== "assistant_message" || item.threadId !== thread.id || item.workspaceId !== thread.workspaceId) continue;
    const runRefs = item.domainRefs.filter((ref) => ref.type === "run");
    if (runRefs.length !== 1) continue;
    const runId = runRefs[0]!.id;
    byRunId.set(runId, [...(byRunId.get(runId) ?? []), item]);
  }
  return byRunId;
}

function selectAnchor(
  anchors: readonly Extract<ConversationItemV1, { readonly kind: "assistant_message" }>[],
  turnId: string | undefined,
): Extract<ConversationItemV1, { readonly kind: "assistant_message" }> | undefined {
  const scoped = turnId ? anchors.filter((item) => item.turnId === turnId) : anchors;
  return [...scoped].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))[0];
}

function assistantParticipantId(
  item: Extract<ConversationItemV1, { readonly kind: "assistant_message" }>,
): string | undefined {
  return item.actorType === "ling_agent" || item.actorType === "teammate" ? item.actorId : undefined;
}

function listAllRunEvents(
  store: ReasoningSummaryProjectionStore,
  runId: string,
): readonly RunEventEnvelope[] {
  const events: RunEventEnvelope[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = store.listEvents(runId, { afterSeq, limit: 1_000 });
    if (page.length === 0) break;
    const lastSeq = page.at(-1)!.seq;
    if (!Number.isSafeInteger(lastSeq) || lastSeq <= afterSeq) {
      throw new Error(`Reasoning summary RunEvent cursor did not advance: ${runId}`);
    }
    events.push(...page);
    afterSeq = lastSeq;
    if (page.length < 1_000) break;
  }
  return events;
}

function attemptAt(
  attempts: readonly WorkUnitAttempt[],
  eventTimestamp: string,
): WorkUnitAttempt | undefined {
  const eventTime = Date.parse(eventTimestamp);
  if (!Number.isFinite(eventTime)) return attempts.length === 1 ? attempts[0] : undefined;
  return [...attempts].reverse().find((attempt) => {
    const startedAt = Date.parse(attempt.startedAt ?? attempt.createdAt);
    const endedAt = attempt.endedAt ? Date.parse(attempt.endedAt) : Number.POSITIVE_INFINITY;
    return Number.isFinite(startedAt) && startedAt <= eventTime
      && (!Number.isFinite(endedAt) || eventTime <= endedAt);
  }) ?? (attempts.length === 1 ? attempts[0] : undefined);
}

function byAttemptNumber(left: WorkUnitAttempt, right: WorkUnitAttempt): number {
  return left.attemptNumber - right.attemptNumber || left.id.localeCompare(right.id);
}

function uniqueSourceRefs(refs: readonly ExecutionActionSourceRef[]): readonly ExecutionActionSourceRef[] {
  const output = new Map<string, ExecutionActionSourceRef>();
  for (const ref of refs) output.set(`${ref.kind}:${ref.id}`, ref);
  return [...output.values()];
}
