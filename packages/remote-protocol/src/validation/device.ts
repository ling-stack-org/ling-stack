import {
  DEVICE_KINDS_V1,
  DEVICE_LIFECYCLE_STATUSES_V1,
  DEVICE_TASK_STATUSES_V1,
  REMOTE_DEVICE_RECENT_TASK_LIMIT_V1,
  type RemoteDeviceListCommandV1,
  type RemoteDeviceListSnapshotV1,
  type RemoteDeviceRecentTaskV1,
  type RemoteDeviceTaskApproveCommandV1,
  type RemoteDeviceTaskReconcileCommandV1,
  type RemoteDeviceTaskRevokeCommandV1,
  type RemoteDeviceTaskSnapshotV1,
  type RemoteDeviceTaskStatusCommandV1,
  type RemoteDeviceSummaryV1,
  type RemoteDeviceTaskSummaryV1,
  type RemoteDeviceApprovalPreviewV1,
  type JsonValue,
} from "@ling-stack/contracts";
import { RemoteProtocolError } from "../errors.js";
import {
  assertStrictKeys,
  expectEnum,
  expectIdentifier,
  expectRecord,
  expectRfc3339,
  expectString,
} from "./primitives.js";

export function validateDeviceListCommand(value: unknown, path: string): RemoteDeviceListCommandV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["commandId", "workspaceId"], [], path);
  return { commandId: expectIdentifier(record.commandId, `${path}.commandId`), workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`) };
}

export function validateDeviceTaskStatusCommand(value: unknown, path: string): RemoteDeviceTaskStatusCommandV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["commandId", "workspaceId", "taskId"], [], path);
  return {
    commandId: expectIdentifier(record.commandId, `${path}.commandId`),
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    taskId: expectIdentifier(record.taskId, `${path}.taskId`),
  };
}

export function validateDeviceTaskApproveCommand(value: unknown, path: string): RemoteDeviceTaskApproveCommandV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["commandId", "workspaceId", "taskId", "approval"], [], path);
  const approval = expectRecord(record.approval, `${path}.approval`);
  assertStrictKeys(approval, [
    "approvalId", "taskId", "actionId", "targetDeviceId", "capabilitySnapshotId",
    "connectionRevision", "policyRevision", "normalizedInputDigest", "expiresAt",
  ], ["recoveryScope"], `${path}.approval`);
  return {
    commandId: expectIdentifier(record.commandId, `${path}.commandId`),
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    taskId: expectIdentifier(record.taskId, `${path}.taskId`),
    approval: {
      approvalId: expectIdentifier(approval.approvalId, `${path}.approval.approvalId`),
      taskId: expectIdentifier(approval.taskId, `${path}.approval.taskId`),
      actionId: expectIdentifier(approval.actionId, `${path}.approval.actionId`),
      targetDeviceId: expectIdentifier(approval.targetDeviceId, `${path}.approval.targetDeviceId`),
      capabilitySnapshotId: expectIdentifier(approval.capabilitySnapshotId, `${path}.approval.capabilitySnapshotId`),
      connectionRevision: expectIdentifier(approval.connectionRevision, `${path}.approval.connectionRevision`),
      policyRevision: expectIdentifier(approval.policyRevision, `${path}.approval.policyRevision`),
      normalizedInputDigest: expectIdentifier(approval.normalizedInputDigest, `${path}.approval.normalizedInputDigest`),
      expiresAt: expectRfc3339(approval.expiresAt, `${path}.approval.expiresAt`),
      ...(approval.recoveryScope === undefined ? {} : { recoveryScope: validateJsonValue(approval.recoveryScope, `${path}.approval.recoveryScope`) }),
    },
  };
}

export function validateDeviceTaskRevokeCommand(value: unknown, path: string): RemoteDeviceTaskRevokeCommandV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["commandId", "workspaceId", "taskId"], [], path);
  return {
    commandId: expectIdentifier(record.commandId, `${path}.commandId`),
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    taskId: expectIdentifier(record.taskId, `${path}.taskId`),
  };
}

export function validateDeviceTaskReconcileCommand(value: unknown, path: string): RemoteDeviceTaskReconcileCommandV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["commandId", "workspaceId", "taskId", "attemptId", "capabilitySnapshotId"], [], path);
  return {
    commandId: expectIdentifier(record.commandId, `${path}.commandId`),
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    taskId: expectIdentifier(record.taskId, `${path}.taskId`),
    attemptId: expectIdentifier(record.attemptId, `${path}.attemptId`),
    capabilitySnapshotId: expectIdentifier(record.capabilitySnapshotId, `${path}.capabilitySnapshotId`),
  };
}

export function validateDeviceListSnapshot(value: unknown, path: string): RemoteDeviceListSnapshotV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["workspaceId", "generatedAt", "devices"], ["recentTasks"], path);
  const devices = Array.isArray(record.devices) ? record.devices.map((device, index) => validateDeviceSummary(device, `${path}.devices[${index}]`)) : invalid(`${path}.devices`);
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    generatedAt: expectRfc3339(record.generatedAt, `${path}.generatedAt`),
    devices,
    ...(record.recentTasks === undefined ? {} : { recentTasks: validateRecentTasks(record.recentTasks, `${path}.recentTasks`) }),
  };
}

function validateRecentTasks(value: unknown, path: string): readonly RemoteDeviceRecentTaskV1[] {
  if (!Array.isArray(value) || value.length > REMOTE_DEVICE_RECENT_TASK_LIMIT_V1) return invalid(path);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(entry, itemPath);
    assertStrictKeys(record, ["taskId", "primaryTargetDeviceId", "status", "updatedAt"], [], itemPath);
    return {
      taskId: expectIdentifier(record.taskId, `${itemPath}.taskId`),
      primaryTargetDeviceId: expectIdentifier(record.primaryTargetDeviceId, `${itemPath}.primaryTargetDeviceId`),
      status: expectEnum(record.status, DEVICE_TASK_STATUSES_V1, `${itemPath}.status`),
      updatedAt: expectRfc3339(record.updatedAt, `${itemPath}.updatedAt`),
    };
  });
}

export function validateDeviceTaskSnapshot(value: unknown, path: string): RemoteDeviceTaskSnapshotV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["workspaceId", "task", "generatedAt"], [], path);
  return {
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    task: validateDeviceTaskSummary(record.task, `${path}.task`),
    generatedAt: expectRfc3339(record.generatedAt, `${path}.generatedAt`),
  };
}

function validateDeviceSummary(value: unknown, path: string): RemoteDeviceSummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["deviceId", "displayName", "kind", "lifecycleStatus", "adapterId", "adapterVersion"], ["lastSeenAt"], path);
  return {
    deviceId: expectIdentifier(record.deviceId, `${path}.deviceId`),
    displayName: expectString(record.displayName, `${path}.displayName`, { minBytes: 1, maxBytes: 320 }),
    kind: expectEnum(record.kind, DEVICE_KINDS_V1, `${path}.kind`),
    lifecycleStatus: expectEnum(record.lifecycleStatus, DEVICE_LIFECYCLE_STATUSES_V1, `${path}.lifecycleStatus`),
    adapterId: expectIdentifier(record.adapterId, `${path}.adapterId`),
    adapterVersion: expectIdentifier(record.adapterVersion, `${path}.adapterVersion`),
    ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: expectRfc3339(record.lastSeenAt, `${path}.lastSeenAt`) }),
  };
}

function validateDeviceTaskSummary(value: unknown, path: string): RemoteDeviceTaskSummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["taskId", "ownerKind", "ownerId", "targetDeviceIds", "status", "updatedAt", "attemptIds"], ["currentActionId", "lastVerificationId", "pendingApproval", "pendingReconciliation"], path);
  const targetDeviceIds = boundedIdentifierArray(record.targetDeviceIds, `${path}.targetDeviceIds`);
  const attemptIds = boundedIdentifierArray(record.attemptIds, `${path}.attemptIds`);
  const status = expectEnum(record.status, DEVICE_TASK_STATUSES_V1, `${path}.status`);
  let pendingReconciliation: RemoteDeviceTaskSummaryV1["pendingReconciliation"];
  if (record.pendingReconciliation !== undefined) {
    const previewPath = `${path}.pendingReconciliation`;
    const preview = expectRecord(record.pendingReconciliation, previewPath);
    assertStrictKeys(preview, ["attemptId", "targetDeviceId", "capabilitySnapshotId"], [], previewPath);
    const attemptId = expectIdentifier(preview.attemptId, `${previewPath}.attemptId`);
    const targetDeviceId = expectIdentifier(preview.targetDeviceId, `${previewPath}.targetDeviceId`);
    if (status !== "unknown" || !attemptIds.includes(attemptId) || !targetDeviceIds.includes(targetDeviceId)) return invalid(previewPath);
    pendingReconciliation = {
      attemptId, targetDeviceId,
      capabilitySnapshotId: expectIdentifier(preview.capabilitySnapshotId, `${previewPath}.capabilitySnapshotId`),
    };
  }
  return {
    taskId: expectIdentifier(record.taskId, `${path}.taskId`),
    ownerKind: expectEnum(record.ownerKind, ["daemon", "mobile", "edge"] as const, `${path}.ownerKind`),
    ownerId: expectIdentifier(record.ownerId, `${path}.ownerId`),
    targetDeviceIds,
    status,
    ...(record.currentActionId === undefined ? {} : { currentActionId: expectIdentifier(record.currentActionId, `${path}.currentActionId`) }),
    ...(record.lastVerificationId === undefined ? {} : { lastVerificationId: expectIdentifier(record.lastVerificationId, `${path}.lastVerificationId`) }),
    updatedAt: expectRfc3339(record.updatedAt, `${path}.updatedAt`),
    attemptIds,
    ...(record.pendingApproval === undefined ? {} : { pendingApproval: validateApprovalPreview(record.pendingApproval, `${path}.pendingApproval`) }),
    ...(pendingReconciliation ? { pendingReconciliation } : {}),
  };
}

function validateApprovalPreview(value: unknown, path: string): RemoteDeviceApprovalPreviewV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["actionId", "targetDeviceId", "capabilityId", "capabilitySchemaVersion", "capabilitySnapshotId", "connectionRevision", "policyRevision", "normalizedInputDigest", "sideEffect"], ["expectedVerification"], path);
  return {
    actionId: expectIdentifier(record.actionId, `${path}.actionId`),
    targetDeviceId: expectIdentifier(record.targetDeviceId, `${path}.targetDeviceId`),
    capabilityId: expectIdentifier(record.capabilityId, `${path}.capabilityId`),
    capabilitySchemaVersion: expectIdentifier(record.capabilitySchemaVersion, `${path}.capabilitySchemaVersion`),
    capabilitySnapshotId: expectIdentifier(record.capabilitySnapshotId, `${path}.capabilitySnapshotId`),
    connectionRevision: expectIdentifier(record.connectionRevision, `${path}.connectionRevision`),
    policyRevision: expectIdentifier(record.policyRevision, `${path}.policyRevision`),
    normalizedInputDigest: expectIdentifier(record.normalizedInputDigest, `${path}.normalizedInputDigest`),
    sideEffect: expectEnum(record.sideEffect, ["read_only", "reversible", "mutating", "irreversible", "critical"] as const, `${path}.sideEffect`),
    ...(record.expectedVerification === undefined ? {} : { expectedVerification: validateJsonValue(record.expectedVerification, `${path}.expectedVerification`) }),
  };
}

function boundedIdentifierArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) return invalid(path);
  return value.map((item, index) => expectIdentifier(item, `${path}[${index}]`));
}

function validateJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => validateJsonValue(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const record = expectRecord(value, path);
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, validateJsonValue(item, `${path}.${key}`)]));
  }
  return invalid(path);
}

function invalid(path: string): never {
  throw new RemoteProtocolError("invalid_field", "Device projection is invalid", path);
}
