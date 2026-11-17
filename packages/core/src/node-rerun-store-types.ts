import type {
  NodeRerunAdmissionResult, NodeRerunIntentSubmissionV1, NodeRerunIntentV1,
  NodeRerunObservedSourceV1, NodeRerunPreparedIntentV1,
} from "@ling-stack/contracts";
import type { RuntimeHostCapacityDispatchReference } from "./runtime-host-capacity-types.js";

export interface PrepareNodeRerunIntentInput {
  readonly request: NodeRerunIntentSubmissionV1;
  readonly now: string;
  /** Host-only, synchronous observation inside the Store's read-only writer snapshot. */
  readonly revalidate: (intent: NodeRerunIntentV1) => {
    readonly admission: NodeRerunAdmissionResult;
    readonly observed?: NodeRerunObservedSourceV1;
  };
}

export type PrepareNodeRerunIntentResult =
  | { readonly status: "created" | "duplicate"; readonly record: NodeRerunPreparedIntentV1 }
  | { readonly status: "conflict"; readonly code: "node_rerun_identity_conflict" }
  | { readonly status: "blocked"; readonly code: "node_rerun_source_unavailable" | "node_rerun_admission_blocked" | "node_rerun_plan_stale" };

export interface RequestNodeRerunApprovalInput {
  readonly recordId: string;
  readonly now: string;
  readonly revalidate: PrepareNodeRerunIntentInput["revalidate"];
}

export interface NodeRerunApprovalBasisV1 extends NodeRerunIntentSubmissionV1 {
  readonly schemaVersion: 1;
  readonly nodeRerunIntentId: string;
  readonly generationId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly policyFingerprint: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
}

export type RequestNodeRerunApprovalResult =
  | { readonly status: "created" | "duplicate"; readonly approval: import("./approval-types.js").ApprovalRequest }
  | { readonly status: "blocked"; readonly code: "node_rerun_intent_not_found" | "node_rerun_source_unavailable"
      | "node_rerun_admission_blocked" | "node_rerun_plan_stale" };

export interface PrepareNodeRerunTargetInput extends RequestNodeRerunApprovalInput {
  readonly runtimeInstanceId: string;
  /** Host SDK validation and identity rebinding, synchronously under the read-only writer snapshot. */
  readonly prepareExecution: (source: import("./run-types.js").RunSession, taskId: string) => unknown;
}

export type PrepareNodeRerunTargetResult =
  | { readonly status: "created" | "duplicate"; readonly target: import("@ling-stack/contracts").NodeRerunPreparedTargetV1 }
  | { readonly status: "blocked"; readonly code: "node_rerun_intent_not_found" | "node_rerun_source_unavailable"
      | "node_rerun_approval_unavailable" | "node_rerun_admission_blocked" | "node_rerun_plan_stale"
      | "node_rerun_input_unavailable" | "node_rerun_generation_active" | "node_rerun_runtime_changed" };

export interface DispatchNodeRerunTargetInput {
  readonly recordId: string;
  readonly now: string;
  /** The exact reservation and one-time gate owned by the Host dispatcher. */
  readonly hostCapacity: RuntimeHostCapacityDispatchReference;
}

export type DispatchNodeRerunTargetResult =
  | { readonly status: "admitted"; readonly target: import("@ling-stack/contracts").NodeRerunPreparedTargetV1 }
  | { readonly status: "changed" };

export interface CancelPreparedNodeRerunTargetInput {
  readonly recordId: string;
  readonly sourceFence: import("./runtime-supervisor-types.js").RuntimeAttemptFenceV1;
  readonly now: string;
  /** Synchronous Host observation inside the same read-only cancellation writer snapshot. */
  readonly observeLocalExecution: (target: import("@ling-stack/contracts").NodeRerunPreparedTargetV1) => "absent" | "present" | "unknown";
}

export type CancelPreparedNodeRerunTargetResult =
  | { readonly status: "cancelled" | "duplicate"; readonly cancellation: import("@ling-stack/contracts").NodeRerunTargetCancellationV1 }
  | { readonly status: "blocked"; readonly code: "node_rerun_target_not_found" | "node_rerun_target_changed" | "node_rerun_target_stop_unconfirmed" };

/** Requests a stop for a target whose dedicated Host gate was already consumed.
 * The request only records the exact-fence cancelling boundary; physical drain
 * and the terminal cancellation remain owned by the captured Runner. */
export interface RequestDispatchedNodeRerunTargetStopInput {
  readonly recordId: string;
  readonly sourceFence: import("./runtime-supervisor-types.js").RuntimeAttemptFenceV1;
  readonly now: string;
}

export type RequestDispatchedNodeRerunTargetStopResult =
  | { readonly status: "requested" | "duplicate" }
  | { readonly status: "blocked"; readonly code: "node_rerun_target_not_found" | "node_rerun_target_changed"
      | "node_rerun_target_not_dispatched" | "node_rerun_target_stop_unconfirmed" };

export interface ReadNodeRerunTargetReadinessInput {
  readonly recordId: string;
  readonly now: string;
  readonly revalidate: PrepareNodeRerunIntentInput["revalidate"];
  readonly observeLocalExecution: CancelPreparedNodeRerunTargetInput["observeLocalExecution"];
  /** SDK validation of the persisted target input; never assembles new context or starts execution. */
  readonly validateExecution: (run: import("./run-types.js").RunSession) => boolean;
}
