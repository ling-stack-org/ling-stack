import type { RunStatus } from "./shared.js";
import type { WorkUnitAttemptStatus, WorkUnitStatus } from "./runtime.js";

export type FrameworkAssuranceClaimStatus = "unclaimed" | "held" | "expired" | "terminal_retained";
export type FrameworkAssuranceEffectStatus = "none" | "confirmed" | "unknown";
export type FrameworkAssuranceStopExecutionStatus = "draining" | "drained" | "unverified";
export type FrameworkAssuranceStopEffectStatus = "settled" | "pending" | "unknown" | "unverified";
export type FrameworkAssuranceBudgetStatus = "within" | "pending" | "unknown" | "over" | "missing" | "invalid" | "not_applicable";
export type FrameworkAssuranceDimensionStatus = "within" | "pending" | "unknown" | "over" | "missing" | "invalid" | "not_applicable";

export interface FrameworkAssuranceComparison {
  readonly model: string;
  readonly reasoning: string;
  readonly executionStrategy: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
}

export interface FrameworkAssuranceExecutionLineage {
  readonly runId: string;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly runtimeInstanceId: string;
  readonly fencingToken: string;
  readonly runStatus: RunStatus;
  readonly workUnitStatus: WorkUnitStatus;
  readonly attemptStatus: WorkUnitAttemptStatus;
  readonly claimStatus: FrameworkAssuranceClaimStatus;
  readonly effectStatus: FrameworkAssuranceEffectStatus;
}

export interface FrameworkAssuranceSnapshotPin {
  /** Event position observed for the record; the digest remains the authority for change detection. */
  readonly revision: number;
  readonly sha256: string;
}

export interface FrameworkAssuranceArtifactPin {
  readonly role: string;
  readonly artifactId: string;
  readonly contentSha256: string;
}

export interface FrameworkAssuranceLifecycleAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly runtimeInstanceId: string;
  readonly fencingToken: string;
  readonly status: WorkUnitAttemptStatus;
  readonly isCurrent: boolean;
  readonly abortRequestedAt: string | null;
  readonly endedAt: string | null;
  readonly localExecution: FrameworkAssuranceStopExecutionStatus;
  readonly effects: FrameworkAssuranceStopEffectStatus;
}

export interface FrameworkAssuranceLifecycleEvidence {
  readonly status: "active" | "cancelling" | "terminal" | "draining" | "drained" | "unverified";
  readonly currentAttemptId: string;
  readonly currentGeneration: number;
  readonly attemptCount: number;
  readonly oldAttemptCount: number;
  readonly attempts: readonly FrameworkAssuranceLifecycleAttempt[];
  readonly stop: {
    readonly localExecution: FrameworkAssuranceStopExecutionStatus;
    readonly effects: FrameworkAssuranceStopEffectStatus;
    readonly allAttemptsTerminal: boolean;
    readonly reusable: boolean;
  };
}

export interface FrameworkAssuranceCompletionIssue {
  readonly code: string;
  readonly stepId: string | null;
  readonly runId: string | null;
  readonly factFingerprint: string | null;
}

export interface FrameworkAssuranceCompletionStep {
  readonly stepId: string;
  readonly required: boolean;
  readonly state: string;
  readonly childRunId: string | null;
  readonly attemptId: string | null;
  readonly reservationState: string | null;
  readonly completionStatus: "verified" | "pending" | "missing" | "invalid";
  readonly resultArtifacts: readonly FrameworkAssuranceArtifactPin[];
}

export interface FrameworkAssuranceCompletionEvidence {
  readonly status: "satisfied" | "pending" | "blocked" | "failed" | "cancelled" | "not_applicable";
  readonly rootRunIds: readonly string[];
  readonly fingerprint: string | null;
  readonly stepCount: number;
  readonly requiredStepCount: number;
  readonly completedStepCount: number;
  readonly steps: readonly FrameworkAssuranceCompletionStep[];
  readonly issues: readonly FrameworkAssuranceCompletionIssue[];
  readonly resultArtifacts: readonly FrameworkAssuranceArtifactPin[];
}

export interface FrameworkAssuranceBudgetRoot {
  readonly runId: string;
  readonly present: boolean;
  readonly tokenBudget: number | null;
  readonly costBudgetMicros: number | null;
  readonly deadlineAt: string | null;
  readonly chargeCount: number;
}

export interface FrameworkAssuranceBudgetReservation {
  readonly reservationId: string;
  readonly stepId: string;
  readonly state: string;
  readonly tokenReserved: number | null;
  readonly costReservedMicros: number | null;
  readonly settledTokenUsage: number | null;
  readonly settledCostMicros: number | null;
  readonly failureCode: string | null;
}

export interface FrameworkAssuranceBudgetCharge {
  readonly chargeId: string;
  readonly reservationId: string | null;
  readonly runId: string;
  readonly attemptId: string;
  readonly state: string;
  readonly reservedTokens: number | null;
  readonly reservedCostMicros: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly actualCostMicros: number | null;
}

export interface FrameworkAssuranceBudgetEvidence {
  readonly status: FrameworkAssuranceBudgetStatus;
  readonly roots: readonly FrameworkAssuranceBudgetRoot[];
  readonly reservations: readonly FrameworkAssuranceBudgetReservation[];
  readonly charges: readonly FrameworkAssuranceBudgetCharge[];
  readonly usage: {
    readonly tokenStatus: FrameworkAssuranceDimensionStatus;
    readonly costStatus: FrameworkAssuranceDimensionStatus;
    readonly tokens: number | null;
    readonly costMicros: number | null;
    readonly tokenLimit: number | null;
    readonly costLimitMicros: number | null;
  };
  readonly issues: readonly string[];
  readonly blockers: readonly string[];
}

export interface FrameworkAssuranceIsolationEffect {
  readonly effectKey: string;
  readonly kind: string;
  readonly status: string;
  readonly digest: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly payloadContentSha256: string;
}

export interface FrameworkAssuranceIsolationReceipt {
  readonly receiptId: string;
  readonly intentId: string;
  readonly outcome: string;
  readonly observedDigest: string;
  readonly artifactId: string;
  readonly artifactContentSha256: string;
}

export interface FrameworkAssuranceIsolationBranchResult {
  readonly workflowStepId: string;
  readonly status: string;
  readonly packetDigest: string | null;
  readonly packetContentSha256: string | null;
}

export interface FrameworkAssuranceIsolationEvidence {
  readonly status: "verified" | "pending" | "blocked" | "not_applicable" | "unavailable";
  readonly workflowId: string | null;
  readonly workflowStepId: string | null;
  readonly selection: { readonly profile: string; readonly roundId: string; readonly phase: string } | null;
  readonly safetyPlan: {
    readonly present: boolean;
    readonly valid: boolean;
    readonly profile: string | null;
    readonly digest: string | null;
    readonly toolsCount: number;
    readonly writeRootsCount: number;
    readonly networkAccess: false | "session_policy" | null;
  };
  readonly binding: {
    readonly status: "current" | "stale" | "invalid" | "missing" | "not_checked";
    readonly bindingId: string | null;
    readonly revision: number | null;
    readonly planDigest: string | null;
    readonly matchesCurrentFence: boolean;
  };
  readonly round: {
    readonly roundId: string;
    readonly generation: number;
    readonly revision: number;
    readonly phase: string;
    readonly lastConfirmedPhase: string;
    readonly candidate: {
      readonly commit: string;
      readonly tree: string;
      readonly packetDigest: string;
      readonly branchResultDigests: readonly string[];
      readonly validationDigest: string;
    } | null;
  } | null;
  readonly history: readonly {
    readonly roundId: string;
    readonly generation: number;
    readonly revision: number;
    readonly phase: string;
    readonly reason: string | null;
  }[];
  readonly effects: readonly FrameworkAssuranceIsolationEffect[];
  readonly receipts: readonly FrameworkAssuranceIsolationReceipt[];
  readonly branchResults: readonly FrameworkAssuranceIsolationBranchResult[];
  readonly approval: {
    readonly status: string;
    readonly approvalId: string | null;
    readonly requestId: string | null;
    readonly authorityDigest: string | null;
    readonly basisFingerprint: string | null;
  };
  readonly apply: { readonly status: string; readonly code: string | null; readonly intentPresent: boolean };
  readonly blockers: readonly string[];
}

export interface FrameworkAssuranceAdmissionEvidence {
  readonly status: "verified" | "blocked" | "not_applicable" | "unavailable";
  readonly profile: string | null;
  readonly safetyPlan: {
    readonly present: boolean;
    readonly valid: boolean;
    readonly digest: string | null;
  };
  readonly toolBroker: { readonly mode: "off" | "shadow" | "enforce"; readonly required: boolean; readonly satisfies: boolean };
  readonly binding: { readonly status: string; readonly matchesCurrentFence: boolean };
  readonly blockers: readonly string[];
}

/**
 * Read-only Host facts for framework-assurance. This surface deliberately omits
 * task input, claim tokens, resume handles, sealed payloads and artifact bodies.
 */
export interface FrameworkAssuranceEvidenceResponse {
  readonly schemaVersion: 1;
  readonly kind: "live_execution_evidence";
  readonly comparison: FrameworkAssuranceComparison;
  readonly execution: FrameworkAssuranceExecutionLineage;
  readonly snapshots: {
    readonly run: FrameworkAssuranceSnapshotPin;
    readonly workUnit: FrameworkAssuranceSnapshotPin;
    readonly attempt: FrameworkAssuranceSnapshotPin;
  };
  readonly artifacts: readonly FrameworkAssuranceArtifactPin[];
  readonly lifecycle: FrameworkAssuranceLifecycleEvidence;
  readonly completion: FrameworkAssuranceCompletionEvidence;
  readonly budget: FrameworkAssuranceBudgetEvidence;
  readonly isolation: FrameworkAssuranceIsolationEvidence;
  readonly admission: FrameworkAssuranceAdmissionEvidence;
  readonly observedAt: string;
  readonly limitations: readonly string[];
}
