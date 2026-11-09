import type { CreateResourceLeaseInput, ResourceLease } from "./channel-runtime-types.js";
import type { AcquireRuntimeSemaphoreSlotInput, RuntimeAttemptFenceV1, RuntimeSemaphoreSlot } from "./runtime-supervisor-types.js";
import type { RuntimeHostCapacityDispatchReference } from "./runtime-host-capacity-types.js";

export type RuntimeRunQueueReason = "resource_conflict" | "runtime_semaphore_conflict";

export interface RuntimeRunQueueClaim {
  readonly runId: string;
  readonly revision: number;
  readonly ownerId: string;
  readonly token: string;
  readonly runtimeInstanceId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
}

export interface RuntimeRunQueueEntry {
  readonly sequence: number;
  readonly runId: string;
  readonly workspaceId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly snapshotDigest: string;
  readonly groupKey: string;
  readonly queuedAt: string;
  readonly reason: RuntimeRunQueueReason;
  readonly revision: number;
  readonly lastSelected: number;
  readonly claim?: RuntimeRunQueueClaim;
  readonly claimExpiresAt?: string;
  readonly retryAt?: string;
  readonly dispatchedAt?: string;
}

export interface EnqueueRuntimeRunInput {
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly reason: RuntimeRunQueueReason;
  readonly now: string;
}

export interface ClaimNextRuntimeRunInput {
  readonly workspaceId: string;
  readonly runtimeInstanceId: string;
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly now: string;
  /** A trusted resource-release notification may immediately recheck deferred work. */
  readonly ignoreRetryAt?: boolean;
  /** A synchronous caller may claim itself only if it is the next fair candidate. */
  readonly runId?: string;
}

export interface DispatchRuntimeQueuedRunInput {
  readonly claim: RuntimeRunQueueClaim;
  readonly hostCapacity?: RuntimeHostCapacityDispatchReference;
  readonly leases: readonly CreateResourceLeaseInput[];
  readonly semaphores: readonly AcquireRuntimeSemaphoreSlotInput[];
  readonly now: string;
}

export type DispatchRuntimeQueuedRunResult =
  | { readonly status: "admitted"; readonly entry: RuntimeRunQueueEntry;
      readonly leases: readonly ResourceLease[]; readonly semaphores: readonly RuntimeSemaphoreSlot[] }
  | { readonly status: "busy"; readonly reason: RuntimeRunQueueReason }
  | { readonly status: "changed" };

export interface RuntimeRunQueueStore {
  getRuntimeRunQueueEntry(runId: string): RuntimeRunQueueEntry | undefined;
  enqueueRuntimeRun(input: EnqueueRuntimeRunInput):
    | { readonly status: "enqueued" | "duplicate"; readonly entry: RuntimeRunQueueEntry }
    | { readonly status: "changed" };
  claimNextRuntimeRun(input: ClaimNextRuntimeRunInput):
    | { readonly status: "claimed"; readonly entry: RuntimeRunQueueEntry; readonly claim: RuntimeRunQueueClaim }
    | { readonly status: "empty" | "changed" };
  deferRuntimeQueuedRun(input: { readonly claim: RuntimeRunQueueClaim; readonly reason: RuntimeRunQueueReason;
    readonly now: string; readonly retryAt: string }): boolean;
  dispatchRuntimeQueuedRun(input: DispatchRuntimeQueuedRunInput): DispatchRuntimeQueuedRunResult;
  /** Custody only, never permission to replay a consumed dispatch gate. */
  hasRuntimeRunQueueCustody(runId: string): boolean;
}
