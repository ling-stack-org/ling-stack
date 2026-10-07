import { HOST_OFFICE_LOCAL_PROTOCOL, type HostOfficeLocalExecutionRecord,
  type HostOfficeLocalEffectRecord, type HostOfficeLocalEffectObservation } from "../../host-office-local-types.js";
import { hostOperationFailure, hostOperationTimestamp } from "./host-operation-journal-evidence.js";
import { isHostOfficeFileIdentity } from "./host-office-local-identity.js";

const invalid = (): never => hostOperationFailure("host_office_local_evidence_invalid");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const resourceKinds = new Set(["open", "write", "fsync", "close"]);
const sourceKeys = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const;

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Pure validation of immutable native/Host facts; this never grants settlement authority. */
export function validateOfficeLocalObservationPayload(execution: HostOfficeLocalExecutionRecord,
  effect: HostOfficeLocalEffectRecord, value: unknown, sealedAt: string): HostOfficeLocalEffectObservation {
  if (!object(value) || !exact(value, ["schemaVersion", "protocol", "kind", "executionId", "executionIdentityDigest",
    "source", "effectId", "effectDigest", "native", "host", "completedAt", ...(Object.hasOwn(value, "openResource") ? ["openResource"] : [])])
    || value.schemaVersion !== 1 || value.protocol !== HOST_OFFICE_LOCAL_PROTOCOL || value.kind !== "office_local_effect_v1"
    || value.executionId !== execution.executionId || value.executionIdentityDigest !== execution.identityDigest
    || value.effectId !== effect.effectId || value.effectDigest !== effect.effectDigest || !object(value.source)
    || !object(value.native) || !object(value.host)) return invalid();
  const source = value.source;
  if (!exact(source, sourceKeys) || !sourceKeys.every(key => text(source[key]) && source[key] === execution.source[key])) return invalid();

  const completedAt = hostOperationTimestamp(value.completedAt);
  if (completedAt < hostOperationTimestamp(effect.enteredAt ?? effect.preparedAt)
    || completedAt > hostOperationTimestamp(sealedAt)) return invalid();

  const native = value.native, host = value.host;
  const hasOpenResource = Object.hasOwn(value, "openResource");
  if (hasOpenResource && (effect.kind !== "open" || native.state !== "returned")) return invalid();
  if (host.state === "returned") {
    if (!exact(host, ["state"]) || native.state !== "returned") return invalid();
  } else if (host.state !== "unconfirmed" || !exact(host, ["state", "errorCode"]) || !text(host.errorCode)) return invalid();

  // The Core callback may already own the original scopes when its ledger guard
  // refuses to invoke the native API. That is not a known-no-start settlement.
  if (native.state === "not_entered") {
    if (!exact(native, ["state"]) || host.state !== "unconfirmed") return invalid();
    return value as unknown as HostOfficeLocalEffectObservation;
  }
  if (effect.enteredAt === undefined) return invalid();
  const enteredAt = hostOperationTimestamp(effect.enteredAt);
  if (native.state === "threw") {
    if (!exact(native, ["state", "calledAt", "completedAt", "errorCode"]) || !text(native.errorCode)) return invalid();
    const calledAt = hostOperationTimestamp(native.calledAt), finishedAt = hostOperationTimestamp(native.completedAt);
    if (calledAt < enteredAt || finishedAt < calledAt || finishedAt > completedAt) return invalid();
  } else if (native.state === "returned") {
    if (!exact(native, ["state", "calledAt", "returnedAt", "result"]) || !object(native.result)) return invalid();
    const calledAt = hostOperationTimestamp(native.calledAt), returnedAt = hostOperationTimestamp(native.returnedAt);
    if (calledAt < enteredAt || returnedAt < calledAt || returnedAt > completedAt) return invalid();
    const result = native.result;
    if (result.kind !== effect.kind) return invalid();
    if (resourceKinds.has(effect.kind)) {
      const keys = effect.kind === "write" ? ["kind", "resourceLifetimeId", "bytesWritten"] : ["kind", "resourceLifetimeId"];
      if (!exact(result, keys) || !text(result.resourceLifetimeId) || result.resourceLifetimeId !== effect.resourceLifetimeId) return invalid();
      if (effect.kind === "write" && (!Number.isSafeInteger(result.bytesWritten) || Number(result.bytesWritten) < 0
        || effect.sizeBytes === undefined || Number(result.bytesWritten) > effect.sizeBytes)) return invalid();
    } else if (!exact(result, ["kind"])) return invalid();
    if (hasOpenResource) {
      const resource = value.openResource;
      if (!object(resource) || !exact(resource, ["resourceLifetimeId", "identity", "observedAt"])
        || !text(resource.resourceLifetimeId) || resource.resourceLifetimeId !== effect.resourceLifetimeId
        || !isHostOfficeFileIdentity(resource.identity)) return invalid();
      const observedAt = hostOperationTimestamp(resource.observedAt);
      if (observedAt < returnedAt || observedAt > completedAt) return invalid();
    }
  } else return invalid();
  return value as unknown as HostOfficeLocalEffectObservation;
}
