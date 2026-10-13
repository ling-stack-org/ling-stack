import { randomUUID } from "node:crypto";
import type {
  RunnerContinuationFailureCode,
  RunnerContinuationOrigin,
  RunnerContinuationState,
  RunnerContinuationStrategy,
  RunnerContinuationV1,
} from "@ling-stack/contracts";
import type {
  CreateWorkUnitAttemptInput,
  RuntimeAttemptFenceV1,
  WorkUnitAttempt,
} from "../runtime-supervisor-types.js";
import type { RunSession } from "../run-types.js";
import type { Task } from "../workspace-types.js";
import { transitionHarnessEntity, type HarnessTransitionResult } from "./common.js";

const transitions: Readonly<Record<RunnerContinuationState, ReadonlySet<RunnerContinuationState>>> = {
  requested: new Set(["prepared", "cancelled", "failed", "superseded"]),
  prepared: new Set(["claimed", "cancelled", "failed", "superseded"]),
  claimed: new Set(["running", "recovery_pending", "cancelled", "failed", "superseded"]),
  running: new Set(["succeeded", "failed", "cancelled", "recovery_pending"]),
  recovery_pending: new Set(["prepared", "cancelled", "failed", "superseded"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  superseded: new Set(),
};

export function transitionRunnerContinuation(input: {
  readonly current: RunnerContinuationV1;
  readonly expectedRevision: number;
  readonly nextState: RunnerContinuationState;
  readonly now: string;
}): HarnessTransitionResult<RunnerContinuationV1> {
  return transitionHarnessEntity({
    current: input.current,
    expectedRevision: input.expectedRevision,
    nextState: input.nextState,
    allowedNextStates: transitions[input.current.state],
    update: (revision, state) => ({
      ...input.current,
      state,
      revision,
      updatedAt: input.now,
      ...(["succeeded", "failed", "cancelled", "superseded"].includes(state) ? { completedAt: input.now } : {}),
    }),
  });
}

export function runnerContinuationIdempotencyKey(input: {
  readonly runId: string;
  readonly sourceAttemptId: string;
  readonly origin: RunnerContinuationOrigin;
  readonly generation: number;
}): string {
  return `runner-continuation:${input.runId}:${input.sourceAttemptId}:${input.origin}:${input.generation}`;
}

export function createRunnerContinuationId(): string {
  return `continuation_${randomUUID()}`;
}

export interface PrepareContinuationInput {
  readonly id?: string;
  /** Target logical Run. It may equal the source Run for approval resume or retry. */
  readonly runId: string;
  /** Target Work Unit that will own the fresh Attempt. */
  readonly workUnitId: string;
  /** Complete immutable source fence, not only the source Attempt id. */
  readonly sourceFence: RuntimeAttemptFenceV1;
  /** Explicit precondition. `null` means the target Work Unit must have no active Attempt. */
  readonly expectedTargetAttemptId: string | null;
  readonly origin: RunnerContinuationOrigin;
  readonly strategy: RunnerContinuationStrategy;
  readonly runnerId: string;
  readonly runnerCapabilityRevision: string;
  readonly contextViewId: string;
  readonly contextSnapshotArtifactId: string;
  readonly runnerHandleRef?: string;
  readonly idempotencyKey: string;
  readonly generation: number;
  readonly targetAttempt: Omit<CreateWorkUnitAttemptInput, "workUnitId" | "attemptNumber" | "status" | "now">;
  readonly now: string;
}

export interface PreparedContinuation {
  readonly continuation: RunnerContinuationV1;
  readonly attempt: WorkUnitAttempt;
  readonly replayed: boolean;
}

export interface CommitExistingRunContinuationInput {
  readonly preparation: PrepareContinuationInput;
  /** Host-only ordinary progress witness. Core revalidates it in activation's transaction. */
  readonly recoveryProgressCheckpointGuard?: import("../run-progress-checkpoint-types.js").RunProgressCheckpointWitness;
  readonly expectedRunStatus: Extract<RunSession["status"], "failed" | "queued" | "running">;
  readonly expectedWorkUnitStatus: "failed" | "stale";
  readonly expectedTaskStatus?: Extract<Task["status"], "failed" | "claimed" | "running">;
  readonly actor: "system" | "local-user";
  readonly reason: string;
  readonly now: string;
}

export type CommitExistingRunContinuationResult =
  | {
      readonly ok: true;
      readonly run: RunSession;
      readonly workUnit: import("../runtime-supervisor-types.js").WorkUnit;
      readonly attempt: WorkUnitAttempt;
      readonly continuation: RunnerContinuationV1;
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "continuation.activation_lineage_stale"
        | "continuation.activation_state_stale"
        | "continuation.activation_transition_failed"
        | import("../run-progress-checkpoint-types.js").RunProgressCheckpointBlockerCode;
    };

export interface CommitExistingRunContinuationPreparationFailureInput {
  readonly continuationId: string;
  readonly expectedContinuationRevision: number;
  readonly expectedContinuationState: Extract<RunnerContinuationState, "prepared" | "claimed">;
  readonly claimOwner?: string;
  readonly claimToken?: string;
  readonly runId: string;
  readonly expectedRunStatus: Extract<RunSession["status"], "queued" | "running">;
  readonly workUnitId: string;
  readonly expectedWorkUnitStatus: "queued" | "claimed";
  readonly targetFence: RuntimeAttemptFenceV1;
  readonly expectedAttemptStatus: "created";
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly now: string;
}

export type CommitExistingRunContinuationPreparationFailureResult =
  | {
      readonly ok: true;
      readonly run: RunSession;
      readonly task: Task;
      readonly workUnit: import("../runtime-supervisor-types.js").WorkUnit;
      readonly attempt: WorkUnitAttempt;
      readonly continuation: RunnerContinuationV1;
    }
  | {
      readonly ok: false;
      readonly code:
        | "continuation.preparation_failure_lineage_stale"
        | "continuation.preparation_failure_state_stale"
        | "continuation.preparation_failure_transition_failed";
    };

/** A lost Attempt is never rewritten when preflight blocks daemon recovery. */
export interface CommitStaleRunRecoveryFailureInput {
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly expectedRunStatus: "queued" | "running";
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly summaryPath: string;
  readonly now: string;
}

export type CommitStaleRunRecoveryFailureResult =
  | { readonly ok: true; readonly run: RunSession; readonly workUnit: import("../runtime-supervisor-types.js").WorkUnit }
  | { readonly ok: false; readonly code: "recovery_failure_lineage_stale" | "recovery_failure_state_stale" | "recovery_failure_transition_failed" };

export interface ReprepareContinuationInput {
  readonly continuationId: string;
  /** Revision of the recovery-pending native-resume generation. */
  readonly expectedRevision: number;
  readonly expectedGeneration: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly abandonedTargetFence: RuntimeAttemptFenceV1;
  /** Caller-created stable identity is required so a lost response can replay safely. */
  readonly targetAttempt: Omit<CreateWorkUnitAttemptInput, "workUnitId" | "attemptNumber" | "status" | "now"> & {
    readonly id: string;
  };
  readonly now: string;
}

export type RunnerContinuationMutationCode =
  | "not_found"
  | "stale_revision"
  | "invalid_transition"
  | "lease_not_claimable"
  | "lease_mismatch"
  | "continuation.target_attempt_lost";

export type RunnerContinuationMutationResult =
  | { readonly ok: true; readonly value: RunnerContinuationV1; readonly replayed: boolean }
  | { readonly ok: false; readonly code: RunnerContinuationMutationCode };

export interface ClaimRunnerContinuationInput {
  readonly continuationId: string;
  readonly expectedRevision: number;
  readonly claimOwner: string;
  /** Caller-created stable claim identity. Retries with the same token are idempotent. */
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly now: string;
}

export interface DeferRunnerContinuationInput {
  readonly continuationId: string;
  readonly expectedRevision: number;
  readonly now: string;
  readonly nextAttemptAt: string;
}

export interface StartRunnerContinuationInput {
  readonly continuationId: string;
  readonly expectedRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly targetFence: RuntimeAttemptFenceV1;
  readonly now: string;
}

export interface FinishRunnerContinuationInput {
  readonly continuationId: string;
  readonly expectedRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly targetFence: RuntimeAttemptFenceV1;
  readonly nextState: Extract<RunnerContinuationState, "succeeded" | "failed" | "cancelled" | "recovery_pending">;
  readonly failureCode?: RunnerContinuationFailureCode;
  readonly failureDetailArtifactId?: string;
  readonly nextAttemptAt?: string;
  readonly now: string;
}

/** Discovery position in the ascending due-time, creation-time, id ordering. */
export interface RunnerContinuationDiscoveryCursor {
  /** nextAttemptAt, or createdAt when the continuation is not deferred. */
  readonly dueAt: string;
  readonly createdAt: string;
  readonly id: string;
}

export interface ListClaimableRunnerContinuationsInput {
  readonly now: string;
  readonly limit?: number;
  /** Only rows explicitly deferred by the daemon after a queueable conflict. */
  readonly scheduledOnly?: boolean;
  /** Exclusive discovery position; does not claim or authorize execution. */
  readonly after?: RunnerContinuationDiscoveryCursor;
  /** Frozen sweep cutoff. Rows created later are discovered by a subsequent sweep. */
  readonly createdAtOrBefore?: string;
}

export type RunnerContinuationStoreErrorCode =
  | "continuation.invalid_input"
  | "continuation.idempotency_conflict"
  | "continuation.lineage_mismatch"
  | "continuation.source_attempt_stale"
  | "continuation.target_attempt_lost"
  | "continuation.context_snapshot_missing";

export class RunnerContinuationStoreError extends Error {
  constructor(readonly code: RunnerContinuationStoreErrorCode) {
    super(code);
    this.name = "RunnerContinuationStoreError";
  }
}
