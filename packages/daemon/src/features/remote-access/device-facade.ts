import {
  REMOTE_DEVICE_RECENT_TASK_LIMIT_V1,
  REMOTE_PROTOCOL_LIMITS,
  type DeviceTaskV1,
  type RemoteDeviceListSnapshotV1,
  type RemoteDeviceTaskApproveCommandV1,
  type RemoteDeviceTaskJournalCommandV1,
  type RemoteDeviceTaskJournalV1,
  type RemoteDeviceTaskReconcileCommandV1,
  type RemoteDeviceTaskSnapshotV1,
  type RemoteDeviceTaskRevokeCommandV1,
  type RemoteDeviceTaskStatusCommandV1,
} from "@ling-stack/contracts";
import { DeviceBrokerError, readOwnedDeviceTaskJournal, type DeviceCapabilityBroker, type SqliteDeviceSupportStore } from "@ling-stack/core";
import { RemoteAccessError } from "./errors.js";

export interface RemoteDeviceFacade {
  listDevices(workspaceId: string): RemoteDeviceListSnapshotV1;
  taskSnapshot(input: RemoteDeviceTaskStatusCommandV1): RemoteDeviceTaskSnapshotV1;
  taskJournal(input: RemoteDeviceTaskJournalCommandV1): RemoteDeviceTaskJournalV1;
  approveTask(input: RemoteDeviceTaskApproveCommandV1): Promise<RemoteDeviceTaskSnapshotV1>;
  revokeTask(input: RemoteDeviceTaskRevokeCommandV1): RemoteDeviceTaskSnapshotV1;
  reconcileTask(input: RemoteDeviceTaskReconcileCommandV1): Promise<{
    readonly status: "verified" | "unresolved";
    readonly snapshot: RemoteDeviceTaskSnapshotV1;
  }>;
}

export interface RemoteDeviceFacadeOptions {
  readonly store: SqliteDeviceSupportStore;
  readonly broker?: DeviceCapabilityBroker;
  readonly now?: () => string;
  readonly approve?: (input: RemoteDeviceTaskApproveCommandV1) => Promise<void>;
}

export function createRemoteDeviceFacade(options: RemoteDeviceFacadeOptions): RemoteDeviceFacade {
  const now = options.now ?? (() => new Date().toISOString());
  const snapshot = (input: RemoteDeviceTaskStatusCommandV1) =>
    snapshotForTask(options.store, input.workspaceId, input.taskId, now(), options.broker);
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
    taskSnapshot: snapshot,
    taskJournal(input) {
      requireDaemonTask(options.store, input.taskId, input.workspaceId);
      const { task, ...page } = readOwnedDeviceTaskJournal({ store: options.store, ...input });
      const journal: RemoteDeviceTaskJournalV1 = {
        ...page,
        workspaceId: input.workspaceId,
        afterSequence: input.afterSequence,
        task: {
          taskId: task.id, ownerId: task.ownerId, status: task.status, updatedAt: task.updatedAt,
          ...(task.lastVerificationId ? { lastVerificationId: task.lastVerificationId } : {}),
        },
      };
      if (Buffer.byteLength(JSON.stringify(journal)) > REMOTE_PROTOCOL_LIMITS.maxFrameBytes - 4096) {
        throw new RemoteAccessError("payload_too_large", "The device journal page exceeds the remote frame limit.");
      }
      return journal;
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
      return snapshot(input);
    },
    revokeTask(input) {
      requireDaemonTask(options.store, input.taskId, input.workspaceId);
      if (options.broker) options.broker.cancelTask(input.taskId);
      else options.store.stopDaemonTask(input.taskId, now());
      return snapshot(input);
    },
    async reconcileTask(input) {
      requireDaemonTask(options.store, input.taskId, input.workspaceId);
      if (!options.broker) throw new RemoteAccessError("pc_unavailable", "Device verification executor is not attached.", true);
      const preview = options.broker.getReconciliationPreview(input.taskId);
      if (!preview || preview.attemptId !== input.attemptId || preview.capabilitySnapshotId !== input.capabilitySnapshotId) {
        throw new RemoteAccessError("resync_required", "The device verification binding changed. Refresh the task.", true);
      }
      try {
        const result = await options.broker.reconcileTask({
          taskId: input.taskId,
          attemptId: input.attemptId,
          capabilitySnapshotId: input.capabilitySnapshotId,
          refreshExpiredSnapshot: true,
        });
        return { status: result.status, snapshot: snapshot(input) };
      } catch (error) {
        if (error instanceof RemoteAccessError) throw error;
        throw new RemoteAccessError("pc_unavailable", "The PC could not verify the current device state.", error instanceof DeviceBrokerError);
      }
    },
  };
}

function snapshotForTask(
  store: SqliteDeviceSupportStore,
  workspaceId: string,
  taskId: string,
  generatedAt: string,
  broker?: DeviceCapabilityBroker,
): RemoteDeviceTaskSnapshotV1 {
  const task = requireDaemonTask(store, taskId, workspaceId);
  const pendingReconciliation = broker?.getReconciliationPreview(task.id);
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
      ...(pendingReconciliation ? { pendingReconciliation } : {}),
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
