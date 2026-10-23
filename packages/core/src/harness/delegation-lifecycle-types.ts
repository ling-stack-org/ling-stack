import type { DelegationMessageV1, DelegationStepV1 } from "@ling-stack/contracts";
import type { CreateRunArtifactInput, RunArtifact, RunSession, RunStore } from "../run-types.js";
import type { CreateWorkUnitAttemptInput, RuntimeAttemptFenceV1, WorkUnit, WorkUnitAttempt } from "../runtime-supervisor-types.js";
import type { DelegationBudgetReservation } from "./delegation-write-types.js";
import type { EffectiveRunPolicySnapshot } from "../session-permissions.js";

export type DelegationLifecycleErrorCode = `delegation.${"invalid_input" | "lineage_invalid" | "source_attempt_stale"
  | "lifecycle_conflict" | "authority_invalid" | "deadline_exceeded" | "idempotency_conflict" | "recovery_required"}`;
export class DelegationLifecycleError extends Error {
  constructor(readonly code: DelegationLifecycleErrorCode) { super(code); this.name = "DelegationLifecycleError"; }
}

/** Adapter-owned acceptance, not a model event or the creation of a Promise. */
export interface DelegationRunnerStartObservation {
  readonly childRunId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly runnerId: string;
  readonly observationId: string;
  readonly observedAt: string;
}

export interface DelegationChildRuntime {
  readonly step: DelegationStepV1;
  readonly reservation: DelegationBudgetReservation;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly attempt?: WorkUnitAttempt;
}

export interface DelegationRecoveryCursor {
  readonly createdAt: string;
  readonly reservationId: string;
}
export interface ListDelegatedRecoveryCandidatesInput {
  readonly cutoffAt: string;
  readonly cursor?: DelegationRecoveryCursor;
  readonly limit: number;
}
export interface DelegatedRecoveryCandidatesPage {
  readonly reservationIds: readonly string[];
  readonly nextCursor?: DelegationRecoveryCursor;
}

/** Original SDK-prepared execution, held by Host custody and sealed before its first dispatch. */
export interface DelegationPreparedExecutionV1 {
  readonly schemaVersion: 1;
  readonly kind: "delegation.execution.v1";
  readonly stepId: string;
  readonly reservationId: string;
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly runnerId: "pi";
  readonly requestSnapshot: Readonly<Record<string, unknown>>;
  readonly runnerExecutionInput: Readonly<Record<string, unknown>>;
  readonly effectivePolicySnapshot: EffectiveRunPolicySnapshot;
  readonly preparedAt: string;
}
export interface DelegationPreparedExecution {
  readonly artifactId: string;
  readonly digest: string;
  readonly payload: DelegationPreparedExecutionV1;
}

export interface DelegationLifecycleStorePorts extends Pick<RunStore,
  "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "transitionRunStatus" | "transitionWorkUnitStatus" | "updateWorkUnitAttemptStatus" | "appendRuntimeEvent"
  | "getHostAttemptCompletion" | "appendTerminalRuntimeAudit" | "releaseResourceLeasesForAttempt" | "releaseRuntimeSemaphoreSlotsForAttempt"> {
  readonly getDelegationStep: (stepId: string) => DelegationStepV1 | undefined;
  readonly getDelegationBudgetReservation: (id: string) => DelegationBudgetReservation | undefined;
  readonly createWorkUnitAttemptWithinTransaction: (input: CreateWorkUnitAttemptInput) => WorkUnitAttempt;
  readonly createArtifactWithinTransaction: (input: CreateRunArtifactInput) => RunArtifact;
  readonly getArtifact: (id: string) => RunArtifact | undefined;
  /** Re-read frozen root/child authority, current revocation and accepted workflow scope. */
  readonly assertDispatchAuthorityWithinTransaction: (input: {
    readonly childRunId: string; readonly stepId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly now: string;
  }) => void;
  /** Private Host custody validates the actual adapter acceptance reference. */
  readonly readRunnerStartObservation: (reference: unknown) => DelegationRunnerStartObservation;
  /** Constructor custody; neither model JSON nor a route-supplied boolean authenticates preparation. */
  readonly readExecutionPreparation?: (reference: unknown) => DelegationPreparedExecutionV1;
  /** Joined original SDK ACK for a private186 target; absent for ordinary children. */
  readonly commitSuspensionStartWithinTransaction?: (input: { readonly runtime: ClaimedDelegatedChild;
    readonly preparation: DelegationPreparedExecution; readonly observation: DelegationRunnerStartObservation; readonly now: string }) => void;
}

export interface ClaimDelegatedChildInput {
  readonly reservationId: string;
  readonly expectedStepRevision: number;
  readonly runtimeInstanceId: string;
  readonly now: string;
}
export interface ClaimedDelegatedChild extends DelegationChildRuntime {
  readonly attempt: WorkUnitAttempt;
  /** A replay is observation-only. It is never authorization to dispatch again. */
  readonly replayed: boolean;
}
export interface CommitDelegatedChildStartInput {
  readonly reservationId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly observation: unknown;
  readonly now: string;
}
export interface AppendDelegationInstructionInput {
  readonly reservationId: string;
  readonly parentFence: RuntimeAttemptFenceV1;
  readonly messageCallId: string;
  readonly text: string;
  readonly now: string;
}
export interface AppendedDelegationInstruction {
  readonly message: DelegationMessageV1;
  readonly replayed: boolean;
}

export interface InterruptDelegatedChildInput {
  readonly reservationId: string;
  readonly parentFence: RuntimeAttemptFenceV1;
  readonly callId: string;
  readonly now: string;
}
export interface InterruptedDelegatedChildRequest extends DelegationChildRuntime {
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly replayed: boolean;
}
export interface ResumeDelegatedChildInput extends ClaimDelegatedChildInput {
  readonly parentFence: RuntimeAttemptFenceV1;
  readonly callId: string;
}

export type DelegationRecoveryClassification =
  | { readonly kind: "queued_unclaimed"; readonly runtime: DelegationChildRuntime }
  | { readonly kind: "dispatch_outcome_unknown"; readonly runtime: DelegationChildRuntime }
  | { readonly kind: "running" | "waiting" | "interrupting" | "interrupted" | "resuming"; readonly runtime: DelegationChildRuntime }
  | { readonly kind: "terminal"; readonly runtime: DelegationChildRuntime };
