import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";
import type { RetryUserInputDelivery } from "./user-input-delivery-types.js";
import type { EffectiveRunPolicySnapshot } from "./session-permissions.js";
import type { WorkflowStepStartOwnerV1 } from "./workflow-step-start-owner.js";

export interface UserInputSnapshotRef { readonly id: string; readonly fingerprint: string }
export type UserInputContinuationClaim = Pick<RetryUserInputDelivery, "threadId" | "deliveryId" | "expectedRevision" | "ownerId" | "claimToken">;
export type UserInputPreparationStage = "request" | "execution";
export interface UserInputContinuationRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly use: string;
  readonly deliveryId: string;
  readonly seedRef: UserInputSnapshotRef;
  readonly createdAt: string;
  readonly fingerprint: string;
}
/** Immutable, non-secret DTO. Daemon validates the stage-specific Runner/request schema. */
export interface UserInputContinuationPreparation extends UserInputContinuationRecord {
  readonly stage: UserInputPreparationStage;
  readonly parentRef: UserInputSnapshotRef;
  readonly payload: unknown;
}
export interface SaveUserInputContinuationPreparation extends UserInputContinuationClaim {
  readonly stage: UserInputPreparationStage;
  readonly parentRef: UserInputSnapshotRef;
  readonly payload: unknown;
}
/** Frozen execution input, not current policy or permission. No credentials or runtime callbacks. */
export interface UserInputContinuationExecutionPlan {
  readonly schemaVersion: 1;
  readonly runnerId: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly providerPresetId?: string;
  readonly selectedSkillId?: string;
  readonly taskSnapshot: Readonly<Record<string, unknown>>;
  readonly providerSnapshot: Readonly<Record<string, unknown>>;
  readonly requestSnapshot: Readonly<Record<string, unknown>>;
  /** Complete non-secret Run snapshot after current Host policy/runtime preflight. */
  readonly runRequestSnapshot: Readonly<Record<string, unknown>>;
  readonly preparedInput: Readonly<Record<string, unknown>>;
  readonly preparedInputFingerprint: string;
  /** Full non-secret input of this successor, required if it asks another question. */
  readonly runnerExecutionInput: Readonly<Record<string, unknown>>;
}
export interface AdmitUserInputContinuation extends UserInputContinuationClaim {
  readonly executionRef: UserInputSnapshotRef;
  readonly runtimeInstanceId: string;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly workflowStartOwner?: WorkflowStepStartOwnerV1;
}
/** Historical binding is immutable; a getter does not grant this fence current execution rights. */
export interface UserInputContinuationBinding extends UserInputContinuationRecord {
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly workflowStartOwner?: WorkflowStepStartOwnerV1;
  readonly executionRef: UserInputSnapshotRef;
  readonly runId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly deliveryRevision: number;
  readonly waitRevision: number;
}
export interface UserInputRunnerAcceptance {
  readonly schemaVersion: 1;
  readonly boundary: "pi-session-ready";
  readonly runId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly preparedInputFingerprint: string;
}
export interface UserInputContinuationReceipt extends UserInputContinuationRecord {
  readonly bindingRef: UserInputSnapshotRef;
  readonly acceptance: UserInputRunnerAcceptance;
}
/** Host-only mutation. The UI/Runner is never allowed to supply an arbitrary active fence. */
export interface AcknowledgeUserInputContinuation {
  readonly threadId: string;
  readonly deliveryId: string;
  readonly bindingRef: UserInputSnapshotRef;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly receipt: UserInputRunnerAcceptance;
}
/** Host-only settlement for an admitted continuation that never started. */
export interface FailUserInputContinuationStartup {
  readonly threadId: string;
  readonly deliveryId: string;
  readonly bindingRef: UserInputSnapshotRef;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly errorCode: string;
  readonly errorMessage: string;
}
