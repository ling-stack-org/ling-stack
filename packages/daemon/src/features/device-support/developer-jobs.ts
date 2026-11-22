import type { DeviceDeveloperExecutorResultV1, DeviceDeveloperJobV1, DeviceDeveloperSessionV1, DeviceProfileV1 } from "@ling-stack/contracts";
import { DeviceBrokerError, type DeviceCapabilityBroker, type DeviceDeveloperSessionCoordinator, type SqliteDeviceSupportStore } from "@ling-stack/core";

import { androidAdbAdapterId, androidAdbLogCapability } from "./adapters/android-adb.js";

export interface DeviceDeveloperExecutor {
  execute(input: {
    readonly session: DeviceDeveloperSessionV1;
    readonly job: DeviceDeveloperJobV1;
    readonly signal: AbortSignal;
  }): Promise<DeviceDeveloperExecutorResultV1>;
}

type JobRequest = Pick<DeviceDeveloperJobV1, "jobId" | "artifactDigest"> & {
  readonly kind: Exclude<DeviceDeveloperJobV1["kind"], "workbench">;
  readonly authorizationRevision: string;
};

export function createDeviceDeveloperJobs(options: {
  readonly broker: DeviceCapabilityBroker;
  readonly sessions: DeviceDeveloperSessionCoordinator;
  readonly executor?: DeviceDeveloperExecutor;
  readonly now: () => string;
}) {
  const { broker, sessions, now } = options;
  const { store } = broker;
  return {
    async submit(session: DeviceDeveloperSessionV1, request: JobRequest) {
      if (session.mode !== "developer" || session.protocolReplay) {
        throw new DeviceBrokerError("permission_denied", "developer jobs require a developer session");
      }
      const input: DeviceDeveloperJobV1 = {
        ...request, sessionId: session.sessionId, targetDeviceId: session.targetDeviceId,
        status: "running", taskStatus: "executing", revision: 1, updatedAt: now(),
      };
      if (sessions.getJob(input.jobId)) return sessions.admitJob(input);
      if (session.status !== "authorized" || request.authorizationRevision !== session.authorizationRevision) {
        throw new DeviceBrokerError("permission_denied", "developer job authorization is no longer active");
      }
      const target = requireCurrentDeveloperTarget(store, session);
      const profile = store.getDevice(target.deviceId)!;
      const executor = options.executor;
      const logCapabilityId = request.kind === "logs" ? resolveDefaultLogCapability(broker, profile) : undefined;
      if (!executor && !logCapabilityId) {
        throw new DeviceBrokerError("unsupported_capability", "the target does not provide this developer job");
      }
      const { job, admitted } = sessions.admitJob(input);
      if (!admitted) return { job, admitted };

      const signal = AbortSignal.timeout(60_000);
      let result: DeviceDeveloperExecutorResultV1 | undefined;
      try {
        result = executor ? await executor.execute({ session, job, signal })
          : await captureDeviceLogs(broker, session, job, logCapabilityId!, signal);
        signal.throwIfAborted();
        requireCurrentDeveloperTarget(store, session);
      } catch {
        result = { status: "unknown", taskStatus: "unknown", outputRef: result?.outputRef };
      }
      const settled = sessions.settleJob(job.jobId, result.status, result.outputRef, now(), result.taskStatus, result.outputDigest);
      return { job: settled, admitted };
    },
  };
}

export function assertDeveloperTargetActive(lifecycleStatus: string): void {
  if (lifecycleStatus === "revoked" || lifecycleStatus === "retired" || lifecycleStatus === "offline") {
    throw new DeviceBrokerError("target_changed", "device session target is unavailable");
  }
}

export function requireCurrentDeveloperTarget(store: SqliteDeviceSupportStore, session: DeviceDeveloperSessionV1) {
  const target = store.getDeviceRetirementState(session.targetDeviceId, session.workspaceId);
  assertDeveloperTargetActive(target.lifecycleStatus);
  if (session.targetBinding?.profileRevision !== target.profileRevision
    || session.targetBinding.connectionRevision !== target.connectionRevision) {
    throw new DeviceBrokerError("target_changed", "device session target binding changed");
  }
  return target;
}

function resolveDefaultLogCapability(broker: DeviceCapabilityBroker, profile: DeviceProfileV1): string | undefined {
  if (profile.adapterId === "pc-target-executor" && profile.transports.includes("local_process")) return "pc.inspect.logs";
  const snapshot = broker.store.getCurrentCapabilitySnapshot(profile.device.id);
  return profile.adapterId === androidAdbAdapterId && snapshot?.capabilities.some(item => item.id === androidAdbLogCapability
    && item.sideEffect === "read_only" && item.approvalClass === "allow") ? androidAdbLogCapability : undefined;
}

async function captureDeviceLogs(
  broker: DeviceCapabilityBroker, session: DeviceDeveloperSessionV1, job: DeviceDeveloperJobV1, capabilityId: string, signal: AbortSignal,
): Promise<DeviceDeveloperExecutorResultV1> {
  const { store } = broker;
  const target = requireCurrentDeveloperTarget(store, session);
  const saved = store.getCurrentCapabilitySnapshot(target.deviceId);
  const now = broker.now();
  const snapshot = saved && Date.parse(saved.freshnessUntil) > Date.parse(now) ? saved
    : await broker.refreshCapabilities(target.deviceId, target.connectionRevision, signal);
  requireCurrentDeveloperTarget(store, session);
  const capability = snapshot.capabilities.find(item => item.id === capabilityId && item.sideEffect === "read_only" && item.approvalClass === "allow");
  if (!capability) return { status: "failed", taskStatus: "failed" };
  const taskId = `developer-logs:${job.jobId}`;
  broker.createTask({
    id: taskId, ownerKind: "daemon", ownerId: target.deviceId, targetDeviceIds: [target.deviceId],
    status: "planning", capabilitySnapshotIds: [snapshot.snapshotId], createdAt: now, updatedAt: now,
  });
  try {
    await broker.execute({
      actionId: `${taskId}:capture`, taskId, targetDeviceId: target.deviceId, capabilityId: capability.id,
      capabilitySchemaVersion: capability.schemaVersion, capabilitySnapshotId: snapshot.snapshotId,
      normalizedInput: {}, idempotencyKey: taskId,
    }, signal, { onlyUnattendedReads: true });
  } catch {
    broker.cancelTask(taskId);
  }
  const taskStatus = store.getTask(taskId)!.status;
  const status = taskStatus === "succeeded" ? "completed" : taskStatus === "cancelled" ? "cancelled"
    : taskStatus === "failed" ? "failed" : "unknown";
  return { status, taskStatus, outputRef: taskId };
}
