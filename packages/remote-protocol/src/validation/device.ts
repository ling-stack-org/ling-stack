import {
  DEVICE_KINDS_V1,
  DEVICE_LIFECYCLE_STATUSES_V1,
  DEVICE_TASK_STATUSES_V1,
  type RemoteDeviceListCommandV1,
  type RemoteDeviceListSnapshotV1,
  type RemoteDeviceTaskApproveCommandV1,
  type RemoteDeviceTaskRevokeCommandV1,
  type RemoteDeviceTaskSnapshotV1,
  type RemoteDeviceTaskStatusCommandV1,
  type RemoteDeviceSummaryV1,
  type RemoteDeviceTaskSummaryV1,
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

export function validateDeviceListSnapshot(value: unknown, path: string): RemoteDeviceListSnapshotV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["workspaceId", "generatedAt", "devices"], [], path);
  const devices = Array.isArray(record.devices) ? record.devices.map((device, index) => validateDeviceSummary(device, `${path}.devices[${index}]`)) : invalid(`${path}.devices`);
  return { workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`), generatedAt: expectRfc3339(record.generatedAt, `${path}.generatedAt`), devices };
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
  assertStrictKeys(record, ["taskId", "ownerKind", "ownerId", "targetDeviceIds", "status", "updatedAt", "attemptIds"], ["currentActionId", "lastVerificationId"], path);
  const targetDeviceIds = boundedIdentifierArray(record.targetDeviceIds, `${path}.targetDeviceIds`);
  const attemptIds = boundedIdentifierArray(record.attemptIds, `${path}.attemptIds`);
  return {
    taskId: expectIdentifier(record.taskId, `${path}.taskId`),
    ownerKind: expectEnum(record.ownerKind, ["daemon", "mobile", "edge"] as const, `${path}.ownerKind`),
    ownerId: expectIdentifier(record.ownerId, `${path}.ownerId`),
    targetDeviceIds,
    status: expectEnum(record.status, DEVICE_TASK_STATUSES_V1, `${path}.status`),
    ...(record.currentActionId === undefined ? {} : { currentActionId: expectIdentifier(record.currentActionId, `${path}.currentActionId`) }),
    ...(record.lastVerificationId === undefined ? {} : { lastVerificationId: expectIdentifier(record.lastVerificationId, `${path}.lastVerificationId`) }),
    updatedAt: expectRfc3339(record.updatedAt, `${path}.updatedAt`),
    attemptIds,
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
