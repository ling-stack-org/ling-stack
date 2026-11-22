import type {
  DeviceObservationV1,
  DeviceTaskAttemptV1,
  DeviceTaskTraceCapabilitySnapshotV1,
  DeviceTaskTraceV1,
  DeviceTaskV1,
  DeviceTraceLineageV1,
  DeviceTraceSpanV1,
  DeviceVerificationResultV1,
  JsonValue,
} from "@ling-stack/contracts";

import type { MobileTaskEvidence } from "./journal.js";

/** Projects the retained phone journal without exposing request inputs, device values or raw transport output. */
export function projectMobileDeviceTaskTrace({ task, attempts, observations }: MobileTaskEvidence, ownerId: string): DeviceTaskTraceV1 | undefined {
  if (!task || task.ownerKind !== "mobile" || task.ownerId !== ownerId) return undefined;

  const traceId = `device-task:${task.id}`;
  const rootSpanId = `${traceId}:task`;
  const taskLineage = { taskId: task.id, runtimeId: task.ownerId };
  const taskUpdatedAt = Date.parse(task.updatedAt);
  const status = taskSpanStatus(task.status);
  const spans: DeviceTraceSpanV1[] = [{
    spanId: rootSpanId, traceId, kind: "runtime", sourceId: task.ownerId,
    startedAt: task.createdAt, ...(status !== "running" ? { finishedAt: task.updatedAt } : {}),
    status, lineage: taskLineage,
    metadata: { taskStatus: task.status, capabilitySnapshotIds: task.capabilitySnapshotIds },
  }];
  const publicObservations = new Map(observations.filter(item => item.redactionClass === "public").map(item => [item.id, item]));
  const capabilitySnapshots = new Map<string, DeviceTaskTraceCapabilitySnapshotV1>();
  for (const { attempt, request, reconciliations } of attempts) {
    if (attempt.ownerKind !== "mobile" || attempt.ownerId !== ownerId || attempt.taskId !== task.id || request.taskId !== task.id
      || attempt.actionId !== request.actionId || attempt.targetDeviceId !== request.targetDeviceId
      || !task.targetDeviceIds.includes(attempt.targetDeviceId) || !task.capabilitySnapshotIds.includes(request.capabilitySnapshotId)) continue;

    const { adapterBinding, attemptId, connectionRevision, dispatchIntentAt, receipt, targetDeviceId, verification } = attempt;
    const spanId = `${traceId}:attempt:${attemptId}`;
    const lineage: DeviceTraceLineageV1 = {
      ...taskLineage, attemptId, deviceId: targetDeviceId,
      ...(connectionRevision ? { connectionRevision } : {}),
      ...(adapterBinding ? { adapterId: adapterBinding.adapterId } : {}),
    };
    const snapshotId = request.capabilitySnapshotId;
    capabilitySnapshots.set(JSON.stringify([targetDeviceId, snapshotId]), { state: "unavailable", snapshotId, deviceId: targetDeviceId });
    spans.push({
      spanId, traceId, parentSpanId: rootSpanId, kind: "adapter", sourceId: adapterBinding?.adapterId ?? attemptId,
      startedAt: dispatchIntentAt, ...(receipt?.finishedAt ? { finishedAt: receipt.finishedAt } : {}),
      status: attemptSpanStatus(attempt.status), lineage,
      metadata: {
        attemptStatus: attempt.status, capabilityId: request.capabilityId, capabilitySnapshotId: snapshotId,
        ...(adapterBinding ? { adapterBinding: { ...adapterBinding } } : {}),
        ...(receipt ? {
          receiptStatus: receipt.status,
          ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
          evidenceRefs: ownedEvidence(receipt.observationIds, publicObservations, targetDeviceId).map(observation => observation.id),
        } : {}),
      },
    });
    const earliestReadback = Date.parse(receipt?.finishedAt ?? dispatchIntentAt);
    function recordReadback(
      result: DeviceVerificationResultV1, evidenceId: string, authorized: boolean, binding: DeviceTraceLineageV1,
      metadata: Readonly<Record<string, JsonValue>> = {},
    ): void {
      const checkedAt = Date.parse(result.checkedAt);
      const evidenceRefs = ownedEvidence(result.observationIds, publicObservations, targetDeviceId).flatMap(observation =>
        observation.subjectId === targetDeviceId && (observation.quality === "good" || observation.quality === "degraded")
        && earliestReadback <= Date.parse(observation.observedAt) && Date.parse(observation.observedAt) <= checkedAt
        && checkedAt < Date.parse(observation.freshnessUntil) ? [observation.id] : []);
      const trustworthy = authorized && evidenceRefs.length > 0
        && evidenceRefs.length === new Set(result.observationIds).size && checkedAt <= taskUpdatedAt;
      spans.push({
        spanId: `${traceId}:verification:${evidenceId}`, traceId, parentSpanId: spanId, kind: "verification", sourceId: evidenceId,
        startedAt: result.checkedAt, finishedAt: result.checkedAt, lineage: binding,
        status: !trustworthy || result.status === "not_evaluable" ? "unknown" : result.status === "verified" ? "ok" : "failed",
        metadata: { verificationStatus: result.status, evidenceRefs, ...metadata },
      });
    }
    if (verification?.actionId === attempt.actionId) {
      recordReadback(verification, `${attempt.actionId}:verification`, attempt.status === "completed", lineage);
    }
    for (const readback of reconciliations ?? []) {
      if (readback.taskId !== task.id || readback.attemptId !== attemptId || readback.verification.actionId !== attempt.actionId
        || !task.capabilitySnapshotIds.includes(readback.capabilitySnapshotId)) continue;
      capabilitySnapshots.set(JSON.stringify([targetDeviceId, readback.capabilitySnapshotId]), {
        state: "unavailable", snapshotId: readback.capabilitySnapshotId, deviceId: targetDeviceId,
      });
      recordReadback(readback.verification, readback.reconciliationId,
        task.status === "succeeded" && task.lastVerificationId === readback.reconciliationId && readback.status === "verified",
        { ...lineage, connectionRevision: readback.connectionRevision }, {
          capabilitySnapshotId: readback.capabilitySnapshotId,
          ...(readback.readCapabilityId ? { capabilityId: readback.readCapabilityId } : {}),
        });
    }
  }
  return { traceId, taskId: task.id, taskStatus: task.status, spans, capabilitySnapshots: [...capabilitySnapshots.values()] };
}

function ownedEvidence(ids: readonly string[], observations: ReadonlyMap<string, DeviceObservationV1>, deviceId: string): readonly DeviceObservationV1[] {
  return [...new Set(ids)].flatMap(id => {
    const observation = observations.get(id);
    return observation?.provenance.includes(deviceId) ? [observation] : [];
  });
}

function taskSpanStatus(status: DeviceTaskV1["status"]): DeviceTraceSpanV1["status"] {
  if (status === "succeeded") return "ok";
  if (status === "unknown") return "unknown";
  return ["failed", "partial", "cancelled"].includes(status) ? "failed" : "running";
}

function attemptSpanStatus(status: DeviceTaskAttemptV1["status"]): DeviceTraceSpanV1["status"] {
  if (status === "completed") return "ok";
  if (status === "unknown") return "unknown";
  return ["failed", "cancelled"].includes(status) ? "failed" : "running";
}
