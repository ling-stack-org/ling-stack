import type { HostRunCapacityIntent, HostRunCapacityReservation, HostRunCapacityReleaseKind } from "./host-run-capacity-types.js";
import type { HostOperationSource } from "./host-operation-journal-types.js";
import type { UserInputContinuationClaim, UserInputSnapshotRef } from "./user-input-host-continuation-types.js";

export interface RuntimeHostCapacityApprovalResumePendingInput {
  readonly checkpointId: string;
  readonly expectedCheckpointRevision: number;
  readonly expectedActiveAttemptId: string;
  readonly runtimeInstanceId: string;
  readonly now: string;
}

export interface RuntimeHostCapacityUserInputPendingInput extends UserInputContinuationClaim {
  readonly executionRef: UserInputSnapshotRef;
  readonly runtimeInstanceId: string;
  readonly now: string;
}

export type RuntimeHostCapacityReservationReceipt = Pick<HostRunCapacityReservation,
  "reservationId" | "token" | "intent" | "policyRevision" | "reservedAt">;

export interface RuntimeHostCapacityDispatchReference {
  readonly intentId: string;
  readonly dispatchToken: string;
}

export interface RuntimeHostCapacityIntentRecord {
  readonly intent: HostRunCapacityIntent;
  readonly workspaceId: string;
  /** Pending admission has no Attempt fence until its owner binds it. */
  readonly source?: HostOperationSource;
  readonly createdAt: string;
  readonly reservation?: RuntimeHostCapacityReservationReceipt;
  readonly dispatchToken?: string;
  readonly dispatchedAt?: string;
  readonly revokedAt?: string;
}
export interface RuntimeHostCapacityPendingRecord extends Omit<RuntimeHostCapacityIntentRecord, "source"> {
  readonly source?: undefined;
}

export interface RuntimeHostCapacityReleaseRecord {
  readonly intentId: string;
  readonly reservationId: string;
  readonly token: string;
  readonly kind: HostRunCapacityReleaseKind;
  readonly proofDigest: string;
  readonly createdAt: string;
  readonly acknowledgedAt?: string;
}

export type PrepareRuntimeHostCapacityAttemptResult =
  | { readonly status: "prepared" | "duplicate"; readonly record: RuntimeHostCapacityIntentRecord }
  | { readonly status: "changed" };

export type PrepareRuntimeHostCapacityWorkflowStartResult = PrepareRuntimeHostCapacityAttemptResult;

export type PrepareRuntimeHostCapacityDelegationSpawnResult = PrepareRuntimeHostCapacityAttemptResult;
export type PrepareRuntimeHostCapacityDelegationPendingResult =
  | { readonly status: "prepared" | "duplicate"; readonly record: RuntimeHostCapacityPendingRecord }
  | { readonly status: "changed" };

export type AttachRuntimeHostCapacityReservationResult =
  | { readonly status: "attached" | "duplicate"; readonly record: RuntimeHostCapacityIntentRecord }
  | { readonly status: "changed" };

export type PrepareRuntimeHostCapacityReleaseResult =
  | { readonly status: "prepared" | "duplicate"; readonly release: RuntimeHostCapacityReleaseRecord }
  | { readonly status: "changed" };
