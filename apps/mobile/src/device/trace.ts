import type {
  DeviceObservationV1,
  DeviceTaskAttemptV1,
  DeviceTaskTraceCapabilitySnapshotV1,
  DeviceTaskTraceV1,
  DeviceTaskV1,
  DeviceTraceLineageV1,
  DeviceTraceSpanV1,
} from "@ling-stack/contracts";

import type { MobileTaskEvidence } from "./journal.js";

/** Projects the retained phone journal without exposing request inputs, device values or raw transport output. */
export function projectMobileDeviceTaskTrace({ task, attempts, observations }: MobileTaskEvidence, ownerId: string): DeviceTaskTraceV1 | undefined {
  if (!task || task.ownerKind !== "mobile" || task.ownerId !== ownerId) return undefined;

  const traceId = `device-task:${task.id}`;
  const rootSpanId = `${traceId}:task`;
  const taskLineage = { taskId: task.id, runtimeId: task.ownerId };
  const status = taskSpanStatus(task.status);
  const spans: DeviceTraceSpanV1[] = [{
    spanId: rootSpanId, traceId, kind: "runtime", sourceId: task.ownerId,
    startedAt: task.createdAt, ...(status !== "running" ? { finishedAt: task.updatedAt } : {}),
    status, lineage: taskLineage,
    metadata: { taskStatus: task.status, capabilitySnapshotIds: task.capabilitySnapshotIds },
  }];
  const publicObservations = new Map(observations.filter(item => item.redactionClass === "public").map(item => [item.id, item]));
  const capabilitySnapshots = new Map<string, DeviceTaskTraceCapabilitySnapshotV1>();
  for (const { attempt, request } of attempts) {
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
    if (!verification || verification.actionId !== attempt.actionId) continue;
    const evidenceId = `${attempt.actionId}:verification`;
    const checkedAt = Date.parse(verification.checkedAt);
    const earliestReadback = Date.parse(receipt?.finishedAt ?? dispatchIntentAt);
    const readback = ownedEvidence(verification.observationIds, publicObservations, targetDeviceId).filter(observation =>
      observation.subjectId === targetDeviceId && (observation.quality === "good" || observation.quality === "degraded")
      && earliestReadback <= Date.parse(observation.observedAt) && Date.parse(observation.observedAt) <= checkedAt
      && checkedAt < Date.parse(observation.freshnessUntil));
    const evidenceRefs = readback.map(observation => observation.id);
    const trustworthy = attempt.status === "completed" && evidenceRefs.length > 0
      && evidenceRefs.length === new Set(verification.observationIds).size && checkedAt <= Date.parse(task.updatedAt);
    spans.push({
      spanId: `${traceId}:verification:${evidenceId}`, traceId, parentSpanId: spanId, kind: "verification", sourceId: evidenceId,
      startedAt: verification.checkedAt, finishedAt: verification.checkedAt, lineage,
      status: !trustworthy || verification.status === "not_evaluable" ? "unknown" : verification.status === "verified" ? "ok" : "failed",
      metadata: { verificationStatus: verification.status, evidenceRefs },
    });
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
