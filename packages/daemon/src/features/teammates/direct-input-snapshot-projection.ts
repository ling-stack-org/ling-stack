import type { ConversationContextSnapshot, ConversationItemV1 } from "@ling-stack/contracts";
import type { LingThread, LingTurn, RunSession, RunStore } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { resolveTeammateDirectRunOwner } from "./direct-run-owner.js";

/** Expose frozen private input metadata only after exact visible Run/source/owner binding. */
export function projectTeammateDirectInputSnapshots(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
  readonly items: readonly ConversationItemV1[];
}): readonly ConversationContextSnapshot[] {
  const { store, thread } = input;
  if (thread.kind !== "teammate_direct" || !thread.teammateId || thread.channelId) return [];
  const teammateId = thread.teammateId;
  const turns = new Map(input.turns.filter(turn => turn.threadId === thread.id && turn.workspaceId === thread.workspaceId &&
    turn.teammateId === teammateId && !turn.channelId && !turn.workflowStepId).map(turn => [turn.id, turn]));
  const items = new Map(input.items.filter(item => item.threadId === thread.id && item.workspaceId === thread.workspaceId &&
    item.kind === "user_message" && item.status === "committed" && !item.channelId &&
    item.visibility === "agent_private" && item.visibilityOwnerId === teammateId).map(item => [item.id, item]));
  const snapshots = new Map<string, ConversationContextSnapshot>();
  store.readSnapshot(() => {
    for (const run of input.runs) {
      const owner = resolveTeammateDirectRunOwner(store, run.id, { teammateId, canonicalThreadId: thread.id });
      const turn = owner ? turns.get(owner.turn.id) : undefined;
      const source = turn?.sourceItemId ? items.get(turn.sourceItemId) : undefined;
      const request = run.requestSnapshot;
      if (!owner || !turn || !source || source.turnId !== turn.id || !isRecord(request) ||
        !isRecord(request.teammateDirectInputRef) || !isRecord(request.task) || !isRecord(run.taskSnapshot)) continue;
      try {
        const snapshot = store.getTeammateDirectInputSnapshot(source.id, teammateId);
        const ref = request.teammateDirectInputRef;
        if (!snapshot || snapshot.workspaceId !== thread.workspaceId || snapshot.threadId !== thread.id ||
          snapshot.turnId !== turn.id || snapshot.sourceItemId !== source.id || snapshot.teammateId !== teammateId ||
          ref.id !== snapshot.id || ref.fingerprint !== snapshot.fingerprint || request.task.prompt !== snapshot.payload.prompt ||
          run.taskSnapshot.prompt !== snapshot.payload.prompt ||
          request.systemPrompt !== snapshot.payload.systemPrompt ||
          (request.sourceMessageId !== source.id && !source.domainRefs.some(r => r.type === "message" && r.id === request.sourceMessageId))) continue;
        const p = snapshot.projection;
        if (p.threadId !== thread.id || p.turnId !== turn.id || p.throughItemSequence !== source.sequence) continue;
        // Never spread the envelope or payload: it contains private history and
        // memory. Only source identities already visible in this detail survive.
        snapshots.set(snapshot.id, {
          id: snapshot.id, threadId: thread.id, segmentId: p.segmentId, projectionVersion: p.projectionVersion,
          throughItemSequence: p.throughItemSequence, summaryIds: [...p.summaryIds], policyVersion: p.policyVersion,
          createdAt: snapshot.createdAt,
          sourceRefs: p.sourceRefs.filter(ref => (ref.type === "thread" && ref.id === thread.id) ||
            (ref.type === "turn" && turns.has(ref.id)) ||
            (ref.type === "conversation_item" && (items.get(ref.id)?.sequence ?? Infinity) <= p.throughItemSequence)),
        });
      } catch {
        // Missing/corrupt evidence cannot authorize grouping, but must not hide
        // otherwise readable private history or recapture its execution input.
      }
    }
  });
  return [...snapshots.values()].sort((a, b) => a.throughItemSequence - b.throughItemSequence || a.id.localeCompare(b.id));
}

/** Timeline consumers need execution identity/status, not rendered private history or memory. */
export function projectTeammateDirectPublicRun(run: RunSession): RunSession {
  const task = isRecord(run.taskSnapshot) ? run.taskSnapshot : {};
  return {
    ...run,
    taskSnapshot: { id: run.taskId, ...(typeof task.title === "string" ? { title: task.title } : {}) },
    requestSnapshot: {},
  };
}
