import { isDeepStrictEqual } from "node:util";
import type { ConversationContextSnapshot, ConversationItemV1 } from "@ling-stack/contracts";
import type {
  ConversationAcceptedInputSnapshot,
  ConversationPreparedInputSnapshot,
  LingThread,
  LingTurn,
  RunSession,
  RunStore,
} from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { readNormalConversationContext, readNormalConversationRunRequest } from "./normal-conversation-context.js";

/**
 * Publish only immutable metadata of the input chain actually consumed by a
 * visible normal Run. Fork snapshots keep their separate storage/API meaning.
 * Missing or invalid lineage is not batching authority: leave actions atomic.
 */
export function projectNormalExecutionContextSnapshots(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
  readonly items: readonly ConversationItemV1[];
}): readonly ConversationContextSnapshot[] {
  const { store, thread } = input;
  if (thread.kind !== "conversation" || thread.channelId) return [];
  const turnById = new Map(input.turns.filter(turn => turn.threadId === thread.id && turn.workspaceId === thread.workspaceId)
    .map(turn => [turn.id, turn]));
  const visibleItems = new Map(input.items.filter(item => item.threadId === thread.id && item.workspaceId === thread.workspaceId &&
    !item.channelId && item.status === "committed" && item.visibility === "thread_participants")
    .map(item => [item.id, item]));
  const snapshots = new Map<string, ConversationContextSnapshot>();
  store.readSnapshot(() => {
    for (const run of input.runs) {
      const owner = store.getLingTurnForRun(run.id);
      const turn = owner ? turnById.get(owner.id) : undefined;
      const source = turn?.sourceItemId ? visibleItems.get(turn.sourceItemId) : undefined;
      if (!turn || !source || source.turnId !== turn.id || run.threadId !== thread.id ||
        !isRecord(run.requestSnapshot) || typeof run.requestSnapshot.normalConversationAcceptedSnapshotId !== "string") continue;
      try {
        const request = readNormalConversationRunRequest(run, { threadId: thread.id, turnId: turn.id, itemId: source.id });
        const accepted = store.getConversationAcceptedInputSnapshot(source.id);
        if (!accepted || accepted.workspaceId !== thread.workspaceId || accepted.threadId !== thread.id || accepted.turnId !== turn.id ||
          request.normalConversationAcceptedSnapshotId !== accepted.id ||
          !isDeepStrictEqual(readNormalConversationContext(accepted.payload), request.normalConversationContext)) continue;
        const preparedRequest = store.getConversationPreparedInput(source.id, "request");
        const preparedExecution = store.getConversationPreparedInput(source.id, "execution");
        if (!matchesRef(preparedRequest, request.normalConversationPreparedRequestRef) ||
          !matchesRef(preparedExecution, request.normalConversationPreparedExecutionRef)) continue;
        for (const snapshot of [accepted, preparedRequest, preparedExecution]) {
          if (!snapshot) continue;
          const p = snapshot.projection;
          if (p.threadId !== thread.id || p.turnId !== turn.id || p.throughItemSequence !== source.sequence) continue;
          // Do not spread internal envelopes: payloads contain frozen provider
          // input/history. Only visible public refs cross the HTTP boundary.
          snapshots.set(snapshot.id, {
            id: snapshot.id, threadId: thread.id, segmentId: p.segmentId,
            projectionVersion: p.projectionVersion, throughItemSequence: p.throughItemSequence,
            summaryIds: [...p.summaryIds], policyVersion: p.policyVersion, createdAt: snapshot.createdAt,
            sourceRefs: p.sourceRefs.filter(ref =>
              (ref.type === "thread" && ref.id === thread.id) ||
              (ref.type === "turn" && turnById.has(ref.id)) ||
              (ref.type === "conversation_item" && (visibleItems.get(ref.id)?.sequence ?? Infinity) <= p.throughItemSequence)),
          });
        }
      } catch {
        // Corrupt input evidence must not hide otherwise readable history or
        // authorize grouping. The UI's missing-context boundary stays atomic.
      }
    }
  });
  return [...snapshots.values()].sort((left, right) => left.throughItemSequence - right.throughItemSequence ||
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function matchesRef(
  snapshot: ConversationPreparedInputSnapshot | ConversationAcceptedInputSnapshot | undefined,
  ref: { readonly id: string; readonly fingerprint: string } | undefined,
): boolean {
  return snapshot ? ref?.id === snapshot.id && ref.fingerprint === snapshot.fingerprint : ref === undefined;
}
