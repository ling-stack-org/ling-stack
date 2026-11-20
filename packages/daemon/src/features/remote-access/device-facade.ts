import type {
  RemoteDeviceListSnapshotV1,
  RemoteDeviceTaskApproveCommandV1,
  RemoteDeviceTaskSnapshotV1,
  RemoteDeviceTaskRevokeCommandV1,
  RemoteDeviceTaskStatusCommandV1,
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
      };
    },
    taskSnapshot(input) {
      return snapshotForTask(options.store, input.workspaceId, input.taskId, now());
    },
    async approveTask(input) {
      const task = options.store.getTask(input.taskId);
      assertTaskWorkspace(options.store, task, input.workspaceId);
      if (!options.approve) throw new RemoteAccessError("pc_unavailable", "Device approval executor is not attached.", true);
      await options.approve(input);
      return snapshotForTask(options.store, input.workspaceId, input.taskId, now());
    },
    revokeTask(input) {
      const task = options.store.getTask(input.taskId);
      assertTaskWorkspace(options.store, task, input.workspaceId);
      if (!task) throw new RemoteAccessError("pc_unavailable", "Device task is unavailable.", true);
      if (!["succeeded", "failed", "cancelled"].includes(task.status)) {
        options.store.transitionTask(task.id, "cancelled", {}, now());
      }
      return snapshotForTask(options.store, input.workspaceId, input.taskId, now());
    },
  };
}

function snapshotForTask(store: SqliteDeviceSupportStore, workspaceId: string, taskId: string, generatedAt: string): RemoteDeviceTaskSnapshotV1 {
  const task = store.getTask(taskId);
  assertTaskWorkspace(store, task, workspaceId);
  if (!task) throw new RemoteAccessError("pc_unavailable", "Device task is unavailable.", true);
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
    },
  };
}

function assertTaskWorkspace(store: SqliteDeviceSupportStore, task: ReturnType<SqliteDeviceSupportStore["getTask"]>, workspaceId: string): void {
  if (!task) throw new RemoteAccessError("pc_unavailable", "Device task is unavailable.", true);
  const belongs = task.targetDeviceIds.every(deviceId => store.getDevice(deviceId)?.device.ownerScope === workspaceId);
  if (!belongs) throw new RemoteAccessError("workspace_not_allowed", "Device task is outside the paired workspace.");
}
