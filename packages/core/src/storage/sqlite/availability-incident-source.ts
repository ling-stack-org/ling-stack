import { channelTeamIncidentSeverities, type AvailabilityIncident, type CreateAvailabilityIncidentInput } from "../../channel-team-types.js";
import { providerApis, providerKinds } from "../../provider-types.js";
import type { ProviderRuntimeAvailabilityIncidentSource } from "../../provider-runtime-availability-types.js";

const SOURCE_KEYS = ["observationId", "invocationId", "taskId", "runId", "attemptId", "origin", "admittedAt", "settledAt", "identity"];
const IDENTITY_KEYS = ["providerPresetId", "providerKind", "providerApi", "modelId", "configRevision"];
const ORIGINS = new Set(["task", "reviewer", "reply", "route", "intent"]);
const PROVIDER_KINDS: ReadonlySet<string> = new Set(providerKinds);
const PROVIDER_APIS: ReadonlySet<string> = new Set(providerApis);
const SEVERITIES: ReadonlySet<string> = new Set(channelTeamIncidentSeverities);
const STATES = new Set(["healthy", "slow", "rate_limited", "overloaded", "offline", "unknown"]);
const KINDS = new Set(["quota", "timeout", "overload", "network", "unknown"]);
const RUNTIME_KEYS = new Set(["source", "provenance", "observationId", "invocationId", "configRevision", "keyedProof"]);

export function invalidAvailabilityIncidentSource(): Error & { readonly code: string } {
  return Object.assign(new Error("Invalid availability incident runtime source."), { code: "availability_incident_source_invalid" });
}

/** Reject misplaced runtime metadata before a generic writer can erase its provenance. */
export function assertGenericAvailabilityIncidentInput(input: CreateAvailabilityIncidentInput): void {
  if (input === null || typeof input !== "object" || Reflect.ownKeys(input).some(key => typeof key === "string" && RUNTIME_KEYS.has(key))) {
    throw invalidAvailabilityIncidentSource();
  }
}

/** Explicitly clone whitelisted data properties; never invoke source accessors or serialize arbitrary objects. */
export function readAvailabilityIncidentRuntimeSource(
  value: unknown,
  incident: Pick<AvailabilityIncident, "providerPresetId" | "observedAt" | "modelSignature">,
): ProviderRuntimeAvailabilityIncidentSource {
  const source = dataRecord(value, SOURCE_KEYS);
  const identity = dataRecord(source.identity, IDENTITY_KEYS);
  for (const key of ["observationId", "invocationId", "taskId"]) requiredString(source[key]);
  for (const key of ["providerPresetId", "modelId"]) requiredString(identity[key]);
  if (typeof source.origin !== "string" || !ORIGINS.has(source.origin)
    || typeof identity.providerKind !== "string" || !PROVIDER_KINDS.has(identity.providerKind)
    || typeof identity.providerApi !== "string" || !PROVIDER_APIS.has(identity.providerApi) || !Number.isSafeInteger(identity.configRevision)
    || (identity.configRevision as number) < 1) throw invalidAvailabilityIncidentSource();
  const admittedAt = canonicalTime(source.admittedAt);
  const settledAt = canonicalTime(source.settledAt);
  if (admittedAt > settledAt || settledAt !== incident.observedAt
    || identity.providerPresetId !== incident.providerPresetId) throw invalidAvailabilityIncidentSource();
  if (incident.modelSignature && (incident.modelSignature.model !== identity.modelId
    || (incident.modelSignature.api !== undefined && incident.modelSignature.api !== identity.providerApi)
    || (incident.modelSignature.providerPresetId !== undefined && incident.modelSignature.providerPresetId !== identity.providerPresetId))) {
    throw invalidAvailabilityIncidentSource();
  }
  if ((source.runId === undefined) !== (source.attemptId === undefined)) throw invalidAvailabilityIncidentSource();
  if (source.runId !== undefined) {
    requiredString(source.runId);
    requiredString(source.attemptId);
  }
  return Object.freeze({
    observationId: source.observationId as string,
    invocationId: source.invocationId as string,
    taskId: source.taskId as string,
    ...(source.runId === undefined ? {} : { runId: source.runId as string, attemptId: source.attemptId as string }),
    origin: source.origin as ProviderRuntimeAvailabilityIncidentSource["origin"],
    admittedAt, settledAt,
    identity: Object.freeze({
      providerPresetId: identity.providerPresetId as string,
      providerKind: identity.providerKind as ProviderRuntimeAvailabilityIncidentSource["identity"]["providerKind"],
      providerApi: identity.providerApi as ProviderRuntimeAvailabilityIncidentSource["identity"]["providerApi"],
      modelId: identity.modelId as string,
      configRevision: identity.configRevision as number,
    }),
  });
}

export function readRuntimePublicationInput(value: unknown): { readonly incident: CreateAvailabilityIncidentInput; readonly source: unknown } {
  const input = dataRecord(value, ["incident", "source"]);
  const incident = dataRecord(input.incident, ["id", "agentId", "providerPresetId", "modelSignature", "state", "kind", "severity", "summary", "observedAt", "expiresAt"]);
  for (const key of ["id", "agentId", "providerPresetId"]) if (incident[key] !== undefined) requiredString(incident[key]);
  if (typeof incident.summary !== "string" || incident.summary.trim().length === 0
    || typeof incident.state !== "string" || !STATES.has(incident.state)
    || typeof incident.kind !== "string" || !KINDS.has(incident.kind)
    || (incident.severity !== undefined && (typeof incident.severity !== "string" || !SEVERITIES.has(incident.severity)))) {
    throw invalidAvailabilityIncidentSource();
  }
  if (incident.observedAt !== undefined) canonicalTime(incident.observedAt);
  if (incident.expiresAt !== undefined && incident.expiresAt !== null) canonicalTime(incident.expiresAt);
  if (incident.modelSignature !== undefined) {
    const signature = dataRecord(incident.modelSignature, ["providerPresetId", "providerId", "model", "api", "promptHash", "capabilityHash"]);
    requiredString(signature.model);
    for (const key of ["providerPresetId", "providerId", "api", "promptHash", "capabilityHash"]) {
      if (signature[key] !== undefined) requiredString(signature[key]);
    }
    incident.modelSignature = Object.freeze({ ...signature });
  }
  return { incident: Object.freeze(incident) as unknown as CreateAvailabilityIncidentInput, source: input.source };
}

function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw invalidAvailabilityIncidentSource();
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) throw invalidAvailabilityIncidentSource();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw invalidAvailabilityIncidentSource();
    result[key] = descriptor.value;
  }
  return result;
}

function requiredString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) throw invalidAvailabilityIncidentSource();
}

function canonicalTime(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invalidAvailabilityIncidentSource();
  }
  return value;
}
