import { createHash } from "node:crypto";
import type { RunStore } from "@ling-stack/core";
import {
  buildConversationContextProjection,
  type ConversationContextProjection,
} from "./context-processing/conversation-context-projector.js";

export interface ChannelOperationVisibleSource {
  readonly itemId: string;
  readonly body: string;
  readonly revision: number;
  readonly actorType: "local_user" | "ling_agent" | "teammate";
}

export interface ChannelOperationContinuationAnchor {
  readonly sourceItemId: string;
  readonly sourceRevision: number;
  readonly clarificationDecisionId: string;
  readonly clarificationItemId: string;
  readonly clarificationRevision: number;
  readonly contextSegmentId: string;
  readonly projectionFingerprint: string;
}

export interface ChannelOperationContinuationContext {
  readonly anchor: ChannelOperationContinuationAnchor;
  readonly source: ChannelOperationVisibleSource;
  readonly confirmation: ChannelOperationVisibleSource;
  readonly clarification: ChannelOperationVisibleSource;
}

/**
 * Host-owned opportunity, not a yes/no classifier or an execution permit. The
 * selector must still opt in using the complete current user text. Only the
 * immediately preceding user's unanswered clarification can be resumed; model
 * IDs, summary prose, inherited threads and older requests cannot choose it.
 */
export function channelOperationContinuationContext(input: {
  readonly store: RunStore;
  readonly sourceItemId: string;
  readonly projection?: ConversationContextProjection;
}): ChannelOperationContinuationContext | undefined {
  const current = input.store.getEffectiveConversationItem(input.sourceItemId);
  if (!current || current.id !== input.sourceItemId || current.kind !== "user_message"
    || current.actorType !== "local_user" || current.status !== "committed" || !current.channelId || !current.turnId) return;
  const projection = input.projection ?? buildConversationContextProjection({
    store: input.store, sourceItemId: current.id, view: "selector",
  });
  const assignment = input.store.getEffectiveTurnContextAssignment(current.turnId);
  if (!assignment || projection.metadata.threadId !== current.threadId
    || projection.metadata.turnId !== current.turnId || projection.metadata.throughItemSequence !== current.sequence
    || projection.metadata.segmentId !== assignment.segmentId
    || projection.assignment.id !== assignment.id || projection.assignment.revision !== assignment.revision) return;
  const visible = channelOperationVisibleSources({ ...input, projection });
  const confirmation = visible.find(item => item.itemId === current.id && item.revision === current.revision
    && item.actorType === "local_user" && item.body === current.payload.body);
  if (!confirmation) return;
  // Read the actual tail, not only a trimmed/model-supplied projection: an
  // intervening user whose text was omitted must still prevent old-task reuse.
  const tail = input.store.listConversationItemsForSegment({ threadId: current.threadId,
    segmentId: assignment.segmentId, throughSequence: current.sequence, limit: 500 });
  const prior = [...tail].reverse().find(item => item.sequence < current.sequence && item.kind === "user_message");
  if (!prior || prior.kind !== "user_message" || prior.actorType !== "local_user" || prior.channelId !== current.channelId
    || !prior.turnId || prior.threadId !== current.threadId) return;
  const source = visible.find(item => item.itemId === prior.id && item.revision === prior.revision
    && item.actorType === "local_user" && item.body === prior.payload.body);
  if (!source) return;
  const priorAssignment = input.store.getEffectiveTurnContextAssignment(prior.turnId);
  if (!priorAssignment || priorAssignment.segmentId !== assignment.segmentId) return;
  const decision = input.store.listChannelIntentDecisions({ channelId: current.channelId, sourceItemId: prior.id, limit: 1 })[0];
  if (!decision || decision.action !== "clarify" || !["accepted", "suppressed"].includes(decision.status)
    || decision.contextSegmentId !== assignment.segmentId || decision.sourceTurnId !== prior.turnId
    || !decision.clarification || decision.resultItemIds.length !== 1 || decision.execution
    || decision.proposalId || decision.workflowId) return;
  const question = input.store.getEffectiveConversationItem(decision.resultItemIds[0]!);
  if (!question || question.id !== decision.resultItemIds[0] || question.kind !== "assistant_message"
    || question.status !== "committed" || question.threadId !== current.threadId
    || question.channelId !== current.channelId || question.turnId !== prior.turnId
    || question.sequence <= prior.sequence || question.sequence >= current.sequence
    || question.payload.body !== decision.clarification.question
    || !question.domainRefs.some(ref => ref.type === "conversation_item" && ref.id === prior.id)
    || (current.payload.replyToItemId && current.payload.replyToItemId !== question.id && current.payload.replyToItemId !== prior.id)) return;
  const clarification = visible.find(item => item.itemId === question.id && item.revision === question.revision
    && item.actorType !== "local_user" && item.body === question.payload.body);
  if (!clarification) return;
  // Freeze only the three necessary canonical sources and their assignments.
  // Compacting unrelated context must not make the very same clarification
  // anchor disagree with the full-context binder during its bounded repair.
  const projectionFingerprint = createHash("sha256").update(JSON.stringify({
    threadId: current.threadId, segmentId: assignment.segmentId,
    assignments: [priorAssignment, assignment].map(({ id, revision }) => ({ id, revision })),
    source, confirmation, clarification, decisionId: decision.id, decisionUpdatedAt: decision.updatedAt,
  })).digest("hex");
  return { source, confirmation, clarification, anchor: {
    sourceItemId: prior.id, sourceRevision: prior.revision,
    clarificationDecisionId: decision.id, clarificationItemId: question.id, clarificationRevision: question.revision,
    contextSegmentId: assignment.segmentId, projectionFingerprint,
  } };
}

/**
 * The continuity projector owns segment/anchor/visibility selection. This registry
 * does not widen it by fetching arbitrary model-supplied IDs or scanning history.
 * Assistant material may supply content or a target, never execution intent.
 * Historical user instructions need the separate Host-anchored continuation
 * check above as well as an explicit complete current-user confirmation.
 */
export function channelOperationVisibleSources(input: {
  readonly store: RunStore;
  readonly sourceItemId: string;
  readonly projection?: ConversationContextProjection;
}): readonly ChannelOperationVisibleSource[] {
  const projection = input.projection ?? buildConversationContextProjection({
    store: input.store, sourceItemId: input.sourceItemId, view: "selector",
  });
  return projection.items.flatMap((item): ChannelOperationVisibleSource[] => {
    if (item.status !== "committed" || (item.kind !== "user_message" && item.kind !== "assistant_message")
      || (item.actorType !== "local_user" && item.actorType !== "ling_agent" && item.actorType !== "teammate")) return [];
    return [{ itemId: item.id, body: item.payload.body, revision: item.revision, actorType: item.actorType }];
  });
}
