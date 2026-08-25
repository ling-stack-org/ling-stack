import {
  isContextSegmentProposal,
  type ContextSegment,
  type ContextSegmentProposal,
  type ConversationDomainRef,
  type ConversationItemV1,
  type TurnContextAssignment,
} from "@ling-stack/contracts";
import type {
  ApplyTurnContextAssignmentResult,
  RunStore,
} from "@ling-stack/core";

export const CONTEXT_SEGMENTATION_POLICY_VERSION = "continuity-v2-segmentation-v1";

export interface ContextSegmentCandidateCard {
  readonly segmentId: string;
  readonly state: "provisional" | "active";
  readonly label?: string;
  readonly lastActiveTurnId: string;
  readonly objective?: string;
  readonly evidenceItemIds: readonly string[];
  readonly preview: readonly string[];
}

export interface ContextSegmentationBootstrapView {
  readonly sourceItemId: string;
  readonly turnId: string;
  readonly threadId: string;
  readonly currentBody: string;
  readonly explicitRefs: readonly ConversationDomainRef[];
  readonly candidates: readonly ContextSegmentCandidateCard[];
}

export type ProposeContextSegment = (
  view: ContextSegmentationBootstrapView,
  signal?: AbortSignal,
) => Promise<ContextSegmentProposal>;

export interface AssignContextSegmentInput {
  readonly store: RunStore;
  readonly sourceItemId: string;
  readonly explicitSegmentId?: string;
  readonly propose?: ProposeContextSegment;
  readonly proposalTimeoutMs?: number;
  readonly now: string;
}

export interface AssignContextSegmentResult extends ApplyTurnContextAssignmentResult {
  readonly resolution: "user" | "structural" | "model_policy" | "conservative_fallback";
  readonly proposal?: ContextSegmentProposal;
  readonly bootstrap?: ContextSegmentationBootstrapView;
  readonly fallbackReason?: "proposal_failed" | "proposal_timed_out" | "proposal_rejected";
}

export const DEFAULT_CONTEXT_SEGMENTATION_TIMEOUT_MS = 10_000;

export async function assignContextSegmentForTurn(
  input: AssignContextSegmentInput,
): Promise<AssignContextSegmentResult> {
  const sourceItem = requireSourceItem(input.store, input.sourceItemId);
  if (input.explicitSegmentId) {
    const applied = input.store.applyTurnContextAssignment({
      turnId: sourceItem.turnId!,
      target: { kind: "existing", segmentId: input.explicitSegmentId },
      status: "committed",
      decisionSource: "user",
      confidence: 1,
      evidenceRefs: [{ type: "conversation_item", id: sourceItem.id }],
      policyVersion: CONTEXT_SEGMENTATION_POLICY_VERSION,
    }, input.now);
    return { ...applied, resolution: "user" };
  }

  const recovered = recoverCompletedSegmentation(input.store, sourceItem.turnId!);
  if (recovered) return recovered;

  const structural = resolveStructuralAntecedent(input.store, sourceItem);
  if (structural) {
    const applied = input.store.applyTurnContextAssignment({
      turnId: sourceItem.turnId!,
      target: { kind: "existing", segmentId: structural.assignment.segmentId },
      status: "committed",
      decisionSource: "structural",
      confidence: 1,
      antecedentTurnId: structural.assignment.turnId,
      evidenceRefs: structural.evidenceRefs,
      policyVersion: CONTEXT_SEGMENTATION_POLICY_VERSION,
    }, input.now);
    return { ...applied, resolution: "structural" };
  }

  const currentAssignment = input.store.getEffectiveTurnContextAssignment(sourceItem.turnId!);
  if (!currentAssignment) throw new Error(`Context segmentation source has no bootstrap assignment: ${sourceItem.turnId}`);
  const bootstrap = buildContextSegmentationBootstrapView(input.store, sourceItem);
  if (!input.propose) {
    const applied = input.store.applyTurnContextAssignment({
      turnId: sourceItem.turnId!,
      target: { kind: "existing", segmentId: currentAssignment.segmentId },
      status: "provisional",
      decisionSource: "model_policy",
      confidence: 0.5,
      evidenceRefs: [{ type: "conversation_item", id: sourceItem.id }],
      policyVersion: CONTEXT_SEGMENTATION_POLICY_VERSION,
    }, input.now);
    return { ...applied, resolution: "conservative_fallback", bootstrap };
  }

  let proposal: ContextSegmentProposal;
  try {
    proposal = await proposeWithDeadline(
      input.propose,
      bootstrap,
      input.proposalTimeoutMs ?? DEFAULT_CONTEXT_SEGMENTATION_TIMEOUT_MS,
    );
    validateProposalAgainstBootstrap(input.store, proposal, bootstrap);
  } catch (error) {
    const applied = applyConservativeFallback(input.store, sourceItem, currentAssignment, input.now);
    return {
      ...applied,
      resolution: "conservative_fallback",
      bootstrap,
      fallbackReason: error instanceof ContextSegmentationTimeoutError
        ? "proposal_timed_out"
        : error instanceof ContextSegmentationProposalRejectedError
          ? "proposal_rejected"
          : "proposal_failed",
    };
  }
  const applied = applyModelProposal(input.store, sourceItem, currentAssignment, proposal, input.now);
  return { ...applied, resolution: "model_policy", proposal, bootstrap };
}

function recoverCompletedSegmentation(
  store: RunStore,
  turnId: string,
): AssignContextSegmentResult | undefined {
  const assignment = store.getEffectiveTurnContextAssignment(turnId);
  if (!assignment || assignment.policyVersion !== CONTEXT_SEGMENTATION_POLICY_VERSION) return undefined;
  const segment = store.getContextSegment(assignment.segmentId);
  if (!segment) throw new Error(`Context segmentation checkpoint references a missing segment: ${assignment.segmentId}`);
  return {
    segment,
    assignment,
    previousAssignment: assignment,
    invalidatedSummaryIds: [],
    idempotentReplay: true,
    resolution: assignment.decisionSource === "user"
      ? "user"
      : assignment.decisionSource === "structural"
        ? "structural"
        : assignment.status === "provisional"
          ? "conservative_fallback"
          : "model_policy",
  };
}

export function parseContextSegmentProposal(text: string): ContextSegmentProposal {
  const normalized = text.trim();
  const json = normalized.startsWith("```")
    ? normalized.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim()
    : normalized;
  const parsed = JSON.parse(json) as unknown;
  if (!isContextSegmentProposal(parsed)) {
    throw new Error("Context segmentation model output does not match the v2 proposal contract.");
  }
  return parsed;
}

export function buildContextSegmentationBootstrapView(
  store: RunStore,
  sourceItem: ConversationItemV1,
): ContextSegmentationBootstrapView {
  if (sourceItem.kind !== "user_message" || !sourceItem.turnId) {
    throw new Error(`Context segmentation requires a user turn item: ${sourceItem.id}`);
  }
  const segments = store.listContextSegments({
    threadId: sourceItem.threadId,
    states: ["active", "provisional"],
    limit: 24,
  });
  const candidates = segments.map((segment) => buildCandidateCard(store, sourceItem, segment));
  return {
    sourceItemId: sourceItem.id,
    turnId: sourceItem.turnId,
    threadId: sourceItem.threadId,
    currentBody: sourceItem.payload.body,
    explicitRefs: uniqueDomainRefs([
      ...(sourceItem.payload.replyToItemId
        ? [{ type: "conversation_item" as const, id: sourceItem.payload.replyToItemId }]
        : []),
      ...(sourceItem.payload.quotedItemIds ?? []).map((id) => ({ type: "conversation_item" as const, id })),
      ...sourceItem.domainRefs,
    ]),
    candidates,
  };
}

function resolveStructuralAntecedent(
  store: RunStore,
  sourceItem: ConversationItemV1,
): { readonly assignment: TurnContextAssignment; readonly evidenceRefs: readonly ConversationDomainRef[] } | undefined {
  if (sourceItem.kind !== "user_message" || !sourceItem.turnId) return undefined;
  const currentTurn = store.getLingTurn(sourceItem.turnId);
  if (currentTurn?.sourceTurnId) {
    const assignment = store.getEffectiveTurnContextAssignment(currentTurn.sourceTurnId);
    if (assignment) {
      return {
        assignment,
        evidenceRefs: [{ type: "turn", id: currentTurn.sourceTurnId }],
      };
    }
  }
  const explicitItemIds = [
    sourceItem.payload.replyToItemId,
    ...(sourceItem.payload.quotedItemIds ?? []),
  ].filter((id): id is string => Boolean(id));
  for (const itemId of explicitItemIds) {
    const antecedent = store.getEffectiveConversationItem(itemId);
    if (!antecedent?.turnId || antecedent.threadId !== sourceItem.threadId) continue;
    const assignment = store.getEffectiveTurnContextAssignment(antecedent.turnId);
    if (assignment) {
      return {
        assignment,
        evidenceRefs: [{ type: "conversation_item", id: antecedent.id }],
      };
    }
  }
  for (const ref of sourceItem.domainRefs.filter(isStructuralWorkRef)) {
    const antecedent = store.findConversationItemByDomainRef({
      threadId: sourceItem.threadId,
      ref,
      beforeSequence: sourceItem.sequence,
    });
    if (!antecedent?.turnId) continue;
    const assignment = store.getEffectiveTurnContextAssignment(antecedent.turnId);
    if (assignment) return { assignment, evidenceRefs: [ref, { type: "conversation_item", id: antecedent.id }] };
  }
  const thread = store.getLingThread(sourceItem.threadId);
  if (thread && sourceItem.sequence === 1) {
    const assignment = store.getEffectiveTurnContextAssignment(sourceItem.turnId);
    if (assignment) return { assignment, evidenceRefs: [{ type: "thread", id: thread.id }] };
  }
  return undefined;
}

function buildCandidateCard(
  store: RunStore,
  sourceItem: ConversationItemV1,
  segment: ContextSegment,
): ContextSegmentCandidateCard {
  if (segment.state !== "active" && segment.state !== "provisional") {
    throw new Error(`Context segmentation candidate is not selectable: ${segment.id}`);
  }
  const summaries = store.listConversationContextSummaries({
    threadId: sourceItem.threadId,
    segmentId: segment.id,
    statuses: ["active"],
    throughSequence: sourceItem.sequence,
    limit: 4,
  });
  const items = store.listConversationItemsForSegment({
    threadId: sourceItem.threadId,
    segmentId: segment.id,
    throughSequence: sourceItem.sequence,
    limit: 12,
  }).filter((item) => item.id !== sourceItem.id && item.visibility === "channel");
  const evidenceItems = items.slice(-4);
  const latestEvidenceTurnId = [...evidenceItems].reverse().find((item) => item.turnId)?.turnId;
  return {
    segmentId: segment.id,
    state: segment.state,
    ...(segment.label ? { label: segment.label } : {}),
    lastActiveTurnId: latestEvidenceTurnId ?? segment.lastActiveTurnId,
    ...(summaries[0]?.objective ? { objective: summaries[0].objective } : {}),
    evidenceItemIds: evidenceItems.map((item) => item.id),
    preview: evidenceItems.map(candidatePreview),
  };
}

function validateProposalAgainstBootstrap(
  store: RunStore,
  proposal: ContextSegmentProposal,
  bootstrap: ContextSegmentationBootstrapView,
): void {
  const candidateIds = new Set(bootstrap.candidates.map((candidate) => candidate.segmentId));
  const evidenceIds = new Set(bootstrap.candidates.flatMap((candidate) => candidate.evidenceItemIds));
  evidenceIds.add(bootstrap.sourceItemId);
  for (const ref of bootstrap.explicitRefs) {
    if (ref.type === "conversation_item") evidenceIds.add(ref.id);
  }
  if (proposal.action === "continue" || proposal.action === "switch_existing") {
    if (!candidateIds.has(proposal.segmentId)) {
      throw new ContextSegmentationProposalRejectedError(`Context segmentation model invented or cannot access segment: ${proposal.segmentId}`);
    }
    for (const itemId of proposal.evidenceItemIds) {
      if (!evidenceIds.has(itemId)) {
        throw new ContextSegmentationProposalRejectedError(`Context segmentation model invented or cannot access evidence item: ${itemId}`);
      }
    }
    if (proposal.antecedentTurnId) {
      const candidate = bootstrap.candidates.find((entry) => entry.segmentId === proposal.segmentId);
      if (candidate?.lastActiveTurnId !== proposal.antecedentTurnId) {
        throw new ContextSegmentationProposalRejectedError(`Context segmentation model invented or cannot access antecedent turn: ${proposal.antecedentTurnId}`);
      }
      const antecedent = store.getEffectiveTurnContextAssignment(proposal.antecedentTurnId);
      if (!antecedent || antecedent.segmentId !== proposal.segmentId) {
        throw new ContextSegmentationProposalRejectedError(`Context segmentation antecedent does not belong to proposed segment: ${proposal.antecedentTurnId}`);
      }
    }
    return;
  }
  const referencedIds = proposal.action === "propose_new"
    ? proposal.relatedSegmentIds
    : proposal.candidateSegmentIds;
  for (const segmentId of referencedIds) {
    if (!candidateIds.has(segmentId)) {
      throw new ContextSegmentationProposalRejectedError(`Context segmentation model invented or cannot access segment: ${segmentId}`);
    }
  }
}

function applyConservativeFallback(
  store: RunStore,
  sourceItem: ConversationItemV1,
  currentAssignment: TurnContextAssignment,
  now: string,
): ApplyTurnContextAssignmentResult {
  return store.applyTurnContextAssignment({
    turnId: sourceItem.turnId!,
    target: { kind: "existing", segmentId: currentAssignment.segmentId },
    status: "provisional",
    decisionSource: "model_policy",
    confidence: 0.5,
    evidenceRefs: [{ type: "conversation_item", id: sourceItem.id }],
    policyVersion: CONTEXT_SEGMENTATION_POLICY_VERSION,
  }, now);
}

async function proposeWithDeadline(
  propose: ProposeContextSegment,
  view: ContextSegmentationBootstrapView,
  timeoutMs: number,
): Promise<ContextSegmentProposal> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError(`Invalid context segmentation timeout: ${timeoutMs}`);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ContextSegmentationTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([propose(view, controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ContextSegmentationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Context segmentation proposal exceeded ${timeoutMs}ms.`);
  }
}

class ContextSegmentationProposalRejectedError extends Error {}

function applyModelProposal(
  store: RunStore,
  sourceItem: ConversationItemV1,
  currentAssignment: TurnContextAssignment,
  proposal: ContextSegmentProposal,
  now: string,
): ApplyTurnContextAssignmentResult {
  if (!sourceItem.turnId) throw new Error(`Context segmentation source has no turn: ${sourceItem.id}`);
  if (proposal.action === "continue" || proposal.action === "switch_existing") {
    return store.applyTurnContextAssignment({
      turnId: sourceItem.turnId,
      target: { kind: "existing", segmentId: proposal.segmentId },
      status: "committed",
      decisionSource: "model_policy",
      confidence: proposal.confidence,
      ...(proposal.antecedentTurnId ? { antecedentTurnId: proposal.antecedentTurnId } : {}),
      evidenceRefs: proposal.evidenceItemIds.map((id) => ({ type: "conversation_item", id })),
      policyVersion: CONTEXT_SEGMENTATION_POLICY_VERSION,
    }, now);
  }
  if (proposal.action === "propose_new") {
    const active = proposal.confidence >= 0.85;
    return store.applyTurnContextAssignment({
      turnId: sourceItem.turnId,
      target: {
        kind: "new",
        state: active ? "active" : "provisional",
        label: segmentLabel(sourceItem, proposal.reason),
      },
      status: active ? "committed" : "provisional",
      decisionSource: "model_policy",
      confidence: proposal.confidence,
      evidenceRefs: proposal.relatedSegmentIds.map((id) => ({ type: "segment", id })),
      policyVersion: CONTEXT_SEGMENTATION_POLICY_VERSION,
    }, now);
  }
  const selectedSegmentId = proposal.candidateSegmentIds[0] ?? currentAssignment.segmentId;
  return store.applyTurnContextAssignment({
    turnId: sourceItem.turnId,
    target: { kind: "existing", segmentId: selectedSegmentId },
    status: "provisional",
    decisionSource: "model_policy",
    confidence: 0.5,
    evidenceRefs: [{ type: "conversation_item", id: sourceItem.id }],
    policyVersion: CONTEXT_SEGMENTATION_POLICY_VERSION,
  }, now);
}

function requireSourceItem(store: RunStore, sourceItemId: string): ConversationItemV1 {
  const item = store.getConversationItem(sourceItemId);
  if (!item || item.kind !== "user_message" || !item.turnId || item.status !== "committed") {
    throw new Error(`Context segmentation source must be a committed user turn item: ${sourceItemId}`);
  }
  return item;
}

function isStructuralWorkRef(ref: ConversationDomainRef): boolean {
  return ref.type === "run"
    || ref.type === "task"
    || ref.type === "workflow"
    || ref.type === "workflow_step"
    || ref.type === "approval"
    || ref.type === "artifact"
    || ref.type === "handoff"
    || ref.type === "operation"
    || ref.type === "external_work"
    || ref.type === "automation";
}

function candidatePreview(item: ConversationItemV1): string {
  const text = item.kind === "user_message" || item.kind === "assistant_message"
    ? item.payload.body
    : item.kind === "system_event"
      ? item.payload.summary
      : item.kind;
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function segmentLabel(sourceItem: ConversationItemV1, reason: string): string {
  const body = sourceItem.kind === "user_message" ? sourceItem.payload.body : "";
  const compact = (body || reason).replace(/\s+/gu, " ").trim();
  return compact ? compact.slice(0, 160) : "New context";
}

function uniqueDomainRefs(refs: readonly ConversationDomainRef[]): ConversationDomainRef[] {
  const byKey = new Map<string, ConversationDomainRef>();
  for (const ref of refs) byKey.set(`${ref.type}:${ref.id}`, ref);
  return [...byKey.values()];
}
