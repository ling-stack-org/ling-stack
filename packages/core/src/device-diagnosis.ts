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
    const reportFreshness = fields.reportFreshness === "fresh" || fields.reportFreshness === "stale" || fields.reportFreshness === "unknown"
      ? fields.reportFreshness : undefined;
    const reportTimestampStatus = fields.reportTimestampStatus === "valid" || fields.reportTimestampStatus === "missing"
      || fields.reportTimestampStatus === "invalid" || fields.reportTimestampStatus === "future" ? fields.reportTimestampStatus : undefined;
    const hypotheses: DeviceDiagnosisHypothesisV1["code"][] = availability === "unavailable" ? ["integration_or_device_issue"] : [];
    if (reportFreshness === "stale") hypotheses.push("stale_entity_report");
    const automation = observation.subjectId.startsWith("automation.");
    return { value: {
      availability,
      ...(automation && typeof fields.automationEnabled === "boolean" ? { automationEnabled: fields.automationEnabled } : {}),
      ...(automation && typeof fields.lastTriggeredAt === "string" ? { lastTriggeredAt: fields.lastTriggeredAt } : {}),
      ...(typeof fields.lastReportedAt === "string" ? { lastReportedAt: fields.lastReportedAt } : {}),
      ...(typeof fields.lastUpdatedAt === "string" ? { lastUpdatedAt: fields.lastUpdatedAt } : {}),
      ...(typeof fields.lastChangedAt === "string" ? { lastChangedAt: fields.lastChangedAt } : {}),
      ...(reportTimestampStatus === undefined || reportTimestampStatus === "missing" ? {} : { reportTimestampStatus }),
      ...(reportFreshness === undefined || reportFreshness === "unknown" ? {} : { reportFreshness }),
    }, hypotheses };
  }
  if (observation.subjectId !== request.targetDeviceId) return undefined;
  if (request.capabilityId === "home_assistant.read_config_entry" && observation.source === "home_assistant.integration") {
    const input = request.normalizedInput as Record<string, JsonValue> | null;
    const { entryId, entityId, domain, state, integrationDisabled, entityDisabled } = fields;
    if (typeof entryId !== "string" || entryId !== input?.entryId || typeof entityId !== "string" || entityId !== input?.entityId
      || typeof domain !== "string" || typeof state !== "string" || typeof integrationDisabled !== "boolean" || typeof entityDisabled !== "boolean") {
      return undefined;
    }
    return {
      value: { entryId, entityId, domain, state, integrationDisabled, entityDisabled },
      hypotheses: state === "loaded" && !integrationDisabled && !entityDisabled ? [] : ["integration_or_device_issue"],
    };
  }
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
  if (request.capabilityId === "pc.inspect.logs" && observation.source === "pc.logs" && Array.isArray(fields.entries)) {
    const counts = { count: fields.entries.length, error: 0, warning: 0, unknown: 0 };
    for (const entry of fields.entries) {
      const level = entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, JsonValue>).level
        : undefined;
      counts[level === "error" || level === "warning" ? level : "unknown"] += 1;
    }
    return { value: counts, hypotheses: [] };
  }
  if (request.capabilityId === "pc.inspect.software" && observation.source === "pc.software"
    && Array.isArray(fields.software) && typeof fields.truncated === "boolean") {
    const sources = { dpkg: 0, rpm: 0, system_profiler: 0, registry: 0, unknown: 0 };
    for (const entry of fields.software) {
      const source = entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, JsonValue>).source
        : undefined;
      if (source === "dpkg" || source === "rpm" || source === "system_profiler" || source === "registry") sources[source] += 1;
      else sources.unknown += 1;
    }
    return { value: { count: fields.software.length, sources, truncated: fields.truncated }, hypotheses: [] };
  }
  if (request.capabilityId === "android.inspect.device" && observation.source === "android.device") {
    const version = fields.androidVersion;
    return { value: typeof version === "string" && /^\d{1,3}(?:\.\d{1,3}){0,3}$/u.test(version)
      ? { androidVersion: version } : { androidVersion: null }, hypotheses: [] };
  }
  if (request.capabilityId === "android.inspect.packages" && observation.source === "android.packages"
    && Array.isArray(fields.packages) && fields.packages.length <= 2_048) {
    return { value: { packageCount: fields.packages.length }, hypotheses: [] };
  }
  if (request.capabilityId === "protocol.read_registers" && observation.source === "modbus.rtu.read_registers") {
    const { status, unitAddress, table, startAddress, registers } = fields;
    if (status === "incomplete_capture" || status === "invalid_checksum" || status === "mismatched_response" || status === "device_exception") {
      return { value: { status }, hypotheses: [] };
    }
    if (status === "read" && deviceRegisterInteger(unitAddress, 1, 247) && (table === "holding" || table === "input")
      && deviceRegisterInteger(startAddress, 0, 65_535) && Array.isArray(registers)
      && registers.length >= 1 && registers.length <= 125 && startAddress + registers.length <= 65_536
      && registers.every(value => deviceRegisterInteger(value, 0, 65_535))) {
      return { value: { status, unitAddress, table, startAddress, registers }, hypotheses: [] };
    }
  }
  return undefined;
}

function deviceRegisterInteger(value: JsonValue | undefined, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}
