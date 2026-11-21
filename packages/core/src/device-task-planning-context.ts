import type { DeviceActionRequestV1, DeviceContextFactMetadataV1, JsonValue } from "@ling-stack/contracts";

import { isCurrentDeviceObservation, projectDeviceDiagnosticEvidence } from "./device-diagnosis.js";
import { DeviceContextBuilder, DeviceFabricError } from "./device-fabric.js";
import type { DevicePlanningTarget } from "./device-orchestration.js";
import type { DevicePlanningRunnerInput } from "./device-runner.js";
import type { SqliteDeviceSupportStore } from "./storage/sqlite/device-support-store.js";

export function buildOwnedDevicePlanningInput(input: {
  readonly store: SqliteDeviceSupportStore;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly maxBytes: number;
  readonly now: string;
}): DevicePlanningRunnerInput {
  const { store } = input;
  return store.withWriteTransaction(() => {
    const task = store.getTask(input.taskId);
    if (!task || task.ownerKind !== "daemon" || task.ownerId !== input.ownerId) {
      throw new DeviceFabricError("safety_denied", "device planning requires the owning runtime");
    }
    const nowMs = Date.parse(input.now);
    const targets: DevicePlanningTarget[] = task.targetDeviceIds.map(deviceId => {
      const profile = store.getDevice(deviceId);
      if (profile?.device.ownerScope !== input.workspaceId || ["offline", "retired", "revoked"].includes(profile.device.lifecycleStatus)) {
        throw new DeviceFabricError("safety_denied", "device planning target is outside the workspace or unavailable");
      }
      const snapshot = store.getCurrentCapabilitySnapshot(deviceId);
      if (!snapshot || snapshot.adapterId !== profile.adapterId || snapshot.adapterVersion !== profile.adapterVersion
        || !task.capabilitySnapshotIds.includes(snapshot.snapshotId)
        || !(Date.parse(snapshot.observedAt) <= nowMs && nowMs < Date.parse(snapshot.freshnessUntil))) {
        throw new DeviceFabricError("target_changed", "device planning requires a current capability snapshot for each target");
      }
      return { ownerKind: task.ownerKind, ownerId: task.ownerId, snapshot };
    });
    const snapshots = new Map(targets.map(target => [target.snapshot.deviceId, target.snapshot.snapshotId]));
    const requestsByObservation = new Map<string, DeviceActionRequestV1>();
    for (const { attempt, request } of store.listAttempts(task.id)) {
      if (attempt.ownerKind !== task.ownerKind || attempt.ownerId !== task.ownerId
        || snapshots.get(request.targetDeviceId) !== request.capabilitySnapshotId) continue;
      for (const id of [...(attempt.receipt?.observationIds ?? []), ...(attempt.verification?.observationIds ?? [])]) {
        requestsByObservation.set(id, request);
      }
    }
    const facts: JsonValue[] = [];
    const hypotheses: JsonValue[] = [];
    const factMetadata: DeviceContextFactMetadataV1[] = [];
    const observations: string[] = [];
    for (const observation of store.listObservations(task.id)) {
      const request = requestsByObservation.get(observation.id);
      if (!request || observation.redactionClass !== "public") continue;
      observations.push(observation.id);
      if (!isCurrentDeviceObservation(observation, input.now)) continue;
      const projected = projectDeviceDiagnosticEvidence(request, observation);
      if (!projected) continue;
      facts.push(projected.value);
      hypotheses.push(...projected.hypotheses.map(code => ({ code, observationId: observation.id })));
      factMetadata.push({
        observationId: observation.id, source: observation.source, observedAt: observation.observedAt,
        freshnessUntil: observation.freshnessUntil, quality: observation.quality, redactionClass: observation.redactionClass,
      });
    }
    const context = new DeviceContextBuilder().build({
      contextId: input.contextId, taskId: task.id, maxBytes: input.maxBytes, generatedAt: input.now,
      facts, hypotheses, observations, untrustedTextRefs: observations, factMetadata,
    });
    return { context, targets, planningInputRefs: [context.contextId, ...observations] };
  });
}
