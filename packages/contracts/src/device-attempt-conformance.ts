import type { DeviceActionRequestV1, DeviceTaskAttemptV1, DeviceVerificationResultV1 } from "./device.js";
import type { DeviceConformanceReportV1, DeviceTaskTraceCapabilitySnapshotV1 } from "./device-fabric.js";

export function projectDeviceAttemptChecks(input: {
  readonly attempt: DeviceTaskAttemptV1;
  readonly request: Pick<DeviceActionRequestV1, "capabilityId" | "capabilitySchemaVersion">;
  readonly attemptSpanId: string;
  readonly snapshot?: Extract<DeviceTaskTraceCapabilitySnapshotV1, { state: "recorded" }>;
  readonly readback?: { readonly status: DeviceVerificationResultV1["status"]; readonly evidenceRef: string };
}): DeviceConformanceReportV1["checks"] {
  const { attempt, request, attemptSpanId, snapshot, readback } = input;
  const adapter = attempt.adapterBinding;
  const checkedAt = Date.parse(attempt.dispatchIntentAt);
  const binding = snapshot && adapter && attempt.connectionRevision
    ? {
        status: snapshot.deviceId === attempt.targetDeviceId && snapshot.connectionRevision === attempt.connectionRevision
          && snapshot.adapterId === adapter.adapterId && snapshot.adapterVersion === adapter.adapterVersion
          && snapshot.profileRevision === adapter.profileRevision
          && Date.parse(snapshot.observedAt) <= checkedAt && checkedAt < Date.parse(snapshot.freshnessUntil)
          && snapshot.capabilities.some(capability => capability.id === request.capabilityId && capability.schemaVersion === request.capabilitySchemaVersion)
          ? "pass" as const : "fail" as const,
        evidenceRef: snapshot.snapshotId,
      }
    : { status: "skip" as const };
  const receipt = attempt.receipt?.status;
  return [
    { id: "capability_binding", ...binding },
    { id: "adapter_receipt", status: receipt === "completed" ? "pass" : receipt === "rejected" ? "fail" : "skip", evidenceRef: attemptSpanId },
    readback && readback.status !== "not_evaluable"
      ? { id: "device_readback", status: readback.status === "verified" ? "pass" : "fail", evidenceRef: readback.evidenceRef }
      : { id: "device_readback", status: "skip" },
  ];
}
