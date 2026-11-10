import type {
  DelegationFailureCode,
  DelegationStepState,
  HarnessToolExecutionFailureCode,
  HarnessToolExecutionState,
  HarnessToolExecutorKind,
  RunEvaluationFailureCode,
  RunEvaluationState,
  RunnerContinuationFailureCode,
  RunnerContinuationOrigin,
  RunnerContinuationState,
  RunnerContinuationStrategy,
} from "./harness.js";

export type HarnessDiagnosticKind = "continuation" | "tool_execution" | "evaluation" | "delegation";

/** Read-only metadata. Claim tokens, resume handles, inputs and artifact bodies are deliberately absent. */
export interface HarnessDiagnosticMetadataV1 {
  readonly id: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly claimOwner?: string;
  readonly claimExpiresAt?: string;
  readonly nextAttemptAt?: string;
}

export type HarnessDiagnosticRecordV1 =
  | (HarnessDiagnosticMetadataV1 & {
      readonly kind: "continuation";
      readonly state: RunnerContinuationState;
      readonly sourceAttemptId: string;
      readonly targetAttemptId?: string;
      readonly origin: RunnerContinuationOrigin;
      readonly strategy: RunnerContinuationStrategy;
      readonly runnerId: string;
      readonly generation: number;
      readonly failureCode?: RunnerContinuationFailureCode;
      readonly failureDetailArtifactId?: string;
      readonly completedAt?: string;
    })
  | (HarnessDiagnosticMetadataV1 & {
      readonly kind: "tool_execution";
      readonly state: HarnessToolExecutionState;
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly executorKind: HarnessToolExecutorKind;
      readonly continuationId?: string;
      readonly delegationStepId?: string;
      readonly supersedesExecutionId?: string;
      readonly policySnapshotArtifactId: string;
      readonly approvalId?: string;
      readonly sandboxProfileId: string;
      readonly failureCode?: HarnessToolExecutionFailureCode;
      readonly executionStartedAt?: string;
      readonly executionFinishedAt?: string;
    })
  | (HarnessDiagnosticMetadataV1 & {
      readonly kind: "evaluation";
      readonly rootRunId: string;
      readonly state: RunEvaluationState;
      readonly failureCode?: RunEvaluationFailureCode;
      readonly completedAt?: string;
    })
  | (HarnessDiagnosticMetadataV1 & {
      readonly kind: "delegation";
      readonly rootRunId: string;
      readonly state: DelegationStepState;
      readonly parentAttemptId: string;
      readonly workflowId?: string;
      readonly workflowStepId?: string;
      readonly parentDelegationStepId?: string;
      readonly childRunId?: string;
      readonly required: boolean;
      readonly depth: number;
      readonly failureCode?: DelegationFailureCode;
      readonly completedAt?: string;
    });

/** Derived projection health only. `ready`/`isCurrent` never assert Run or task completion. */
export interface HarnessDiagnosticProjectionCheckpointV1 {
  readonly domain: HarnessDiagnosticKind;
  readonly generation: number;
  readonly sourceEpoch: number;
  readonly builtEpoch: number;
  readonly state: "stale" | "rebuilding" | "ready" | "failed";
  readonly rowCount: number;
  readonly isCurrent: boolean;
  readonly failureCode?: string;
  readonly updatedAt: string;
}

/** Exclusive descending creation/kind/id keyset, bound to its original Run and WorkUnit. */
export interface HarnessDiagnosticCursorV1 {
  readonly runId: string;
  readonly workUnitId: string;
  readonly createdAt: string;
  readonly kind: HarnessDiagnosticKind;
  readonly id: string;
}

export interface HarnessDiagnosticQueryV1 {
  readonly limit?: number;
  readonly cursor?: HarnessDiagnosticCursorV1;
}

export interface HarnessDiagnosticPageV1 {
  readonly items: readonly HarnessDiagnosticRecordV1[];
  readonly nextCursor?: HarnessDiagnosticCursorV1;
}

/** Scope-only read: private Run snapshots and WorkUnit inputs are not loaded. */
export interface HarnessDiagnosticScopeV1 {
  readonly workUnitId: string;
  readonly runId?: string;
  readonly status: "available" | "run_unlinked" | "run_missing" | "lineage_mismatch";
}

export interface HarnessDiagnosticAttemptV1 {
  readonly id: string;
  readonly status: "observed" | "missing" | "ownership_mismatch";
  readonly workUnitId?: string;
  readonly runtimeInstanceId?: string;
  readonly fencingToken?: string;
  readonly attemptStatus?: string;
}

export interface HarnessDiagnosticObservationV1 {
  readonly record: HarnessDiagnosticRecordV1;
  /** Describes a stored lease at observedAt, never permission to execute. */
  readonly leaseStatus: "unclaimed" | "held" | "expired" | "terminal_retained";
  readonly attempts: readonly HarnessDiagnosticAttemptV1[];
}

export interface WorkUnitHarnessDiagnosticsResponse {
  readonly schemaVersion: 1;
  readonly cwd: string;
  readonly workUnitId: string;
  readonly runId?: string;
  readonly status: "available" | "run_unlinked" | "run_missing" | "lineage_mismatch";
  readonly observedAt: string;
  readonly items: readonly HarnessDiagnosticObservationV1[];
  /** Separate from authority records so projection readiness cannot masquerade as completed work. */
  readonly projectionCheckpoints: readonly HarnessDiagnosticProjectionCheckpointV1[];
  readonly nextCursor?: HarnessDiagnosticCursorV1;
}
