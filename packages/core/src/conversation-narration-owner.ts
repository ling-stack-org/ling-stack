import type { ConversationNarrationSource } from "@ling-stack/contracts";
import { LING_AGENT_ID } from "./workspace-types.js";
import type { RunStore } from "./run-types.js";
import { ConversationNarrationAccumulator } from "./conversation-narration-segments.js";

export type NarrationOwnerStore = Pick<RunStore, "getRun" | "getLingThread" | "getLingTurnForRun"
  | "listLingTurnRuns" | "getWorkUnit" | "getWorkUnitAttempt" | "listEvents">;

export interface NarrationOwnerScope {
  readonly threadId: string;
  readonly turnId: string;
  readonly participantId: string;
  readonly kind: "conversation" | "teammate_direct";
}

/**
 * Call inside the caller's readSnapshot, after surface access checks. Capture
 * immutable creation facts once, not WorkUnit.activeAttemptId/linkedRunId, which
 * may already refer to a successor. Replay validates subsequent event conflicts.
 * Missing lineage leaves narrative readable but never supplies Q/A ownership.
 */
export function createOwnedRunNarrationAccumulator(
  store: NarrationOwnerStore, runId: string, scope: NarrationOwnerScope,
): ConversationNarrationAccumulator {
  const unowned = () => new ConversationNarrationAccumulator({ runId });
  const run = store.getRun(runId);
  if (!run || run.id !== runId || !run.workUnitId || run.threadId !== scope.threadId
    || run.channelId !== undefined || run.workflowStepId !== undefined
    || (run.teammateId ?? LING_AGENT_ID) !== scope.participantId) return unowned();
  const thread = store.getLingThread(scope.threadId);
  const turn = store.getLingTurnForRun(runId);
  const unit = store.getWorkUnit(run.workUnitId);
  if (!thread || !turn || !unit || thread.id !== scope.threadId || thread.kind !== scope.kind
    || !thread.workspaceId || turn.workspaceId !== thread.workspaceId || unit.workspaceId !== thread.workspaceId
    || turn.id !== scope.turnId || turn.threadId !== thread.id || unit.id !== run.workUnitId
    || thread.channelId !== undefined || turn.channelId !== undefined || unit.channelId !== undefined
    || turn.workflowStepId !== undefined
    || (thread.teammateId !== undefined && thread.teammateId !== scope.participantId)
    || (turn.teammateId !== undefined && turn.teammateId !== scope.participantId)
    || (unit.teammateId !== undefined && unit.teammateId !== scope.participantId)) return unowned();
  const links = store.listLingTurnRuns(turn.id).filter(link => link.runId === runId);
  if (links.length !== 1 || links[0]!.turnId !== turn.id) return unowned();
  let afterSeq = 0;
  for (;;) {
    const events = store.listEvents(runId, { afterSeq, limit: 1000 });
    if (!events.length) return unowned();
    const created = events.find(event => event.runId === runId && event.type === "run_created");
    if (created) {
      const data = created.data;
      if (data.workUnitId !== unit.id || data.threadId !== thread.id || typeof data.attemptId !== "string"
        || !data.attemptId.trim() || (data.teammateId !== undefined && data.teammateId !== scope.participantId)) return unowned();
      const attempt = store.getWorkUnitAttempt(data.attemptId);
      if (!attempt || attempt.id !== data.attemptId || attempt.workUnitId !== unit.id) return unowned();
      const source: ConversationNarrationSource = {
        workspaceId: thread.workspaceId, threadId: thread.id, turnId: turn.id, runId,
        workUnitId: unit.id, attemptId: attempt.id, participantId: scope.participantId,
      };
      return new ConversationNarrationAccumulator({ runId, source, creationEventId: created.id });
    }
    const next = events.at(-1)!.seq;
    if (next <= afterSeq) return unowned();
    afterSeq = next;
  }
}
