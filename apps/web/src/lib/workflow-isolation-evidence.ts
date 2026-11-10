import type { ConversationTimelineItem, ConversationTimelineProtocolEventItem } from "@ling-stack/conversation-ui-core";
import type { Translate } from "../i18n.js";
import type { ChannelWorkflow, ChannelWorkflowStep, WorkflowIntegrationRoundEvidenceV1, WorkflowIsolationEvidenceV1 } from "../types.js";

/** A read projection, never an execution receipt or merge authority. */
export interface WorkflowIsolationObservation {
  readonly status: "loading" | "loaded" | "error";
  readonly expected: boolean;
  readonly isolation?: WorkflowIsolationEvidenceV1;
}

export type WorkflowIntegrationDisplayState = "preparing" | "collecting" | "integrating" | "verifying"
  | "candidate_only" | "pending_approval" | "approved_not_applied" | "applying" | "applied"
  | "conflicted" | "failed" | "blocked" | "unknown";

export interface WorkflowIsolationPresentation {
  readonly summary: string;
  readonly attention: "none" | "waiting" | "blocked" | "failed";
  readonly settled: boolean;
  readonly items: readonly ConversationTimelineProtocolEventItem[];
  readonly updatedAt?: string;
}

/** The retained DTO is authoritative; a plan pin is only an initial read/discovery hint. */
export function workflowHasIsolationPlan(steps: readonly ChannelWorkflowStep[]): boolean {
  return steps.some(step => step.metadata && "isolationScopePlan" in step.metadata && Boolean(step.metadata.isolationScopePlan));
}

export function workflowIntegrationDisplayState(round: WorkflowIntegrationRoundEvidenceV1): WorkflowIntegrationDisplayState {
  if (round.phase === "conflicted" || round.phase === "failed" || round.phase === "blocked") return round.phase;
  if (round.application.status === "effect_unknown" || round.application.status === "invalid"
    || round.effects.some(effect => effect.status === "effect_unknown")) return "unknown";
  if (round.application.status === "blocked" || round.effects.some(effect => effect.status === "blocked")) return "blocked";
  if (round.phase === "applied" || round.application.status === "applied") {
    return round.mode === "apply_to_target" && round.phase === "applied" && round.application.status === "applied" ? "applied" : "unknown";
  }
  if (round.phase === "applying" || round.application.status === "pending") return "applying";
  if (round.phase === "awaiting_approval") {
    if (!round.candidate) return "unknown";
    if (round.mode === "candidate_only") return "candidate_only";
    if (round.approval?.status === "pending") return "pending_approval";
    if (round.approval?.status === "approved") return "approved_not_applied";
    return round.approval ? "blocked" : "unknown";
  }
  return round.phase;
}

function hasUnconfirmedEffects(evidence: WorkflowIsolationEvidenceV1): boolean {
  return evidence.gitEffects !== "confirmed" || evidence.hostOperationPending
    || evidence.rounds.some(round => round.application.status === "effect_unknown" || round.application.status === "invalid"
      || round.effects.some(effect => effect.status === "pending" || effect.status === "effect_unknown"));
}

export function shouldPollWorkflowIsolation(observation: WorkflowIsolationObservation, workflow: ChannelWorkflow): boolean {
  if (!observation.expected && !observation.isolation) return false;
  if (observation.status !== "loaded") return true;
  const evidence = observation.isolation;
  if (!evidence || evidence.schemaVersion !== 1 || evidence.status !== "available" || evidence.rounds.length === 0) return true;
  if (hasUnconfirmedEffects(evidence)) return true;
  const latest = orderedRounds(evidence.rounds).at(-1)!;
  const state = workflowIntegrationDisplayState(latest);
  if (["preparing", "collecting", "integrating", "verifying", "approved_not_applied", "applying", "unknown"].includes(state)) return true;
  // Journal confirmation alone says nothing about a live Attempt or its descendants.
  return workflow.status === "running" || workflow.status === "ready" || workflow.status === "waiting_for_approval"
    || workflow.status === "waiting_for_input" || state === "pending_approval";
}

const roundStateKeys: Record<WorkflowIntegrationDisplayState, string> = {
  preparing: "Preparing integration",
  collecting: "Waiting for branch results",
  integrating: "Integrating branch results",
  verifying: "Verifying integration candidate",
  candidate_only: "Candidate only; target unchanged",
  pending_approval: "Awaiting merge approval",
  approved_not_applied: "Merge approved; not yet applied",
  applying: "Applying candidate to target",
  applied: "Applied to target",
  conflicted: "Integration conflicted",
  failed: "Integration failed",
  blocked: "Integration blocked",
  unknown: "Integration result unconfirmed",
};

function roundTimelineStatus(state: WorkflowIntegrationDisplayState): ConversationTimelineProtocolEventItem["status"] {
  if (state === "conflicted" || state === "blocked") return "blocked";
  if (state === "failed") return "failed";
  if (state === "candidate_only" || state === "applied") return "succeeded";
  if (state === "pending_approval" || state === "approved_not_applied" || state === "unknown") return "waiting";
  return "running";
}

function orderedRounds(rounds: readonly WorkflowIntegrationRoundEvidenceV1[]): WorkflowIntegrationRoundEvidenceV1[] {
  return [...rounds].sort((left, right) => left.generation - right.generation || left.roundId.localeCompare(right.roundId));
}

/** A repair affordance only; the Host must prove selection, drain and parent ownership. */
export function workflowConflictRecoveryRound(workflow: ChannelWorkflow, observation?: WorkflowIsolationObservation): WorkflowIntegrationRoundEvidenceV1 | undefined {
  const evidence = observation?.isolation;
  if (observation?.status !== "loaded" || !evidence || evidence.schemaVersion !== 1 || evidence.status !== "available"
    || evidence.rounds.length !== 1 || hasUnconfirmedEffects(evidence) || !["blocked", "running", "failed"].includes(workflow.status)) return;
  const round = evidence.rounds[0];
  if (round.phase !== "conflicted" || round.reasonCode !== "workflow_integration.text_conflict"
    || round.mode !== "candidate_only" || round.maxConcurrentSteps < 2 || round.maxConcurrentSteps > 4 || round.candidate || round.approval
    || !["not_started", "not_applied"].includes(round.application.status)
    || round.effects.some(effect => effect.status !== "confirmed")) return;
  return round;
}

export function isWorkflowIsolationTimelineItem(item: ConversationTimelineItem): boolean {
  return item.kind === "protocolEvent" && item.protocolKind === "workflow" && item.id.startsWith("workflow-isolation:");
}

export function buildWorkflowIsolationPresentation(input: {
  readonly workflow: ChannelWorkflow;
  readonly observation?: WorkflowIsolationObservation;
  readonly t: Translate;
}): WorkflowIsolationPresentation | undefined {
  const { workflow, observation, t } = input;
  if (!observation || observation.status !== "error" && !observation.expected && !observation.isolation) return undefined;
  const evidence = observation.isolation;
  const rounds = evidence?.schemaVersion === 1 ? orderedRounds(evidence.rounds) : [];
  const unavailable = observation.status !== "loaded" || !evidence || evidence.schemaVersion !== 1
    || evidence.status !== "available" || rounds.length === 0;
  const latest = rounds.at(-1);
  const state = unavailable ? "unknown" : workflowIntegrationDisplayState(latest!);
  const unconfirmed = unavailable || hasUnconfirmedEffects(evidence!);
  const terminalRound = ["candidate_only", "applied", "conflicted", "failed", "blocked"].includes(state);
  const settled = !unconfirmed && evidence?.completion === "ready" && terminalRound;
  const completionBlocked = !unavailable && evidence?.completion !== "ready";
  const explicitFailure = state === "conflicted" || state === "failed" || state === "blocked";
  const resultLabel = unavailable || unconfirmed && terminalRound && !explicitFailure ? t("Integration result unconfirmed")
    : explicitFailure ? t(roundStateKeys[state])
    : completionBlocked && terminalRound ? t("Integration completion blocked") : t(roundStateKeys[state]);
  // Completion can be blocked by cancellation without any unknown journal effect.
  const summary = workflow.status === "cancelled"
    ? unconfirmed ? t("Workflow cancelled; integration result unconfirmed") : t("Workflow cancelled")
    : workflow.status === "failed" ? t("Workflow failed; {integration}", { integration: resultLabel }) : resultLabel;
  const revision = Math.max(0, ...rounds.map(round => round.revision));
  const sourceRefs = [{ kind: "workflow", id: workflow.id }];
  const detailLines = [
    ...(evidence?.hostOperationPending ? [t("Host operations still draining")] : []),
    ...(unconfirmed ? [t("Integration result unconfirmed")] : []),
    ...(completionBlocked ? [t("Integration completion blocked")] : []),
    ...[evidence?.reasonCode, evidence?.publicationBlockerCode, evidence?.completionBlockerCode].filter((code): code is string => Boolean(code)),
  ];
  const items: ConversationTimelineProtocolEventItem[] = [{
    id: `workflow-isolation:${workflow.id}:observation`, kind: "protocolEvent", protocolKind: "workflow",
    revision, threadSequence: 0, partIndex: 0, sourceRefs,
    title: workflow.status === "cancelled" ? t("Workflow cancelled")
      : observation.status === "error" ? t("Workflow evidence unavailable") : t("Workflow integration"),
    meta: unconfirmed && !explicitFailure ? t("Integration result unconfirmed") : resultLabel,
    status: workflow.status === "cancelled" ? "cancelled" : explicitFailure ? roundTimelineStatus(state) : unconfirmed && terminalRound || unavailable ? "waiting"
      : completionBlocked && terminalRound ? "blocked" : roundTimelineStatus(state),
    description: detailLines.length ? [...new Set(detailLines)].join("\n") : undefined,
    ...(!unavailable && !unconfirmed && state === "pending_approval" && latest?.approval
      && !["cancelled", "failed"].includes(workflow.status) ? { approvalId: latest.approval.approvalId } : {}),
  }];
  for (const [index, round] of rounds.entries()) {
    const roundState = workflowIntegrationDisplayState(round);
    const canOpenApproval = !unavailable && !unconfirmed && round === latest && roundState === "pending_approval"
      && workflow.status !== "cancelled" && workflow.status !== "failed";
    const canRecoverConflict = workflowConflictRecoveryRound(workflow, observation) === round;
    const codes = [round.reasonCode, round.approval?.reasonCode, round.application.reasonCode].filter((code): code is string => Boolean(code));
    const description = [
      t("Integration round {round} · generation {generation}", { round: round.roundId, generation: round.generation }),
      t("{count} integration participants", { count: round.participants.length }),
      t(round.mode === "candidate_only" ? "Candidate-only round" : "Apply-to-target round"),
      ...(round.candidate ? [t("Candidate commit: {commit}", { commit: round.candidate.commit }), t("Candidate tree: {tree}", { tree: round.candidate.tree })] : []),
      ...(round.approval ? [t("Merge approval: {status}", { status: t(approvalStatusKeys[round.approval.status]) })] : []),
      ...(roundState === "unknown" ? [t("Last confirmed phase: {phase}", { phase: t(roundPhaseKeys[round.lastConfirmedPhase]) })] : []),
      ...codes,
    ].join("\n");
    items.push({
      id: `workflow-isolation:${workflow.id}:round:${round.roundId}:${round.generation}`, kind: "protocolEvent", protocolKind: "workflow",
      revision: round.revision, threadSequence: 0, partIndex: index + 1,
      sourceRefs: [...sourceRefs, { kind: "workflow_integration_round", id: `${round.roundId}:${round.generation}` },
        ...round.effects.flatMap(effect => effect.artifactIds.map(id => ({ kind: "artifact", id })))],
      title: t("Integration round {generation}", { generation: round.generation }),
      meta: unavailable ? t("Integration result unconfirmed") : t(roundStateKeys[roundState]),
      status: unavailable ? "waiting" : roundTimelineStatus(roundState), description,
      ...(canOpenApproval ? { approvalId: round.approval!.approvalId, availableActions: ["open_approval" as const] } : {}),
      ...(canRecoverConflict ? { availableActions: ["recover_workflow_conflict" as const] } : {}),
    });
  }
  return {
    summary, settled, items,
    attention: state === "failed" ? "failed" : state === "conflicted" || state === "blocked" || completionBlocked && terminalRound ? "blocked"
      : !settled ? "waiting" : "none",
    updatedAt: rounds.map(round => round.updatedAt).sort().at(-1),
  };
}

const approvalStatusKeys: Record<NonNullable<WorkflowIntegrationRoundEvidenceV1["approval"]>["status"], string> = {
  pending: "Pending", approved: "Approved", denied: "Denied", expired: "Expired", cancelled: "Cancelled", blocked: "Blocked",
};
const roundPhaseKeys: Record<WorkflowIntegrationRoundEvidenceV1["phase"], string> = {
  preparing: "Preparing integration", collecting: "Waiting for branch results", integrating: "Integrating branch results",
  verifying: "Verifying integration candidate", awaiting_approval: "Awaiting merge approval", applying: "Applying candidate to target",
  applied: "Applied to target", conflicted: "Integration conflicted", failed: "Integration failed", blocked: "Integration blocked",
};
