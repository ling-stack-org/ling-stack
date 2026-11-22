import type {
  DeviceDiagnosisActionV1,
  DeviceDiagnosisFactV1,
  DeviceDiagnosisHypothesisV1,
  DeviceDiagnosisReportV1,
  DeviceDiagnosisUncertaintyV1,
  DeviceDiagnosisVerificationV1,
  DeviceObservationV1,
  JsonValue,
} from "@ling-stack/contracts";

import type { DeviceSupportStoreAttemptRecord } from "./device-support.js";

export function buildDeviceDiagnosisReport(input: {
  readonly taskId: string;
  readonly playbookId: string;
  readonly playbookVersion: string;
  readonly attempts: readonly DeviceSupportStoreAttemptRecord[];
  readonly observations: readonly DeviceObservationV1[];
  readonly failedStepId?: string;
  readonly generatedAt: string;
}): DeviceDiagnosisReportV1 {
  const facts: DeviceDiagnosisFactV1[] = [];
  const hypotheses: DeviceDiagnosisHypothesisV1[] = [];
  const actions: DeviceDiagnosisActionV1[] = [];
  const verifications: DeviceDiagnosisVerificationV1[] = [];
  const remainingUncertainty: DeviceDiagnosisUncertaintyV1[] = [];
  const untrustedTextRefs = new Set<string>();
  const observations = new Map(input.observations.map(observation => [observation.id, observation]));
  const seen = new Set<string>();

  for (const { attempt, request } of input.attempts) {
    const { receipt, verification } = attempt;
    actions.push({
      attemptId: attempt.attemptId,
      actionId: attempt.actionId,
      targetDeviceId: attempt.targetDeviceId,
      capabilityId: request.capabilityId,
      status: attempt.status,
      ...(receipt ? { receiptStatus: receipt.status } : {}),
      ...(receipt?.errorCode ? { errorCode: receipt.errorCode } : {}),
    });
    if (attempt.status === "unknown") remainingUncertainty.push({ code: "unknown_action_outcome", ref: attempt.attemptId });
    if (verification) {
      verifications.push({
        actionId: verification.actionId,
        status: verification.status,
        observationIds: verification.observationIds,
        checkedAt: verification.checkedAt,
      });
    }
    if (request.expectedVerification !== undefined && (!verification || verification.status === "not_evaluable")) {
      remainingUncertainty.push({ code: "missing_verification", ref: attempt.actionId });
    }

    for (const id of new Set([...(receipt?.observationIds ?? []), ...(verification?.observationIds ?? [])])) {
      if (seen.has(id)) continue;
      seen.add(id);
      const observation = observations.get(id);
      if (!observation) {
        remainingUncertainty.push({ code: "missing_observation", ref: id });
        continue;
      }
      untrustedTextRefs.add(id);
      if (!isCurrentDeviceObservation(observation, input.generatedAt)) {
        remainingUncertainty.push({ code: "unusable_observation", ref: id });
        continue;
      }
      const evidence = projectDeviceDiagnosticEvidence(request, observation);
      if (!evidence) {
        remainingUncertainty.push({ code: "unusable_observation", ref: id });
        continue;
      }
      facts.push({
        observationId: id,
        source: observation.source,
        observedAt: observation.observedAt,
        freshnessUntil: observation.freshnessUntil,
        value: evidence.value,
      });
      hypotheses.push(...evidence.hypotheses.map(code => ({ code, observationId: id })));
    }
  }
  if (input.failedStepId) remainingUncertainty.push({ code: "step_failed", ref: input.failedStepId });
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    playbookId: input.playbookId,
    playbookVersion: input.playbookVersion,
    generatedAt: input.generatedAt,
    facts,
    hypotheses,
    actions,
    verifications,
    remainingUncertainty,
    untrustedTextRefs: [...untrustedTextRefs],
  };
}

export function isCurrentDeviceObservation(observation: DeviceObservationV1, now: string): boolean {
  return (observation.quality === "good" || observation.quality === "degraded")
    && observation.redactionClass === "public"
    && Date.parse(observation.observedAt) <= Date.parse(now)
    && Date.parse(observation.freshnessUntil) > Date.parse(now)
    && observation.provenance.includes(observation.subjectId);
}

export function projectDeviceDiagnosticEvidence(
  request: DeviceSupportStoreAttemptRecord["request"],
  observation: DeviceObservationV1,
): { readonly value: JsonValue; readonly hypotheses: readonly DeviceDiagnosisHypothesisV1["code"][] } | undefined {
  const value = observation.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, JsonValue>;
  if (request.capabilityId === "home_assistant.read_entity" && observation.source === "home_assistant") {
    const input = request.normalizedInput as Record<string, JsonValue> | null;
    const availability = fields.availability;
    if (observation.subjectId !== input?.entityId || fields.entityId !== observation.subjectId
      || (availability !== "available" && availability !== "unavailable" && availability !== "absent")) return undefined;
    return { value: { availability }, hypotheses: availability === "unavailable" ? ["integration_or_device_issue"] : [] };
  }
  if (observation.subjectId !== request.targetDeviceId) return undefined;
  const pcNetwork = request.capabilityId === "pc.inspect.network" && observation.source === "pc.network";
  const linuxNetwork = request.capabilityId === "linux.inspect.network" && observation.source === "linux.network";
  const linuxWifi = request.capabilityId === "linux.inspect.wifi" && observation.source === "linux.wifi";
  if ((pcNetwork || linuxNetwork || linuxWifi) && typeof fields.connected === "boolean") {
    const gatewayReachable = typeof fields.gatewayReachable === "boolean" ? fields.gatewayReachable : undefined;
    const dnsReachable = typeof fields.dnsReachable === "boolean" ? fields.dnsReachable : undefined;
    const routeAvailable = !pcNetwork && typeof fields.routeAvailable === "boolean" ? fields.routeAvailable : undefined;
    const dnsNameResolved = !pcNetwork && typeof fields.dnsNameResolved === "boolean" ? fields.dnsNameResolved : undefined;
    const wifiAssociated = linuxWifi && typeof fields.wifiAssociated === "boolean" ? fields.wifiAssociated : undefined;
    const linkError = linuxWifi && (fields.linkError === "wireless_tools_unavailable"
      || fields.linkError === "wireless_interface_not_found" || fields.linkError === "wifi_observation_failed")
      ? fields.linkError : undefined;
    const hypotheses: DeviceDiagnosisHypothesisV1["code"][] = [];
    if (!fields.connected || wifiAssociated === false) hypotheses.push("link_or_address_issue");
    if (routeAvailable === false) hypotheses.push("route_issue");
    if (gatewayReachable === false) hypotheses.push("gateway_issue");
    if (dnsReachable === false || dnsNameResolved === false) hypotheses.push("dns_issue");
    return {
      value: {
        connected: fields.connected,
        ...(gatewayReachable === undefined ? {} : { gatewayReachable }),
        ...(dnsReachable === undefined ? {} : { dnsReachable }),
        ...(routeAvailable === undefined ? {} : { routeAvailable }),
        ...(dnsNameResolved === undefined ? {} : { dnsNameResolved }),
        ...(wifiAssociated === undefined ? {} : { wifiAssociated }),
        ...(linkError === undefined ? {} : { linkError }),
      },
      hypotheses,
    };
  }
  if (request.capabilityId === "pc.inspect.services" && observation.source === "pc.services" && Array.isArray(fields.services)) {
    const counts = { running: 0, stopped: 0, failed: 0, unknown: 0 };
    for (const entry of fields.services) {
      const state = entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, JsonValue>).state
        : undefined;
      if (state === "running" || state === "stopped" || state === "failed") counts[state] += 1;
      else counts.unknown += 1;
    }
    return { value: counts, hypotheses: counts.failed ? ["service_issue"] : [] };
  }
  if (request.capabilityId === "pc.inspect.processes" && observation.source === "pc.processes" && Array.isArray(fields.processes)) {
    return { value: { count: fields.processes.length }, hypotheses: [] };
  }
  return undefined;
}
