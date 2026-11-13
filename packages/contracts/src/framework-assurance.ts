import type { RunStatus } from "./shared.js";
import type { WorkUnitAttemptStatus, WorkUnitStatus } from "./runtime.js";
import type { RunEvaluationGradeV1, RunEvaluationState } from "./harness.js";

export type FrameworkAssuranceClaimStatus = "unclaimed" | "held" | "expired" | "terminal_retained";
export type FrameworkAssuranceEffectStatus = "none" | "confirmed" | "unknown";
export type FrameworkAssuranceStopExecutionStatus = "draining" | "drained" | "unverified";
export type FrameworkAssuranceStopEffectStatus = "settled" | "pending" | "unknown" | "unverified";
export type FrameworkAssuranceBudgetStatus = "within" | "pending" | "unknown" | "over" | "missing" | "invalid" | "not_applicable";
export type FrameworkAssuranceDimensionStatus = "within" | "pending" | "unknown" | "over" | "missing" | "invalid" | "not_applicable";
export type FrameworkAssuranceRecoveryStatus = "verified" | "pending" | "blocked" | "not_applicable" | "unavailable";
export type FrameworkAssurancePolicyStatus = "current" | "drifted" | "missing" | "unavailable";
export type FrameworkAssuranceEvaluationStatus = "verified" | "pending" | "blocked" | "not_applicable" | "unavailable";

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

export interface FrameworkAssuranceRecoveryAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly runtimeInstanceId: string;
  readonly status: WorkUnitAttemptStatus;
}

export interface FrameworkAssuranceRecoveryEvidence {
  readonly status: FrameworkAssuranceRecoveryStatus;
  readonly source: FrameworkAssuranceRecoveryAttempt & {
    readonly localExecution: FrameworkAssuranceStopExecutionStatus;
    readonly effects: FrameworkAssuranceStopEffectStatus;
  } | null;
  readonly target: FrameworkAssuranceRecoveryAttempt | null;
  readonly continuation: {
    readonly continuationId: string;
    readonly origin: string;
    readonly state: string;
    readonly generation: number;
    readonly revision: number;
  } | null;
  readonly duplicateDispatch: {
    readonly status: "protected" | "detected" | "not_applicable" | "unknown";
    readonly continuationCount: number;
  };
  readonly blockers: readonly string[];
}

export interface FrameworkAssurancePolicyEvidence {
  readonly status: FrameworkAssurancePolicyStatus;
  readonly stored: {
    readonly present: boolean;
    readonly fingerprint: string | null;
    readonly updatedAt: string | null;
  };
  readonly current: {
    readonly available: boolean;
    readonly fingerprint: string | null;
    readonly updatedAt: string | null;
  };
  readonly blockers: readonly string[];
}

export interface FrameworkAssuranceEvaluationGrade {
  readonly gradeId: string;
  readonly evaluationId: string;
  readonly graderType: string;
  readonly graderId: string;
  readonly graderVersion: string;
  readonly verdict: string;
  readonly score: number | null;
  readonly severity: string | null;
  readonly costInputTokens: number | null;
  readonly costOutputTokens: number | null;
  readonly costAmountMicros: number | null;
  readonly gradeDigest: string;
  readonly chargeId: string | null;
  readonly chargeMatch: "matched" | "not_required" | "missing" | "non_unique" | "mismatch";
}

export interface FrameworkAssuranceEvaluationEvidence {
  readonly status: FrameworkAssuranceEvaluationStatus;
  readonly evaluation: {
    readonly id: string;
    readonly rootRunId: string;
    readonly runId: string;
    readonly state: RunEvaluationState;
    readonly revision: number;
    readonly evaluationKey: string;
  } | null;
  readonly grades: readonly FrameworkAssuranceEvaluationGrade[];
  readonly charges: readonly FrameworkAssuranceBudgetCharge[];
  readonly budget: {
    readonly rootRunId: string;
    readonly present: boolean;
    readonly tokenBudget: number | null;
    readonly costBudgetMicros: number | null;
  } | null;
  readonly blockers: readonly string[];
}

/**
 * Read-only Host facts for framework-assurance. This surface deliberately omits
 * task input, claim tokens, resume handles, sealed payloads and artifact bodies.
 */
export interface FrameworkAssuranceEvidenceResponse {
  readonly schemaVersion: 1;
  readonly kind: "live_execution_evidence";
  /** Always false on the live Host projection; the projection grants no execution authority. */
  readonly executionAuthorized?: false;
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
  readonly recovery?: FrameworkAssuranceRecoveryEvidence;
  readonly policy?: FrameworkAssurancePolicyEvidence;
  readonly evaluation?: FrameworkAssuranceEvaluationEvidence;
  readonly observedAt: string;
  readonly limitations: readonly string[];
}

export const FRAMEWORK_ASSURANCE_ASSOCIATION_FROZEN_INPUT_KEYS = [
  "suiteBytes", "taskBytes", "ruleBytes", "expectedBytes", "profileBytes", "lockBytes",
] as const;
export type FrameworkAssuranceAssociationFrozenInputKey =
  (typeof FRAMEWORK_ASSURANCE_ASSOCIATION_FROZEN_INPUT_KEYS)[number];

export type FrameworkAssuranceAssociationCode =
  | "association.invalid_request" | "association.workspace_uninitialized"
  | "association.read_failed" | "association.host_source_unavailable"
  | "association.lineage_mismatch" | "association.stale_attempt" | "association.snapshot_changed"
  | "association.frozen_input_missing" | "association.frozen_input_mismatch"
  | "association.mapping_mismatch" | "association.evaluation_missing"
  | "association.evaluation_identity_mismatch" | "association.evaluation_incomplete"
  | "association.artifact_missing" | "association.artifact_invalid"
  | "association.grade_missing" | "association.grade_invalid"
  | "association.attempt_binding_unavailable" | "association.grades_not_selected";

export interface FrameworkAssuranceAssociationArtifactPin {
  readonly artifactId: string;
  readonly contentSha256: string;
}

export interface FrameworkAssuranceAssociationTaskIdentity {
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly taskId: string;
  readonly taskVersion: string;
}

export type FrameworkAssuranceAssociationInputDigests =
  Readonly<Record<FrameworkAssuranceAssociationFrozenInputKey, string>>;

export interface FrameworkAssuranceAssociationObservation {
  readonly observationId: string;
  readonly invocationId: string;
  readonly caseId: string;
  readonly taskIdentity: FrameworkAssuranceAssociationTaskIdentity;
  readonly sourceCommit: string;
  readonly inputDigests: FrameworkAssuranceAssociationInputDigests;
  readonly comparison: FrameworkAssuranceComparison;
  readonly evidenceKind: "live_execution" | "fixture_replay";
  readonly assessment: "not_assessed";
}

export interface FrameworkAssuranceAssociationEvaluationIdentity {
  readonly rootRunId: string;
  readonly runId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly suiteArtifactId: string;
  readonly suiteDigest: string;
  readonly caseId: string;
  readonly caseVersion: string;
  readonly caseArtifactId: string;
  readonly caseDigest: string;
  readonly baselineId: string;
  readonly baselineVersion: string;
  readonly baselineArtifactId: string;
  readonly baselineDigest: string;
  readonly candidateArtifactId: string;
  readonly candidateDigest: string;
}

export type FrameworkAssuranceAssociationJsonValue =
  | null | boolean | number | string
  | readonly FrameworkAssuranceAssociationJsonValue[]
  | { readonly [key: string]: FrameworkAssuranceAssociationJsonValue };

export interface FrameworkAssuranceAssociationMapping {
  readonly schemaVersion: 1;
  readonly kind: "assurance_evaluation_mapping";
  readonly definitionEncoding: "json_parse_stringify_v1";
  readonly taskIdentity: FrameworkAssuranceAssociationTaskIdentity;
  readonly observationCaseId: string;
  readonly sourceCommit: string;
  readonly inputDigests: FrameworkAssuranceAssociationInputDigests;
  readonly evaluationIdentity: FrameworkAssuranceAssociationEvaluationIdentity;
  readonly candidate: FrameworkAssuranceAssociationArtifactPin & { readonly role: string };
}

export interface FrameworkAssuranceAssociationGradePin {
  readonly gradeId: string;
  readonly gradeDigest: string;
  readonly graderType: RunEvaluationGradeV1["graderType"];
  readonly graderId: string;
  readonly graderVersion: string;
  readonly rawOutputArtifact?: FrameworkAssuranceAssociationArtifactPin;
  readonly rationaleArtifact?: FrameworkAssuranceAssociationArtifactPin;
}

export type FrameworkAssuranceAssociationHostSource = Pick<
  FrameworkAssuranceEvidenceResponse, "comparison" | "execution" | "snapshots" | "artifacts"
>;

export interface FrameworkAssuranceAssociationRequest {
  readonly schemaVersion: 1;
  readonly observation: FrameworkAssuranceAssociationObservation;
  readonly source: FrameworkAssuranceAssociationHostSource;
  readonly evaluationId: string;
  readonly evaluationKey: string;
  readonly mapping: FrameworkAssuranceAssociationMapping;
  readonly mappingDigest: string;
  readonly gradePins: readonly FrameworkAssuranceAssociationGradePin[];
}

export interface FrameworkAssuranceAssociationResult {
  readonly schemaVersion: 1;
  readonly kind: "assurance_evaluation_association";
  readonly authority: "report-only";
  readonly assessment: "not_assessed";
  readonly enforcementAuthorized: false;
  readonly status: "matched" | "incomplete" | "unavailable" | "invalid";
  readonly observationId: string | null;
  readonly mappingDigest: string | null;
  readonly evaluation: {
    readonly id: string;
    readonly runId: string;
    readonly rootRunId: string;
    readonly state: RunEvaluationState;
    readonly revision: number;
    readonly evaluationKey: string;
  } | null;
  readonly binding: {
    readonly run: "matched" | "unavailable";
    readonly frozenInputs: "matched" | "unavailable";
    readonly candidateArtifact: "matched" | "unavailable";
  };
  readonly attemptBinding: {
    readonly status: "unavailable";
    readonly code: "association.attempt_binding_unavailable";
  };
  readonly grades: readonly {
    readonly gradeId: string;
    readonly gradeDigest: string;
    readonly graderType: RunEvaluationGradeV1["graderType"];
    readonly graderId: string;
    readonly graderVersion: string;
    readonly verdict: RunEvaluationGradeV1["verdict"];
    readonly score: number | null;
    readonly severity: RunEvaluationGradeV1["severity"] | null;
  }[];
  readonly diagnostics: readonly { readonly code: FrameworkAssuranceAssociationCode }[];
  readonly limitations: readonly string[];
}

/** JSON transport for the daemon's read-only association projection. */
export interface FrameworkAssuranceAssociationHttpRequest {
  readonly request: FrameworkAssuranceAssociationRequest;
  readonly frozenInputs: Readonly<Record<FrameworkAssuranceAssociationFrozenInputKey, string>>;
}
