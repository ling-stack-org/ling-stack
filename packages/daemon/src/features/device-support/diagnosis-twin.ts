import type { DeviceCapabilitySnapshotV1, DeviceTwinReportedValueV1, JsonValue } from "@ling-stack/contracts";
import type { DevicePlaybookRunResultV1, SqliteDeviceSupportStore } from "@ling-stack/core";

export function diagnosisReportedValues(
  result: DevicePlaybookRunResultV1,
  snapshot: DeviceCapabilitySnapshotV1 | undefined,
  store: Pick<SqliteDeviceSupportStore, "getDevice" | "getObservation">,
): readonly DeviceTwinReportedValueV1[] {
  if ((result.status !== "succeeded" && result.status !== "partial") || !snapshot) return [];
  const profile = store.getDevice(snapshot.deviceId);
  if (!profile || profile.device.lifecycleStatus !== "healthy") return [];
  const taskId = result.report.taskId;
  const facts = new Map(result.report.facts.map(fact => [fact.observationId, fact]));
  const values: DeviceTwinReportedValueV1[] = [];
  for (const { attempt, request } of result.attempts) {
    if (attempt.status !== "completed" || attempt.receipt?.status !== "completed"
      || request.capabilitySnapshotId !== snapshot.snapshotId || attempt.targetDeviceId !== snapshot.deviceId
      || attempt.connectionRevision !== snapshot.connectionRevision
      || attempt.adapterBinding?.profileRevision !== profile.profileRevision) continue;
    for (const id of attempt.receipt.observationIds) {
      const fact = facts.get(id);
      if (!fact) continue;
      const observation = store.getObservation(taskId, id);
      if (!observation) continue;
      let key = fact.source;
      let quality = observation.quality;
      if (fact.source === "home_assistant" || fact.source === "home_assistant.integration") {
        const args = request.normalizedInput as Record<string, JsonValue> | null;
        const identifier = fact.source === "home_assistant" ? args?.entityId : args?.entryId;
        if (typeof identifier !== "string") continue;
        key = fact.source === "home_assistant" ? identifier : `home_assistant.integration:${identifier}`;
        if (fact.source === "home_assistant") {
          const reported = fact.value as Record<string, JsonValue>;
          quality = reported.reportFreshness === "stale" ? "stale"
            : reported.availability === "available" ? "good" : "degraded";
        }
      }
      values.push({
        key, reported: fact.value, source: fact.source, quality,
        observedAt: fact.observedAt, freshnessUntil: fact.freshnessUntil,
        reportedEvidence: {
          taskId, attemptId: attempt.attemptId, observationId: fact.observationId,
          profileRevision: attempt.adapterBinding.profileRevision, connectionRevision: snapshot.connectionRevision,
        },
      });
    }
  }
  return values;
}
