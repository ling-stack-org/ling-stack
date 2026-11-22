import type {
  CapabilitySideEffectV1,
  DeviceApprovalBindingV1,
  DeviceKindV1,
  DeviceRecoveryPlanV1,
  DeviceTaskStatusV1,
  JsonValue,
} from "./device.js";
import type { DeviceEventEnvelopeV1 } from "./device-fabric.js";

export const REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1 = "ling.device-tasks.v1";
export const REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2 = "ling.device-tasks.v2";
export const REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3 = "ling.device-tasks.v3";
export const REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4 = "ling.device-tasks.v4";
export const REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5 = "ling.device-tasks.v5";
export const REMOTE_DEVICE_RECENT_TASK_LIMIT_V1 = 20;
export const REMOTE_DEVICE_JOURNAL_PAGE_LIMIT_V1 = 25;

export interface RemoteDeviceSummaryV1 {
  readonly deviceId: string;
  readonly displayName: string;
  readonly kind: DeviceKindV1;
  readonly lifecycleStatus: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly lastSeenAt?: string;
}

export interface RemoteDeviceListSnapshotV1 {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly devices: readonly RemoteDeviceSummaryV1[];
  readonly recentTasks?: readonly RemoteDeviceRecentTaskV1[];
}

export interface RemoteDeviceRecentTaskV1 {
  readonly taskId: string;
  readonly primaryTargetDeviceId: string;
  readonly status: DeviceTaskStatusV1;
  readonly updatedAt: string;
}

export interface RemoteDeviceTaskSummaryV1 {
  readonly taskId: string;
  readonly ownerKind: "daemon" | "mobile" | "edge";
  readonly ownerId: string;
  readonly targetDeviceIds: readonly string[];
  readonly status: DeviceTaskStatusV1;
  readonly currentActionId?: string;
  readonly lastVerificationId?: string;
  readonly updatedAt: string;
  readonly attemptIds: readonly string[];
  readonly pendingApproval?: RemoteDeviceApprovalPreviewV1;
  readonly pendingReconciliation?: RemoteDeviceReconciliationPreviewV1;
}

export interface RemoteDeviceReconciliationPreviewV1 {
  readonly attemptId: string;
  readonly targetDeviceId: string;
  readonly capabilitySnapshotId: string;
}

export interface RemoteDeviceApprovalPreviewV1 {
  readonly actionId: string;
  readonly targetDeviceId: string;
  readonly capabilityId: string;
  readonly capabilitySchemaVersion: string;
  readonly capabilitySnapshotId: string;
  readonly connectionRevision: string;
  readonly policyRevision: string;
  readonly normalizedInputDigest: string;
  readonly sideEffect: CapabilitySideEffectV1;
  readonly expectedVerification?: JsonValue;
  readonly recoveryPlan?: DeviceRecoveryPlanV1;
}

export interface RemoteDeviceTaskSnapshotV1 {
  readonly workspaceId: string;
  readonly task: RemoteDeviceTaskSummaryV1;
  readonly generatedAt: string;
}

export interface RemoteDeviceListCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
}

export interface RemoteDeviceTaskStatusCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly taskId: string;
}

export interface RemoteDeviceTaskJournalCommandV1 extends RemoteDeviceTaskStatusCommandV1 {
  readonly generation: number;
  readonly afterSequence: number;
  readonly limit: number;
}

export interface RemoteDeviceTaskJournalUnwatchCommandV1 extends RemoteDeviceTaskStatusCommandV1 {
  readonly watchId: string;
}

export interface RemoteDeviceTaskJournalV1 {
  readonly workspaceId: string;
  readonly task: Pick<RemoteDeviceTaskSummaryV1, "taskId" | "ownerId" | "status" | "updatedAt" | "lastVerificationId">;
  readonly streamId: string;
  readonly generation: number;
  readonly afterSequence: number;
  readonly latestSequence: number;
  readonly events: readonly DeviceEventEnvelopeV1[];
  readonly hasMore: boolean;
  readonly requiresSnapshot: boolean;
}

export interface RemoteDeviceTaskJournalReadV1 {
  readonly kind: "device_task_journal_read";
  readonly journal: RemoteDeviceTaskJournalV1;
}

export interface RemoteDeviceTaskJournalWatchingV1 {
  readonly kind: "device_task_journal_watching";
  readonly journal: RemoteDeviceTaskJournalV1;
}

export interface RemoteDeviceTaskJournalUnwatchedV1 {
  readonly kind: "device_task_journal_unwatched";
}

export interface RemoteDeviceTaskJournalPageV1 {
  readonly watchId: string;
  readonly journal: RemoteDeviceTaskJournalV1;
}

export interface RemoteDeviceTaskApproveCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly approval: DeviceApprovalBindingV1;
}

export interface RemoteDeviceTaskRevokeCommandV1 {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly taskId: string;
}

export interface RemoteDeviceTaskReconcileCommandV1 extends RemoteDeviceTaskStatusCommandV1 {
  readonly attemptId: string;
  readonly capabilitySnapshotId: string;
}

export interface RemoteDeviceTaskListRequestedV1 {
  readonly kind: "device_list_requested";
}

export interface RemoteDeviceTaskStatusRequestedV1 {
  readonly kind: "device_task_status_requested";
  readonly taskId: string;
}

export interface RemoteDeviceTaskApprovedV1 {
  readonly kind: "device_task_approved";
  readonly taskId: string;
}

export interface RemoteDeviceTaskRevokedV1 {
  readonly kind: "device_task_revoked";
  readonly taskId: string;
}

export interface RemoteDeviceTaskRecheckedV1 {
  readonly kind: "device_task_rechecked";
  readonly taskId: string;
  readonly status: "verified" | "unresolved";
}

export type RemoteDeviceCommandResultV1 =
  | RemoteDeviceTaskListRequestedV1
  | RemoteDeviceTaskStatusRequestedV1
  | RemoteDeviceTaskJournalReadV1
  | RemoteDeviceTaskJournalWatchingV1
  | RemoteDeviceTaskJournalUnwatchedV1
  | RemoteDeviceTaskApprovedV1
  | RemoteDeviceTaskRevokedV1
  | RemoteDeviceTaskRecheckedV1;
