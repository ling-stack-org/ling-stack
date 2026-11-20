import type {
  CapabilitySideEffectV1,
  DeviceApprovalBindingV1,
  DeviceKindV1,
  DeviceTaskStatusV1,
  JsonValue,
} from "./device.js";

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

export type RemoteDeviceCommandResultV1 =
  | RemoteDeviceTaskListRequestedV1
  | RemoteDeviceTaskStatusRequestedV1
  | RemoteDeviceTaskApprovedV1
  | RemoteDeviceTaskRevokedV1;
