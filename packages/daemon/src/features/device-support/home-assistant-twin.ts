import type { DeviceCapabilitySnapshotV1, DeviceTwinReportedValueV1 } from "@ling-stack/contracts";
import type { DevicePlaybookRunResultV1 } from "@ling-stack/core";

export function homeAssistantReportedValue(
  result: DevicePlaybookRunResultV1,
  snapshot: DeviceCapabilitySnapshotV1 | undefined,
): DeviceTwinReportedValueV1 | undefined {
  if (result.status !== "succeeded" || !snapshot) return undefined;
  const reading = result.attempts.find(({ attempt, request }) => attempt.status === "completed"
    && request.capabilityId === "home_assistant.read_entity"
    && request.capabilitySnapshotId === snapshot.snapshotId && attempt.connectionRevision === snapshot.connectionRevision
    && attempt.targetDeviceId === snapshot.deviceId);
  const attempt = reading?.attempt;
  if (!reading || !attempt?.adapterBinding) return undefined;
  const args = reading.request.normalizedInput;
  const entityId = args && typeof args === "object" && "entityId" in args ? args.entityId : undefined;
  const fact = result.report.facts.find(item => item.source === "home_assistant" && attempt.receipt?.observationIds.includes(item.observationId));
  const reported = fact?.value;
  if (typeof entityId !== "string" || !fact || !reported || typeof reported !== "object" || !("availability" in reported)) return undefined;
  const quality = "reportFreshness" in reported && reported.reportFreshness === "stale" ? "stale"
    : reported.availability === "available" ? "good" : "degraded";
  return {
    key: entityId, reported, source: fact.source, quality, observedAt: fact.observedAt, freshnessUntil: fact.freshnessUntil,
    reportedEvidence: {
      taskId: result.report.taskId, attemptId: attempt.attemptId, observationId: fact.observationId,
      profileRevision: attempt.adapterBinding.profileRevision, connectionRevision: snapshot.connectionRevision,
    },
  };
}
