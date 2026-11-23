import { createHash } from "node:crypto";
import type {
  CapabilitySideEffectV1, DeviceActionRequestV1, DeviceDeveloperExecutorResultV1, DeviceDeveloperJobV1, DeviceDeveloperSessionV1,
  DeviceNativeWorkbenchRequestV1, DeviceProfileV1,
} from "@ling-stack/contracts";
import {
  DeviceBrokerError, digestRequest, matchesNativeWorkbenchReadback, type DeviceCapabilityBroker,
  type DeviceDeveloperSessionCoordinator, type SqliteDeviceSupportStore,
} from "@ling-stack/core";

import { androidAdbAdapterId, androidAdbInstallCapability, androidAdbLogCapability } from "./adapters/android-adb.js";
import type { AndroidProjectBuilds } from "./android-project-builds.js";

export interface DeviceDeveloperExecutor {
  nativeWorkbenchSideEffect?(input: {
    readonly session: DeviceDeveloperSessionV1;
    readonly operation: DeviceNativeWorkbenchRequestV1;
  }): CapabilitySideEffectV1 | undefined;
  execute(input: {
    readonly session: DeviceDeveloperSessionV1;
    readonly job: DeviceDeveloperJobV1;
    readonly signal: AbortSignal;
    readonly assertCurrent: () => void;
  }): Promise<DeviceDeveloperExecutorResultV1>;
}

type JobRequest = Pick<DeviceDeveloperJobV1, "jobId" | "artifactDigest" | "buildId" | "nativeWorkbench"> & {
  readonly kind: DeviceDeveloperJobV1["kind"];
  readonly authorizationRevision: string;
  readonly expectedSessionRevision?: number;
};

export function createDeviceDeveloperJobs(options: {
  readonly broker: DeviceCapabilityBroker;
  readonly sessions: DeviceDeveloperSessionCoordinator;
  readonly executor?: DeviceDeveloperExecutor;
  readonly androidProjectBuilds?: AndroidProjectBuilds;
  readonly canDeployAndroid?: (deviceId: string) => boolean;
  readonly now: () => string;
}) {
  const { broker, sessions, now } = options;
  const { store } = broker;
  return {
    async submit(session: DeviceDeveloperSessionV1, request: JobRequest) {
      if (session.mode !== "developer" || session.protocolReplay) {
        throw new DeviceBrokerError("permission_denied", "developer jobs require a developer session");
      }
      const { expectedSessionRevision, ...jobRequest } = request;
      const input: DeviceDeveloperJobV1 = {
        ...jobRequest, sessionId: session.sessionId, targetDeviceId: session.targetDeviceId,
        status: "running", taskStatus: "executing", revision: 1, updatedAt: now(),
      };
      if (sessions.getJob(input.jobId)) return sessions.admitJob(input);
      if (session.status !== "authorized" || request.authorizationRevision !== session.authorizationRevision) {
        throw new DeviceBrokerError("permission_denied", "developer job authorization is no longer active");
      }
      const target = requireCurrentDeveloperTarget(store, session);
      const profile = store.getDevice(target.deviceId)!;
      const projectBuild = request.buildId ? options.androidProjectBuilds?.get(request.buildId) : undefined;
      if (request.buildId && (!projectBuild || request.kind !== "build" || profile.adapterId !== "pc-target-executor"
        || !profile.transports.includes("local_process"))) {
        throw new DeviceBrokerError("unsupported_capability", "Select a configured build in the PC workspace");
      }
      if (projectBuild && expectedSessionRevision !== session.revision) {
        throw new DeviceBrokerError("target_changed", "The reviewed project build session changed");
      }
      const executor = options.executor;
      let dispatchStopRevision: number | undefined;
      if (request.kind === "workbench") {
        if (expectedSessionRevision !== session.revision) {
          throw new DeviceBrokerError("target_changed", "The reviewed native workbench session changed");
        }
        const sideEffect = request.nativeWorkbench && executor?.nativeWorkbenchSideEffect?.({ session, operation: request.nativeWorkbench });
        if (!sideEffect) {
          throw new DeviceBrokerError("unsupported_capability", "native workbench access is unavailable for this target");
        }
        if (sideEffect !== "read_only") {
          const stop = store.getDispatchStop(target.deviceId);
          if (stop.active) throw new DeviceBrokerError("permission_denied", "device writes are stopped");
          dispatchStopRevision = stop.revision;
        }
      }
      const logCapabilityId = request.kind === "logs" ? resolveDefaultLogCapability(broker, profile) : undefined;
      const nativeDeploy = !executor && request.kind === "deploy" && profile.adapterId === androidAdbAdapterId
        && options.canDeployAndroid?.(target.deviceId) === true;
      if (!executor && !logCapabilityId && !nativeDeploy && !projectBuild) {
        throw new DeviceBrokerError("unsupported_capability", "the target does not provide this developer job");
      }
      const apk = nativeDeploy && session.artifactId ? sessions.getArtifact(session.artifactId) : undefined;
      const packageId = apk?.packageId;
      const androidVersion = Number(profile.device.firmwareVersion?.split(".")[0]);
      const versionCode = androidVersion > 0 && androidVersion < 9 && apk?.androidApk?.legacyVersionCode
        ? apk.androidApk.legacyVersionCode : apk?.androidApk?.versionCode;
      if (nativeDeploy && (expectedSessionRevision !== session.revision || !apk || !packageId || !versionCode
        || apk.digest !== request.artifactDigest || apk.digest !== session.artifactDigest
        || apk.workspaceId !== session.workspaceId || apk.targetDeviceId !== session.targetDeviceId)) {
        throw new DeviceBrokerError("target_changed", "the confirmed APK or its developer session changed");
      }
      const { job, admitted } = sessions.admitJob(input);
      if (!admitted) return { job, admitted };

      const signal = AbortSignal.timeout(projectBuild ? 30 * 60_000 : 60_000);
      const assertCurrent = () => {
        signal.throwIfAborted();
        requireCurrentDeveloperTarget(store, session);
        const current = sessions.getSession(session.sessionId);
        if (current?.status !== "running" || current.authorizationRevision !== session.authorizationRevision
          || (job.nativeWorkbench && current.revision !== session.revision + 1)) {
          throw new DeviceBrokerError("permission_denied", "Developer job authorization changed");
        }
      };
      const assertNativeDispatch = () => {
        assertCurrent();
        if (dispatchStopRevision !== undefined) {
          const stop = store.getDispatchStop(target.deviceId);
          if (stop.active || stop.revision !== dispatchStopRevision) {
            throw new DeviceBrokerError("permission_denied", "device write stop changed before native dispatch");
          }
        }
      };
      let result: DeviceDeveloperExecutorResultV1 | undefined;
      let readbackCheckedAt: string | undefined;
      try {
        if (projectBuild) {
          const artifact = await options.androidProjectBuilds!.run(projectBuild, job.jobId, signal, assertCurrent)
            .catch(error => {
              if (error instanceof DeviceBrokerError && error.code === "invalid_request") return undefined;
              throw error;
            });
          assertCurrent();
          if (artifact) {
            const artifactId = "android-build:" + createHash("sha256").update(JSON.stringify([job.jobId, artifact.digest])).digest("hex");
            const settled = sessions.completeBuildJob(job.jobId, {
              ...artifact, artifactId, workspaceId: session.workspaceId, targetDeviceId: job.targetDeviceId, createdAt: now(),
            }, now());
            return { job: settled, admitted };
          }
          result = { status: "failed", taskStatus: "failed" };
        } else if (executor) {
          if (job.nativeWorkbench) assertNativeDispatch();
          result = await executor.execute({ session, job, signal, assertCurrent: job.nativeWorkbench ? assertNativeDispatch : assertCurrent });
          if (job.nativeWorkbench) {
            assertCurrent();
            readbackCheckedAt = now();
            result = readNativeWorkbenchOutcome(job, session, result, readbackCheckedAt);
          }
        } else if (nativeDeploy && apk && packageId && versionCode) {
          result = await deployAndroidApk(broker, sessions, session, job, { artifactDigest: apk.digest, packageId, versionCode }, signal);
        } else result = await captureDeviceLogs(broker, session, job, logCapabilityId!, signal);
        signal.throwIfAborted();
        requireCurrentDeveloperTarget(store, session);
      } catch {
        result = { status: "unknown", taskStatus: "unknown", outputRef: job.nativeWorkbench ? undefined : result?.outputRef };
      }
      const settled = sessions.settleJob(job.jobId, result.status, result.outputRef, readbackCheckedAt ?? now(), result.taskStatus, result.outputDigest,
        job.nativeWorkbench ? result.nativeWorkbenchReadback : undefined);
      return { job: settled, admitted };
    },
  };
}

function readNativeWorkbenchOutcome(
  job: DeviceDeveloperJobV1, session: DeviceDeveloperSessionV1, result: DeviceDeveloperExecutorResultV1, now: string,
): DeviceDeveloperExecutorResultV1 {
  const readback = result.nativeWorkbenchReadback;
  const outputRef = typeof result.outputRef === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(result.outputRef)
    ? result.outputRef : undefined;
  if ((result.status === "completed" || result.status === "failed") && matchesNativeWorkbenchReadback(job, session, readback, now)) {
    if (readback.status === "failed") return { status: "failed", taskStatus: "failed", outputRef, nativeWorkbenchReadback: readback };
    if (result.status === "completed") return {
      status: "completed", taskStatus: "succeeded", outputRef, nativeWorkbenchReadback: readback,
      ...(outputRef && typeof result.outputDigest === "string" && /^[a-f0-9]{64}$/u.test(result.outputDigest)
        ? { outputDigest: result.outputDigest } : {}),
    };
  }
  if (result.status === "cancelled") return { status: "cancelled", taskStatus: "cancelled", outputRef };
  if (result.status === "failed" && readback === undefined) return { status: "failed", taskStatus: "failed", outputRef };
  return { status: "unknown", taskStatus: "unknown", outputRef };
}

export function retainedAndroidDeployResult(store: SqliteDeviceSupportStore, job: DeviceDeveloperJobV1): DeviceDeveloperExecutorResultV1 | undefined {
  if (job.kind !== "deploy") return undefined;
  const task = store.getTask(`developer-deploy:${job.jobId}`);
  if (!task || task.ownerKind !== "daemon" || task.ownerId !== job.targetDeviceId
    || task.targetDeviceIds.length !== 1 || task.targetDeviceIds[0] !== job.targetDeviceId) return undefined;
  return developerTaskResult(task.id, task.status);
}

async function deployAndroidApk(
  broker: DeviceCapabilityBroker, sessions: DeviceDeveloperSessionCoordinator, session: DeviceDeveloperSessionV1,
  job: DeviceDeveloperJobV1, artifact: { readonly artifactDigest: string; readonly packageId: string; readonly versionCode: string }, signal: AbortSignal,
): Promise<DeviceDeveloperExecutorResultV1> {
  const target = requireCurrentDeveloperTarget(broker.store, session);
  const snapshot = await broker.refreshCapabilities(target.deviceId, target.connectionRevision, signal);
  requireCurrentDeveloperTarget(broker.store, session);
  const capability = snapshot.capabilities.find(item => item.id === androidAdbInstallCapability && item.approvalClass === "ask");
  if (!capability) return { status: "failed", taskStatus: "failed" };
  const taskId = `developer-deploy:${job.jobId}`;
  const createdAt = broker.now();
  broker.createTask({
    id: taskId, ownerKind: "daemon", ownerId: target.deviceId, targetDeviceIds: [target.deviceId],
    status: "planning", capabilitySnapshotIds: [snapshot.snapshotId], createdAt, updatedAt: createdAt,
  });
  const request: DeviceActionRequestV1 = {
    actionId: `${taskId}:install`, taskId, targetDeviceId: target.deviceId, capabilityId: capability.id,
    capabilitySchemaVersion: capability.schemaVersion, capabilitySnapshotId: snapshot.snapshotId,
    normalizedInput: { ...artifact }, expectedVerification: { packageId: artifact.packageId, versionCode: artifact.versionCode },
    idempotencyKey: taskId,
  };
  const approvalId = `${taskId}:approval`;
  try {
    broker.proposeAction(request);
    await broker.execute({ ...request, approvalId, approval: {
      approvalId, taskId, actionId: request.actionId, targetDeviceId: target.deviceId,
      capabilitySnapshotId: snapshot.snapshotId, connectionRevision: target.connectionRevision, policyRevision: broker.policyRevision,
      normalizedInputDigest: digestRequest(request), expiresAt: snapshot.freshnessUntil,
    } }, signal, {
      requireCurrentProposal: true,
      isApprovalPrincipalCurrent() {
        const current = sessions.getSession(session.sessionId);
        return current?.status === "running" && current.authorizationRevision === session.authorizationRevision
          && current.artifactId === session.artifactId && current.artifactDigest === artifact.artifactDigest;
      },
    });
  } catch {
    broker.cancelTask(taskId);
  }
  return retainedAndroidDeployResult(broker.store, job) ?? { status: "unknown", taskStatus: "unknown" };
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
  return developerTaskResult(taskId, store.getTask(taskId)!.status);
}

function developerTaskResult(taskId: string, taskStatus: DeviceDeveloperJobV1["taskStatus"]): DeviceDeveloperExecutorResultV1 {
  const status = taskStatus === "succeeded" ? "completed" : taskStatus === "cancelled" ? "cancelled"
    : taskStatus === "failed" ? "failed" : "unknown";
  return { status, taskStatus: status === "unknown" ? "unknown" : taskStatus, outputRef: taskId };
}
