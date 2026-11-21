import {
  REMOTE_DEVICE_RECENT_TASK_LIMIT_V1,
  type DeviceTaskV1,
  type RemoteDeviceListSnapshotV1,
  type RemoteDeviceTaskApproveCommandV1,
  type RemoteDeviceTaskSnapshotV1,
  type RemoteDeviceTaskRevokeCommandV1,
  type RemoteDeviceTaskStatusCommandV1,
} from "@ling-stack/contracts";
import type { DeviceCapabilityBroker, SqliteDeviceSupportStore } from "@ling-stack/core";
import { RemoteAccessError } from "./errors.js";

export interface RemoteDeviceFacade {
  listDevices(workspaceId: string): RemoteDeviceListSnapshotV1;
  taskSnapshot(input: RemoteDeviceTaskStatusCommandV1): RemoteDeviceTaskSnapshotV1;
  approveTask(input: RemoteDeviceTaskApproveCommandV1): Promise<RemoteDeviceTaskSnapshotV1>;
  revokeTask(input: RemoteDeviceTaskRevokeCommandV1): RemoteDeviceTaskSnapshotV1;
}

export interface RemoteDeviceFacadeOptions {
  readonly store: SqliteDeviceSupportStore;
  readonly broker?: DeviceCapabilityBroker;
  readonly now?: () => string;
  readonly approve?: (input: RemoteDeviceTaskApproveCommandV1) => Promise<void>;
}

export function createRemoteDeviceFacade(options: RemoteDeviceFacadeOptions): RemoteDeviceFacade {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    listDevices(workspaceId) {
      return {
        workspaceId,
        generatedAt: now(),
        devices: options.store.listDevices()
          .filter(profile => profile.device.ownerScope === workspaceId)
          .map(profile => ({
            deviceId: profile.device.id,
            displayName: profile.device.displayName,
            kind: profile.device.kind,
            lifecycleStatus: profile.device.lifecycleStatus,
            adapterId: profile.adapterId,
            adapterVersion: profile.adapterVersion,
            ...(profile.device.lastSeenAt ? { lastSeenAt: profile.device.lastSeenAt } : {}),
          })),
        recentTasks: options.store.listRecentDaemonTasks(workspaceId, REMOTE_DEVICE_RECENT_TASK_LIMIT_V1)
          .map(task => ({
            taskId: task.id,
            primaryTargetDeviceId: task.targetDeviceIds[0]!,
            status: task.status,
            updatedAt: task.updatedAt,
          })),
      };
    },
    taskSnapshot(input) {
      return snapshotForTask(options.store, input.workspaceId, input.taskId, now());
    },
    async approveTask(input) {
      requireDaemonTask(options.store, input.taskId, input.workspaceId);
      if (options.approve) {
        await options.approve(input);
      } else if (options.broker) {
        const proposal = options.store.getActionProposal(input.taskId);
        if (!proposal) throw new RemoteAccessError("pc_unavailable", "Device task has no pending action proposal.", true);
        await options.broker.execute(
          { ...proposal.request, approvalId: input.approval.approvalId, approval: input.approval },
          undefined,
          { requireCurrentProposal: true },
        );
      } else {
        throw new RemoteAccessError("pc_unavailable", "Device approval executor is not attached.", true);
      }
      return snapshotForTask(options.store, input.workspaceId, input.taskId, now());
    },
    revokeTask(input) {
      requireDaemonTask(options.store, input.taskId, input.workspaceId);
      if (options.broker) options.broker.cancelTask(input.taskId);
      else options.store.stopDaemonTask(input.taskId, now());
      return snapshotForTask(options.store, input.workspaceId, input.taskId, now());
    },
  };
}

function snapshotForTask(store: SqliteDeviceSupportStore, workspaceId: string, taskId: string, generatedAt: string): RemoteDeviceTaskSnapshotV1 {
  const task = requireDaemonTask(store, taskId, workspaceId);
  return {
    workspaceId,
    generatedAt,
    task: {
      taskId: task.id,
      ownerKind: task.ownerKind,
      ownerId: task.ownerId,
      targetDeviceIds: task.targetDeviceIds,
      status: task.status,
      ...(task.currentActionId ? { currentActionId: task.currentActionId } : {}),
      ...(task.lastVerificationId ? { lastVerificationId: task.lastVerificationId } : {}),
      updatedAt: task.updatedAt,
      attemptIds: store.listAttempts(task.id).map(record => record.attempt.attemptId),
      ...pendingApprovalPreview(store, task),
    },
  };
}

function pendingApprovalPreview(store: SqliteDeviceSupportStore, task: NonNullable<ReturnType<SqliteDeviceSupportStore["getTask"]>>): { readonly pendingApproval?: import("@ling-stack/contracts").RemoteDeviceApprovalPreviewV1 } {
  if (task.status !== "awaiting_approval") return {};
  const proposal = store.getActionProposal(task.id);
  if (!proposal) return {};
  const snapshot = store.getCurrentCapabilitySnapshot(proposal.request.targetDeviceId);
  if (snapshot?.snapshotId !== proposal.request.capabilitySnapshotId) return {};
  const capability = snapshot?.capabilities.find(item => item.id === proposal.request.capabilityId);
  if (!capability || capability.sideEffect === "read_only") return {};
  return {
    pendingApproval: {
      actionId: proposal.request.actionId,
      targetDeviceId: proposal.request.targetDeviceId,
      capabilityId: proposal.request.capabilityId,
      capabilitySchemaVersion: proposal.request.capabilitySchemaVersion,
      capabilitySnapshotId: proposal.request.capabilitySnapshotId,
      connectionRevision: snapshot.connectionRevision,
      policyRevision: task.policyRevision ?? "device-policy-v1",
      normalizedInputDigest: proposal.requestDigest,
      sideEffect: capability.sideEffect,
      ...(proposal.request.expectedVerification === undefined ? {} : { expectedVerification: proposal.request.expectedVerification }),
    },
  };
}

function requireDaemonTask(store: SqliteDeviceSupportStore, taskId: string, workspaceId: string): DeviceTaskV1 {
  const task = store.getTask(taskId);
  if (!task || task.ownerKind !== "daemon") throw new RemoteAccessError("pc_unavailable", "PC device task is unavailable.");
  const belongs = task.targetDeviceIds.length > 0
    && task.targetDeviceIds.every(deviceId => store.getDevice(deviceId)?.device.ownerScope === workspaceId);
  if (!belongs) throw new RemoteAccessError("workspace_not_allowed", "Device task is outside the paired workspace.");
  return task;
}
