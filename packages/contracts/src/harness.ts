export const HARNESS_MODES = ["off", "shadow", "enforce"] as const;
export type HarnessMode = (typeof HARNESS_MODES)[number];

export const RUNNER_CONTINUATION_ORIGINS = [
  "manual_resume",
  "queued_followup",
  "interrupt_redirect",
  "approval_resume",
  "runner_retry",
  "daemon_recovery",
] as const;
export type RunnerContinuationOrigin = (typeof RUNNER_CONTINUATION_ORIGINS)[number];

export const RUNNER_CONTINUATION_STRATEGIES = ["native_resume", "deterministic_replay"] as const;
export type RunnerContinuationStrategy = (typeof RUNNER_CONTINUATION_STRATEGIES)[number];

export const RUNNER_CONTINUATION_STATES = [
  "requested",
  "prepared",
  "claimed",
  "running",
  "recovery_pending",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type RunnerContinuationState = (typeof RUNNER_CONTINUATION_STATES)[number];

export const RUNNER_CONTINUATION_FAILURE_CODES = [
  "continuation.handle_missing",
  "continuation.handle_rejected",
  "continuation.context_snapshot_missing",
  "continuation.source_attempt_stale",
  "continuation.target_attempt_lost",
  "continuation.runner_not_conformant",
] as const;
export type RunnerContinuationFailureCode = (typeof RUNNER_CONTINUATION_FAILURE_CODES)[number];

export const HARNESS_TOOL_EXECUTION_STATES = [
  "proposed",
  "prepared",
  "approval_pending",
  "approved",
  "claimed",
  "executing",
  "committing_evidence",
  "succeeded",
  "denied",
  "failed",
  "cancelled",
  "superseded",
  "unknown_outcome",
] as const;
export type HarnessToolExecutionState = (typeof HARNESS_TOOL_EXECUTION_STATES)[number];
export type HarnessToolExecutorKind = "bash" | "apply_patch" | "write";

export const HARNESS_TOOL_EXECUTION_FAILURE_CODES = [
  "tool.invalid_request",
  "tool.policy_denied",
  "tool.approval_denied",
  "tool.sandbox_unavailable",
  "tool.executor_failed",
  "tool.execution_timeout",
  "tool.execution_cancelled",
  "tool.stale_attempt",
  "tool.evidence_commit_failed",
  "tool.unknown_side_effect_outcome",
] as const;
export type HarnessToolExecutionFailureCode = (typeof HARNESS_TOOL_EXECUTION_FAILURE_CODES)[number];

export const RUN_EVALUATION_STATES = ["queued", "claimed", "grading", "completed", "failed", "cancelled"] as const;
export type RunEvaluationState = (typeof RUN_EVALUATION_STATES)[number];
export const RUN_EVALUATION_GRADER_TYPES = ["rule", "model", "human"] as const;
export type RunEvaluationGraderType = (typeof RUN_EVALUATION_GRADER_TYPES)[number];
export const RUN_EVALUATION_VERDICTS = ["pass", "fail", "abstain", "error"] as const;
export type RunEvaluationVerdict = (typeof RUN_EVALUATION_VERDICTS)[number];
export const RUN_EVALUATION_SEVERITIES = ["info", "warning", "error", "critical"] as const;
export type RunEvaluationSeverity = (typeof RUN_EVALUATION_SEVERITIES)[number];

export const RUN_EVALUATION_FAILURE_CODES = [
  "evaluation.grader_unavailable",
  "evaluation.invalid_suite_version",
  "evaluation.baseline_missing",
  "evaluation.lease_expired",
  "evaluation.result_invalid",
] as const;
export type RunEvaluationFailureCode = (typeof RUN_EVALUATION_FAILURE_CODES)[number];

export const DELEGATION_STEP_STATES = [
  "planned",
  "spawning",
  "running",
  "waiting",
  "interrupting",
  "interrupted",
  "resuming",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const;
export type DelegationStepState = (typeof DELEGATION_STEP_STATES)[number];
export type DelegationMessageDirection = "parent_to_child" | "child_to_parent";
export type DelegationMessageKind = "instruction" | "progress" | "result" | "control";

export const DELEGATION_FAILURE_CODES = [
  "delegation.capability_escalation",
  "delegation.budget_exhausted",
  "delegation.depth_exceeded",
  "delegation.cycle_detected",
  "delegation.child_lost",
  "delegation.required_child_failed",
] as const;
export type DelegationFailureCode = (typeof DELEGATION_FAILURE_CODES)[number];

export interface HarnessLeaseV1 {
  readonly claimOwner?: string;
  /** Unique claim generation. Prevents ABA when a restarted worker reuses an owner id. */
  readonly claimToken?: string;
  readonly claimExpiresAt?: string;
  readonly nextAttemptAt?: string;
}

export interface RunnerContinuationV1 extends HarnessLeaseV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly sourceAttemptId: string;
  readonly targetAttemptId?: string;
  readonly origin: RunnerContinuationOrigin;
  readonly strategy: RunnerContinuationStrategy;
  readonly state: RunnerContinuationState;
  readonly runnerId: string;
  readonly runnerCapabilityRevision: string;
  readonly contextViewId: string;
  readonly contextSnapshotArtifactId: string;
  readonly runnerHandleRef?: string;
  readonly idempotencyKey: string;
  readonly generation: number;
  readonly revision: number;
  readonly failureCode?: RunnerContinuationFailureCode;
  readonly failureDetailArtifactId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface HarnessToolExecutionV1 extends HarnessLeaseV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly continuationId?: string;
  readonly delegationStepId?: string;
  /** Prior pre-effect execution replaced after approval recovery created a new Attempt. */
  readonly supersedesExecutionId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly executorKind: HarnessToolExecutorKind;
  readonly state: HarnessToolExecutionState;
  readonly requestDigest: string;
  readonly sideEffectFingerprint: string;
  readonly policySnapshotArtifactId: string;
  readonly approvalId?: string;
  readonly sandboxProfileId: string;
  readonly executionStartedAt?: string;
  readonly executionFinishedAt?: string;
  readonly resultDigest?: string;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
  readonly evidenceArtifactIds: readonly string[];
  readonly failureCode?: HarnessToolExecutionFailureCode;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunEvaluationV1 extends HarnessLeaseV1 {
  readonly schemaVersion: 1;
  readonly id: string;
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
  readonly idempotencyKey: string;
  readonly state: RunEvaluationState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly failureCode?: RunEvaluationFailureCode;
}

export interface RunEvaluationGradeV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly evaluationId: string;
  readonly graderType: RunEvaluationGraderType;
  readonly graderId: string;
  readonly graderVersion: string;
  readonly verdict: RunEvaluationVerdict;
  readonly score?: number;
  readonly severity?: RunEvaluationSeverity;
  readonly rationaleArtifactId?: string;
  readonly rawOutputArtifactId?: string;
  readonly costInputTokens?: number;
  readonly costOutputTokens?: number;
  readonly costAmountMicros?: number;
  readonly latencyMs?: number;
  readonly adjudicationStatus?: string;
  /** Canonical digest of every immutable grader-result field except row id and creation time. */
  readonly gradeDigest: string;
  readonly createdAt: string;
}

/** Frozen model-grader shape; canonical configuration and artifact-byte digests differ. */
export interface RunEvaluationFrozenGraderV1 {
  readonly graderId: string;
  readonly graderVersion: string;
  readonly promptDigest: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly samplingDigest: string;
  readonly rubricDigest: string;
}

export interface RunEvaluationArtifactPinV1 {
  readonly artifactId: string;
  readonly contentSha256: string;
}

export const RUN_EVALUATION_TASK_STATES = [
  "queued", "active", "completed", "failed", "cancelled", "unknown_outcome",
] as const;
export type RunEvaluationTaskState = (typeof RUN_EVALUATION_TASK_STATES)[number];
export const RUN_EVALUATION_TASK_ATTEMPT_STATES = [
  "claimed", "dispatch_admitted", "completed", "failed", "cancelled",
  "abandoned_before_dispatch", "unknown_outcome",
] as const;
export type RunEvaluationTaskAttemptState = (typeof RUN_EVALUATION_TASK_ATTEMPT_STATES)[number];
export const RUN_EVALUATION_TASK_FAILURE_CODES = [
  "evaluation.task_invalid",
  "evaluation.frozen_config_changed",
  "evaluation.lease_expired_before_dispatch",
  "evaluation.dispatch_outcome_unknown",
  "evaluation.result_invalid",
  "evaluation.cancelled_before_dispatch",
] as const;
export type RunEvaluationTaskFailureCode = (typeof RUN_EVALUATION_TASK_FAILURE_CODES)[number];

/** Separate model repeat; does not change the original evaluation or terminal Run. */
export interface RunEvaluationTaskV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly evaluationId: string;
  readonly evaluationKey: string;
  readonly graderType: "model";
  readonly frozenGrader: RunEvaluationFrozenGraderV1;
  readonly frozenGraderArtifact: RunEvaluationArtifactPinV1;
  readonly frozenGraderDigest: string;
  readonly repeatOrdinal: number;
  readonly idempotencyKey: string;
  readonly state: RunEvaluationTaskState;
  readonly activeAttemptId?: string;
  readonly nextAttemptAt?: string;
  readonly revision: number;
  readonly failureCode?: RunEvaluationTaskFailureCode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface RunEvaluationTaskAttemptV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly state: RunEvaluationTaskAttemptState;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly revision: number;
  /** Minted on first durable admission; admission is not proof of a network request. */
  readonly invocationId?: string;
  readonly requestDigest?: string;
  readonly executionScopeDigest?: string;
  readonly dispatchAdmittedAt?: string;
  readonly failureCode?: RunEvaluationTaskFailureCode;
  readonly claimedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

/** Integrity-checked declarations, never an authenticated independent invocation. */
export interface RunEvaluationTaskResultV1 {
  readonly schemaVersion: 1;
  readonly authority: "unverified";
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly evaluationKey: string;
  readonly frozenGraderDigest: string;
  readonly requestDigest: string;
  readonly executionScopeDigest: string;
  readonly verdict: RunEvaluationVerdict;
  readonly score?: number;
  readonly severity?: RunEvaluationSeverity;
  readonly rawOutputArtifact: RunEvaluationArtifactPinV1;
  readonly rationaleArtifact?: RunEvaluationArtifactPinV1;
  readonly costInputTokens?: number;
  readonly costOutputTokens?: number;
  readonly costAmountMicros?: number;
  readonly latencyMs?: number;
  readonly resultDigest: string;
  readonly createdAt: string;
}

export interface DelegationBudgetV1 {
  readonly tokenBudget?: number;
  readonly costBudgetMicros?: number;
  readonly wallTimeBudgetMs?: number;
}

export interface DelegationStepV1 extends DelegationBudgetV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly parentAttemptId: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly parentDelegationStepId?: string;
  readonly childRunId?: string;
  readonly spawnCallId: string;
  readonly objectiveArtifactId: string;
  readonly required: boolean;
  readonly state: DelegationStepState;
  readonly depth: number;
  readonly permissionSnapshotArtifactId: string;
  readonly toolAllowlistArtifactId: string;
  readonly workspaceScopeArtifactId: string;
  readonly providerPolicyArtifactId: string;
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly failureCode?: DelegationFailureCode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface DelegationMessageV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly delegationStepId: string;
  readonly direction: DelegationMessageDirection;
  readonly kind: DelegationMessageKind;
  readonly bodyArtifactId: string;
  readonly digest: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface HarnessFeatureSnapshotV1 {
  readonly schemaVersion: 1;
  readonly continuations: HarnessMode;
  readonly toolBroker: HarnessMode;
  readonly evaluations: HarnessMode;
  readonly evaluationModelGate: Exclude<HarnessMode, "off">;
  readonly delegations: HarnessMode;
  readonly delegationMaxDepth: number;
}
