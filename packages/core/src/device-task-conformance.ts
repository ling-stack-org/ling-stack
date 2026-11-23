import { createHash } from "node:crypto";

import { projectDeviceAttemptChecks, projectDeviceCapabilitySnapshotForTrace, type DeviceAttemptConformanceReportV1 } from "@ling-stack/contracts";

import { isCurrentDeviceObservation } from "./device-diagnosis.js";
import { DeviceBrokerError } from "./device-support.js";
import { requireWorkspaceDeviceTask } from "./device-task-event-projector.js";
import type { SqliteDeviceSupportStore } from "./storage/sqlite/device-support-store.js";
import { readSqliteSnapshot } from "./storage/sqlite/read-snapshot.js";

export function readOwnedDeviceAttemptConformance(input: {
  readonly store: SqliteDeviceSupportStore;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly attemptId: string;
}): DeviceAttemptConformanceReportV1 {
  const { store, workspaceId, taskId, attemptId } = input;
  return readSqliteSnapshot(store.database, () => {
    const task = requireWorkspaceDeviceTask(store, taskId, workspaceId);
    const record = store.getAttempt(task.id, attemptId);
    if (!record || record.attempt.ownerKind !== task.ownerKind || record.attempt.ownerId !== task.ownerId
      || !task.targetDeviceIds.includes(record.attempt.targetDeviceId) || record.attempt.targetDeviceId !== record.request.targetDeviceId) {
      throw new DeviceBrokerError("missing_target", "device attempt is unavailable in this task");
    }
    const { attempt, request } = record;
    const deviceId = attempt.targetDeviceId;
    const recorded = store.getRecordedCapabilitySnapshot(deviceId, request.capabilitySnapshotId);
    const capabilityRecord = recorded?.workspaceId === workspaceId ? recorded : undefined;
    const adapter = attempt.adapterBinding;
    const traceId = `device-task:${task.id}`;
    const attemptSpanId = `${traceId}:attempt:${attemptId}`;
    const snapshot = capabilityRecord?.snapshot;
    const reconciled = store.listReconciliations(taskId).filter(entry => entry.attemptId === attemptId && entry.status === "verified").at(-1);
    const verification = reconciled?.verification ?? (attempt.status === "completed" ? attempt.verification : undefined);
    const evidenceRef = verification?.observationIds.find(id => {
      const observation = store.getObservation(taskId, id);
      return observation?.subjectId === deviceId && isCurrentDeviceObservation(observation, verification.checkedAt);
    });
    const checks = projectDeviceAttemptChecks({
      attempt, request, attemptSpanId,
      snapshot: capabilityRecord && projectDeviceCapabilitySnapshotForTrace(capabilityRecord.snapshot, capabilityRecord.profileRevision),
      readback: evidenceRef && verification ? { status: verification.status, evidenceRef } : undefined,
    });
    const plan = attempt.planningNode && store.listPlanningAcceptances(taskId)
      .find(entry => entry.proposalId === attempt.planningNode?.proposalId);
    const report: Omit<DeviceAttemptConformanceReportV1, "reportId"> = {
      runtimeId: attempt.ownerId,
      adapterId: adapter?.adapterId ?? snapshot?.adapterId ?? "unrecorded",
      adapterVersion: adapter?.adapterVersion ?? snapshot?.adapterVersion ?? "unrecorded",
      targetProfile: adapter?.profileRevision ?? capabilityRecord?.profileRevision ?? "unrecorded",
      transport: adapter?.transport ?? "unrecorded",
      checks,
      generatedAt: task.updatedAt,
      source: {
        workspaceId, taskId, attemptId, deviceId, capabilityId: request.capabilityId,
        capabilitySnapshotId: request.capabilitySnapshotId, traceId, journalSequence: store.countEvents(taskId),
        ...(attempt.connectionRevision ? { connectionRevision: attempt.connectionRevision } : {}),
        ...(adapter?.firmwareVersion ? { firmwareVersion: adapter.firmwareVersion } : {}),
        ...(plan?.providerId ? { providerId: plan.providerId } : {}),
        ...(plan?.modelTurnId ? { modelTurnId: plan.modelTurnId } : {}),
      },
    };
    return { reportId: `device_conformance_${createHash("sha256").update(JSON.stringify(report)).digest("hex")}`, ...report };
  });
}
