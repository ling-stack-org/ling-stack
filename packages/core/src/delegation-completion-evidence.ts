import type { DelegationMessageV1, DelegationStepV1 } from "@ling-stack/contracts";
import type { HostAttemptCompletionRecord } from "./host-attempt-completion-types.js";
import type { DelegationBudgetCharge, DelegationBudgetReservation, DelegationRootBudgetRecord } from "./harness/delegation-write-types.js";
import { delegationDigest } from "./harness/delegation-write-validation.js";
import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

/** A Host fact reference, never a projection row or model's claim of completion. */
export interface DelegationResultEvidenceRefV1 {
  readonly kind: "host_attempt_completion" | "delegation_budget_reservation" | "delegation_budget_charge";
  readonly id: string;
  readonly digest: string;
}

/** Sealed by the Host in the same transaction that terminalizes a delegated step. */
export interface DelegationResultV1 {
  readonly schemaVersion: 1;
  readonly kind: "delegation.result.v1";
  readonly stepId: string;
  readonly reservationId: string;
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly settlementDigest: string;
  readonly evidenceRefs: readonly DelegationResultEvidenceRefV1[];
}

/** Semantic fingerprints cover the whole original record without copying private prompts. */
export interface DelegationCompletionRunReadV1 {
  readonly id: string;
  readonly status: string;
  readonly parentRunId?: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly endedAt?: string;
  readonly fingerprint: string;
}

export interface DelegationCompletionWorkUnitReadV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly linkedRunId?: string;
  readonly activeAttemptId?: string;
  readonly endedAt?: string;
  readonly fingerprint: string;
}

export interface DelegationCompletionAttemptReadV1 {
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly status: string;
  readonly attemptNumber: number;
  readonly endedAt?: string;
  readonly abortRequestedAt?: string;
  readonly fingerprint: string;
}

export interface DelegationCompletionResultReadV1 {
  readonly message: DelegationMessageV1;
  readonly artifactId: string;
  readonly artifactRunId?: string;
  readonly artifactContentSha256?: string;
  readonly artifactPayloadSha256?: string;
  readonly artifactFingerprint?: string;
  readonly payload?: DelegationResultV1;
}

export interface DelegationCompletionRootReadV1 {
  readonly runId: string;
  readonly run?: DelegationCompletionRunReadV1;
  readonly budget?: DelegationRootBudgetRecord;
  readonly charges: readonly DelegationBudgetCharge[];
}

export interface DelegationCompletionStepReadV1 {
  readonly step: DelegationStepV1;
  readonly reservation?: DelegationBudgetReservation;
  /** Incoming edge outside the requested subtree is lineage, not required work. */
  readonly parentDelegationStep?: DelegationStepV1;
  readonly parentReservation?: DelegationBudgetReservation;
  readonly parentRun?: DelegationCompletionRunReadV1;
  readonly parentAttempt?: DelegationCompletionAttemptReadV1;
  readonly childRun?: DelegationCompletionRunReadV1;
  readonly workUnit?: DelegationCompletionWorkUnitReadV1;
  readonly attempt?: DelegationCompletionAttemptReadV1;
  readonly hostCompletion?: HostAttemptCompletionRecord;
  readonly quiescence: "verified" | "blocked" | "not_evaluated";
  readonly charges: readonly DelegationBudgetCharge[];
  readonly results: readonly DelegationCompletionResultReadV1[];
}

export type DelegationCompletionIssueCodeV1 =
  | "delegation.completion_limit_exceeded"
  | "delegation.completion_fact_invalid"
  | "delegation.completion_lineage_invalid"
  | "delegation.completion_budget_missing"
  | "delegation.completion_budget_unsettled"
  | "delegation.completion_usage_invalid"
  | "delegation.completion_result_invalid"
  | "delegation.completion_effects_unverified";

export interface DelegationCompletionIssueV1 {
  readonly code: DelegationCompletionIssueCodeV1;
  readonly stepId?: string;
  readonly runId?: string;
  readonly factFingerprint?: string;
}

export type DelegationCompletionStatusV1 = "satisfied" | "pending" | "blocked" | "failed" | "cancelled";

/**
 * Internal canonical read set. No checkedAt/observedAt is included: elapsed wall
 * time alone must not invalidate every compare-and-swap. The reader instead
 * records the current, expiry-sensitive effect/quiescence verdicts themselves.
 * Optional work is retained in the snapshot, not certified as physically stopped.
 */
export interface DelegationCompletionEvidenceV1 {
  readonly schemaVersion: 1;
  readonly rootRunIds: readonly string[];
  readonly roots: readonly DelegationCompletionRootReadV1[];
  readonly steps: readonly DelegationCompletionStepReadV1[];
  readonly issues: readonly DelegationCompletionIssueV1[];
  readonly status: DelegationCompletionStatusV1;
  readonly fingerprint: string;
}

export interface GetDelegationCompletionEvidenceInput {
  /** Descendant scope: a seed's own incoming delegation edge is not a child. */
  readonly rootRunIds: readonly string[];
}

export function delegationCompletionEvidenceFingerprintV1(
  value: Omit<DelegationCompletionEvidenceV1, "fingerprint">,
): string {
  return delegationDigest({ kind: "delegation.completion_evidence.v1", value });
}

/** Build the exact minimum refs shared by the producer and independent reader. */
export function delegationResultEvidenceRefsV1(input: {
  readonly completion: HostAttemptCompletionRecord;
  readonly reservation: DelegationBudgetReservation;
  readonly charges: readonly DelegationBudgetCharge[];
}): readonly DelegationResultEvidenceRefV1[] {
  return [
    { kind: "host_attempt_completion" as const, id: input.completion.source.attemptId, digest: delegationDigest(input.completion) },
    { kind: "delegation_budget_reservation" as const, id: input.reservation.id, digest: delegationDigest(input.reservation) },
    ...input.charges.map(charge => ({ kind: "delegation_budget_charge" as const, id: charge.id, digest: delegationDigest(charge) })),
  ].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

export function delegationCompletionRequiredStatusV1(input: {
  readonly steps: readonly DelegationCompletionStepReadV1[];
  readonly issues: readonly DelegationCompletionIssueV1[];
}): DelegationCompletionStatusV1 {
  if (input.issues.length) return "blocked";
  const required = input.steps.filter(({ step }) => step.required);
  if (required.some(({ step }) => step.state === "failed" || step.state === "lost")) return "failed";
  if (required.some(({ step }) => step.state === "cancelled")) return "cancelled";
  if (required.some(({ step }) => step.state !== "succeeded")) return "pending";
  return "satisfied";
}
