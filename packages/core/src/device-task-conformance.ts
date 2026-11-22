import { createHash } from "node:crypto";

import type { DeviceAttemptConformanceReportV1 } from "@ling-stack/contracts";

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
    const checks: DeviceAttemptConformanceReportV1["checks"][number][] = [];
    const snapshot = capabilityRecord?.snapshot;
    if (!snapshot || !adapter || !attempt.connectionRevision) {
      checks.push({ id: "capability_binding", status: "skip" });
    } else {
      const atDispatch = Date.parse(attempt.dispatchIntentAt);
      const matched = snapshot.connectionRevision === attempt.connectionRevision
        && snapshot.adapterId === adapter.adapterId && snapshot.adapterVersion === adapter.adapterVersion
        && capabilityRecord.profileRevision === adapter.profileRevision
        && Date.parse(snapshot.observedAt) <= atDispatch && atDispatch < Date.parse(snapshot.freshnessUntil)
        && snapshot.capabilities.some(capability => capability.id === request.capabilityId && capability.schemaVersion === request.capabilitySchemaVersion);
      checks.push({ id: "capability_binding", status: matched ? "pass" : "fail", evidenceRef: snapshot.snapshotId });
    }
    const receipt = attempt.receipt?.status;
    checks.push({
      id: "adapter_receipt",
      status: receipt === "completed" ? "pass" : receipt === "rejected" ? "fail" : "skip",
      evidenceRef: attemptSpanId,
    });
    const reconciled = store.listReconciliations(taskId).filter(entry => entry.attemptId === attemptId && entry.status === "verified").at(-1);
    const verification = reconciled?.verification ?? (attempt.status === "completed" ? attempt.verification : undefined);
    const evidenceRef = verification?.observationIds.find(id => {
      const observation = store.getObservation(taskId, id);
      return observation?.subjectId === deviceId && isCurrentDeviceObservation(observation, verification.checkedAt);
    });
    if (!evidenceRef || !verification || verification.status === "not_evaluable") {
      checks.push({ id: "device_readback", status: "skip" });
    } else {
      checks.push({ id: "device_readback", status: verification.status === "verified" ? "pass" : "fail", evidenceRef });
    }
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
