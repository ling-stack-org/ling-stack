import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { HOST_OFFICE_LOCAL_PROTOCOL, type HostOfficeLocalExecutionRecord } from "../../host-office-local-types.js";
import type { HostOfficeLocalTerminalManifest, HostOfficeLocalTerminalReadResource } from "../../host-office-local-terminal-types.js";
import { isHostOfficeFileIdentity } from "./host-office-local-identity.js";
import { hostOperationTimestamp } from "./host-operation-journal-evidence.js";
import { officeLocalFailure } from "./host-office-local-records.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const size = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const sourceKeys = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const;
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function boundedTime(value: unknown, from: number, to: number): number {
  const at = hostOperationTimestamp(value);
  if (at < from || at > to) return officeLocalFailure();
  return at;
}
function finalSnapshot(value: unknown, directory: boolean): boolean {
  if (!object(value)) return false;
  if (value.state === "absent") return exact(value, ["state"]);
  if (value.state === "unobserved") return exact(value, ["state", "errorCode"]) && text(value.errorCode);
  if (value.state === "directory") return directory && exact(value, ["state", "identity"]) && isHostOfficeFileIdentity(value.identity);
  return !directory && value.state === "file" && exact(value, ["state", "identity", "bytesSha256", "sizeBytes"])
    && isHostOfficeFileIdentity(value.identity) && digest(value.bytesSha256) && size(value.sizeBytes)
    && value.sizeBytes <= 50 * 1024 * 1024 && value.identity.sizeBytes === value.sizeBytes;
}

/** Strict, pure terminal fact validation. Failed/unknown facts remain expressible, but never grant safe authority. */
export function validateOfficeLocalTerminalPayload(execution: HostOfficeLocalExecutionRecord,
  value: unknown, sealedAt: string): HostOfficeLocalTerminalManifest {
  if (!object(value) || !exact(value, ["schemaVersion", "protocol", "kind", "executionId", "executionIdentityDigest",
    "source", "preparedArtifactId", "preparedDigest", "outcome", "publicationEntered", "effects", "members", "resources", "workspace", "completedAt"])
    || value.schemaVersion !== 1 || value.protocol !== HOST_OFFICE_LOCAL_PROTOCOL || value.kind !== "office_local_terminal_v1"
    || value.executionId !== execution.executionId || value.executionIdentityDigest !== execution.identityDigest
    || value.preparedArtifactId !== execution.preparedArtifactId || value.preparedDigest !== execution.preparedDigest
    || !object(value.source) || !exact(value.source, sourceKeys)
    || !sourceKeys.every(key => text((value.source as Record<string, unknown>)[key])
      && (value.source as Record<string, unknown>)[key] === execution.source[key])
    || !text(value.outcome) || !["published", "failed"].includes(value.outcome) || typeof value.publicationEntered !== "boolean"
    || (value.outcome === "published" && !value.publicationEntered)
    || !Array.isArray(value.effects) || value.effects.length > 1024
    || !Array.isArray(value.members) || value.members.length !== execution.members.length
    || !Array.isArray(value.resources) || value.resources.length > 1024 * 129 + 128) return officeLocalFailure();
  const preparedAt = hostOperationTimestamp(execution.preparedAt);
  const completedAt = boundedTime(value.completedAt, preparedAt, hostOperationTimestamp(sealedAt));
  const effectIds = new Set<string>();
  for (const [index, effect] of value.effects.entries()) {
    if (!object(effect) || !exact(effect, ["ordinal", "effectId", "effectDigest", "enteredAt", "observation"])
      || effect.ordinal !== index || !text(effect.effectId) || effectIds.has(effect.effectId) || !digest(effect.effectDigest)) return officeLocalFailure();
    effectIds.add(effect.effectId);
    if (effect.enteredAt !== null) boundedTime(effect.enteredAt, preparedAt, completedAt);
    if (effect.observation !== null && (!object(effect.observation) || !exact(effect.observation, ["artifactId", "digest"])
      || !text(effect.observation.artifactId) || !digest(effect.observation.digest))) return officeLocalFailure();
  }
  if (!object(value.workspace) || !exact(value.workspace, ["final", "observedAt"]) || !object(value.workspace.final)
    || (value.workspace.final.state === "directory"
      ? !exact(value.workspace.final, ["state", "identity"]) || !isHostOfficeFileIdentity(value.workspace.final.identity)
      : value.workspace.final.state !== "unobserved" || !exact(value.workspace.final, ["state", "errorCode"]) || !text(value.workspace.final.errorCode))) return officeLocalFailure();
  boundedTime(value.workspace.observedAt, preparedAt, completedAt);

  const lifetimes = new Set<string>(), readIds = new Set<string>(), openIds = new Set<string>(), closeIds = new Set<string>();
  const reads = new Map<string, HostOfficeLocalTerminalReadResource>();
  for (const resource of value.resources) {
    if (!object(resource) || !text(resource.resourceLifetimeId) || lifetimes.has(resource.resourceLifetimeId)
      || !text(resource.memberId) || !text(resource.state) || !["retained", "unknown", "closed"].includes(resource.state)) return officeLocalFailure();
    const member = execution.members.find(item => item.memberId === resource.memberId);
    if (!member || member.role === "directory") return officeLocalFailure();
    lifetimes.add(resource.resourceLifetimeId);
    const hasIdentity = Object.hasOwn(resource, "identity"), hasIdentityAt = Object.hasOwn(resource, "identityObservedAt");
    if (hasIdentity !== hasIdentityAt || (hasIdentity && !isHostOfficeFileIdentity(resource.identity))) return officeLocalFailure();
    const identityKeys = hasIdentity ? ["identity", "identityObservedAt"] : [];
    const keys = ["origin", "memberId", "resourceLifetimeId", "state", ...identityKeys];
    if (resource.origin === "effect") {
      if (!["temporary", "recovery"].includes(member.role) || !text(resource.openEffectId)
        || !effectIds.has(resource.openEffectId) || openIds.has(resource.openEffectId)
        || !exact(resource, [...keys, "openEffectId", ...(resource.state === "retained" ? [] : ["closeEffectId"])])) return officeLocalFailure();
      openIds.add(resource.openEffectId);
      if (resource.state !== "retained") {
        if (!text(resource.closeEffectId) || !effectIds.has(resource.closeEffectId) || closeIds.has(resource.closeEffectId)
          || resource.closeEffectId === resource.openEffectId) return officeLocalFailure();
        closeIds.add(resource.closeEffectId);
      }
      if (hasIdentityAt) boundedTime(resource.identityObservedAt, preparedAt, completedAt);
    } else if (resource.origin === "member_read") {
      const closeKeys = resource.state === "retained" ? [] : resource.state === "unknown"
        ? ["closeEnteredAt"] : ["closeEnteredAt", "closeReturnedAt"];
      if (!exact(resource, [...keys, "readId", "purpose", "openCalledAt", "openReturnedAt", ...closeKeys])
        || !text(resource.readId) || readIds.has(resource.readId) || !text(resource.purpose) || !["refresh", "final"].includes(resource.purpose)) return officeLocalFailure();
      readIds.add(resource.readId);
      const calledAt = boundedTime(resource.openCalledAt, preparedAt, completedAt);
      const returnedAt = boundedTime(resource.openReturnedAt, calledAt, completedAt);
      const identityAt = hasIdentityAt ? boundedTime(resource.identityObservedAt, returnedAt, completedAt) : returnedAt;
      if (resource.state !== "retained") {
        const closeEnteredAt = boundedTime(resource.closeEnteredAt, identityAt, completedAt);
        if (resource.state === "closed") boundedTime(resource.closeReturnedAt, closeEnteredAt, completedAt);
      }
      reads.set(resource.resourceLifetimeId, resource as unknown as HostOfficeLocalTerminalReadResource);
    } else return officeLocalFailure();
  }
  const consumedReads = new Set<string>();
  for (const [index, member] of value.members.entries()) {
    const original = execution.members[index]!;
    if (!object(member) || !exact(member, ["memberId", "role", "path", "final", "observedAt", ...(Object.hasOwn(member, "readRef") ? ["readRef"] : [])])
      || member.memberId !== original.memberId || member.role !== original.role || member.path !== original.path
      || !finalSnapshot(member.final, original.role === "directory")) return officeLocalFailure();
    const observedAt = boundedTime(member.observedAt, preparedAt, completedAt);
    if ((member.final as Record<string, unknown>).state !== "file") {
      if (Object.hasOwn(member, "readRef")) return officeLocalFailure();
      continue;
    }
    const ref = member.readRef;
    if (!object(ref) || !exact(ref, ["readId", "resourceLifetimeId", "completedAt"])
      || !text(ref.readId) || !text(ref.resourceLifetimeId) || consumedReads.has(ref.resourceLifetimeId)) return officeLocalFailure();
    const read = reads.get(ref.resourceLifetimeId);
    if (!read || read.readId !== ref.readId || read.memberId !== member.memberId || read.purpose !== "final"
      || read.state !== "closed" || !read.identity || read.closeReturnedAt !== ref.completedAt
      || hostOperationTimestamp(read.identityObservedAt) > observedAt || observedAt > hostOperationTimestamp(read.closeEnteredAt)
      || digestHarnessToolValue(read.identity) !== digestHarnessToolValue((member.final as Record<string, unknown>).identity)) return officeLocalFailure();
    boundedTime(ref.completedAt, observedAt, completedAt);
    consumedReads.add(ref.resourceLifetimeId);
  }
  return value as unknown as HostOfficeLocalTerminalManifest;
}
