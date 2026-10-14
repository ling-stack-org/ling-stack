import type { ConversationContextSummary, ConversationItemV1, TurnContextAssignment } from "@ling-stack/contracts";
import type { LingThread, LingTurn, RunStore } from "@ling-stack/core";
import type { ConversationContextProjection } from "../channels/context-processing/conversation-context-projector.js";
import { isConversationContextItemVisible } from "../channels/context-processing/conversation-context-projector.js";
import { compareNormalContextTurns, ownedItem, ownedTurn, selectNormalContextRun,
  type HydrateNormalConversationContextInput } from "./normal-conversation-context-hydrator.js";

const TURN_PAGE_SIZE = 500;

export interface NormalContextTurnCandidate {
  readonly turn: LingTurn;
  readonly assignment?: TurnContextAssignment;
  readonly legacy: boolean;
}

/** Source/assigned owners and summary validation facts never become a thread-wide scan. */
export function collectNormalContextTurnCandidates(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly sourceTurn: LingTurn;
  readonly sourceItem: ConversationItemV1;
  readonly projection: ConversationContextProjection;
  readonly supersededTurnIds: readonly string[];
}): {
  readonly assignedTurns: readonly LingTurn[];
  readonly assignments: readonly TurnContextAssignment[];
  readonly verifiedSummaryIds: ReadonlySet<string>;
  readonly candidates: Iterable<NormalContextTurnCandidate>;
} {
  const { store, thread, sourceTurn, sourceItem, projection } = input;
  const turns = new Map<string, LingTurn>([[sourceTurn.id, sourceTurn]]);
  for (const item of projection.items) {
    if (!item.turnId || turns.has(item.turnId)) continue;
    const turn = store.getLingTurn(item.turnId);
    if (turn) turns.set(turn.id, turn);
  }
  const assignments = [...turns.values()].flatMap(turn => {
    const assignment = store.getEffectiveTurnContextAssignment(turn.id);
    return assignment ? [assignment] : [];
  });
  const assignmentsByTurn = new Map(assignments.map(assignment => [assignment.turnId, assignment]));
  const segments = store.listContextSegments({ threadId: thread.id, limit: 200 });
  const bootstrap = store.getEffectiveTurnContextAssignment(projection.segment.createdFromTurnId);
  const acceptsLegacy = segments.length === 1 && segments[0]?.id === projection.segment.id &&
    bootstrap?.segmentId === projection.segment.id && bootstrap.policyVersion === "continuity-v2-bootstrap-v1";
  const superseded = new Set(input.supersededTurnIds);

  function historicalOwner(turn: LingTurn): boolean {
    if (!ownedTurn(turn, thread) || turn.status === "superseded" || superseded.has(turn.id) ||
      turn.id === sourceTurn.id || turn.createdAt > sourceTurn.createdAt) return false;
    if (turn.createdAt === sourceTurn.createdAt && !projection.items.some(item => item.turnId === turn.id &&
      item.kind === "user_message" && item.sequence < sourceItem.sequence && ownedItem(item, thread))) return false;
    const assignment = store.getEffectiveTurnContextAssignment(turn.id);
    if (assignment && (!["committed", "provisional"].includes(assignment.status) || assignment.segmentId !== projection.segment.id)) return false;
    if (!assignment && (!acceptsLegacy || turn.interventionId || turn.createdAt >= projection.segment.createdAt)) return false;
    const pointer = turn.sourceItemId ? store.getConversationItem(turn.sourceItemId) : undefined;
    if (!pointer) return !assignment && !turn.sourceItemId;
    return pointer.turnId === turn.id && pointer.kind === "user_message" && ownedItem(pointer, thread) &&
      pointer.sequence < sourceItem.sequence && pointer.domainRefs.every(ref => ref.type !== "turn" || ref.id === turn.id) &&
      ((pointer.actorType === "local_user" && turn.createdByActor === "local-user") ||
        (pointer.actorType === "system" && turn.createdByActor === "system"));
  }

  // These are consumed only by summary validation. They are not canonical body candidates.
  const verifiedSummaryIds = new Set<string>();
  for (const summary of projection.summaries) {
    if (verifySummarySources(summary)) verifiedSummaryIds.add(summary.id);
  }
  function verifySummarySources(summary: ConversationContextSummary): boolean {
    for (const ref of summary.sourceRefs) {
      if (ref.type === "thread") { if (ref.id !== thread.id) return false; continue; }
      if (ref.type === "turn") {
        const turn = store.getLingTurn(ref.id);
        if (!turn || !historicalOwner(turn)) return false;
      }
      if (ref.type === "conversation_item" || ref.type === "message") {
        const item = store.getConversationItem(ref.id);
        const turn = item?.turnId ? store.getLingTurn(item.turnId) : undefined;
        if (!item || !turn || !historicalOwner(turn) || !ownedItem(item, thread) || item.id === sourceItem.id ||
          item.sequence >= sourceItem.sequence || item.sequence < summary.coveredFromSequence ||
          item.sequence > summary.coveredThroughSequence || item.updatedAt > summary.createdAt) return false;
      }
      if (ref.type === "run") {
        const turn = store.getLingTurnForRun(ref.id);
        const run = store.getRun(ref.id);
        if (!turn || !run || !historicalOwner(turn)) return false;
        const minimal: HydrateNormalConversationContextInput = { thread, sourceTurn, sourceItem, canonicalItems: [],
          contextSegmentId: projection.segment.id, turnContextAssignments: [], turns: [turn],
          runLinks: store.listLingTurnRuns(turn.id), runs: [run], eventsByRunId: new Map(), runEventWatermarks: [] };
        if (selectNormalContextRun(minimal, turn)?.id !== ref.id) return false;
      }
    }
    return true;
  }

  function* legacyTurns(): Generator<NormalContextTurnCandidate> {
    if (!acceptsLegacy) return;
    let beforeTurnId: string | undefined;
    let previous: LingTurn | undefined;
    for (;;) {
      const page = store.listLingTurns({ threadId: thread.id, limit: TURN_PAGE_SIZE,
        orderBy: "createdAt", createdBefore: projection.segment.createdAt, ...(beforeTurnId ? { beforeTurnId } : {}) });
      for (const turn of page) {
        if (previous && compareNormalContextTurns(previous, turn) <= 0) throw new Error("Normal context Turn cursor did not advance");
        previous = turn;
        if (turn.id === sourceTurn.id || turns.has(turn.id) || turn.interventionId || !ownedTurn(turn, thread) ||
          turn.status === "superseded" || superseded.has(turn.id) || turn.createdAt >= projection.segment.createdAt ||
          store.getEffectiveTurnContextAssignment(turn.id)) continue;
        yield { turn, legacy: true };
      }
      if (page.length < TURN_PAGE_SIZE) return;
      const next = page.at(-1)!.id;
      if (next === beforeTurnId) throw new Error("Normal context Turn cursor did not advance");
      beforeTurnId = next;
    }
  }
  function* merged(): Generator<NormalContextTurnCandidate> {
    const assigned = [...turns.values()].filter(turn => turn.id !== sourceTurn.id &&
      (assignmentsByTurn.has(turn.id) || (acceptsLegacy && !turn.interventionId && ownedTurn(turn, thread) &&
        turn.createdAt < projection.segment.createdAt))).sort((a, b) => -compareNormalContextTurns(a, b));
    const legacy = legacyTurns();
    let head = legacy.next();
    let index = 0;
    while (index < assigned.length || !head.done) {
      const turn = assigned[index];
      if (turn && (head.done || compareNormalContextTurns(turn, head.value.turn) > 0)) {
        index += 1;
        const assignment = assignmentsByTurn.get(turn.id);
        yield { turn, ...(assignment ? { assignment } : {}), legacy: !assignment };
      } else if (!head.done) {
        yield head.value;
        head = legacy.next();
      }
    }
  }
  return { assignedTurns: [...turns.values()], assignments, verifiedSummaryIds, candidates: { [Symbol.iterator]: merged } };
}

/** Preserve legacy raw-user deny signals before adding visible items to the pure fold. */
export function readNormalContextLegacyItems(store: RunStore, thread: LingThread, sourceItem: ConversationItemV1,
  turn: LingTurn): readonly ConversationItemV1[] | undefined {
  const raw = store.listConversationItemsForTurn({ turnId: turn.id }).filter(item => item.sequence < sourceItem.sequence);
  const pointer = turn.sourceItemId ? store.getConversationItem(turn.sourceItemId) : undefined;
  if (pointer && (pointer.threadId !== thread.id || pointer.turnId !== turn.id || pointer.workspaceId !== thread.workspaceId ||
    pointer.channelId || pointer.kind !== "user_message" || pointer.actorType !== "local_user" || pointer.status !== "committed" ||
    !isConversationContextItemVisible(pointer, "reply", undefined) || pointer.sequence >= sourceItem.sequence)) return undefined;
  if (raw.some(item => item.kind === "user_message" && (item.threadId !== thread.id || item.workspaceId !== thread.workspaceId ||
    item.channelId || item.actorType !== "local_user" || !isConversationContextItemVisible(item, "reply", undefined)))) return undefined;
  return raw;
}
