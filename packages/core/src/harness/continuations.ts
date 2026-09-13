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

export interface ListClaimableRunnerContinuationsInput {
  readonly now: string;
  readonly limit?: number;
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
