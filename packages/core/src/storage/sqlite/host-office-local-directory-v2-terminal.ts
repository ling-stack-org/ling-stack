import type { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, type HostOfficeLocalDirectoryExecutionRecordV2,
  type HostOfficeDirectoryTerminalResourceV2 } from "../../host-office-local-directory-v2-types.js";
import type { HostOfficeLocalDirectoryTerminalManifestV2, HostOfficeLocalDirectoryTerminalRecordV2 } from "../../host-office-local-directory-v2-terminal-types.js";
import type { SealHostOfficeLocalTerminalInput } from "../../host-office-local-terminal-types.js";
import { readOfficeLocalSeal } from "./host-office-local-records.js";
import { officeDirectorySlotsV2, validateOfficeDirectoryBindingV2 } from "./host-office-local-directory-v2-effects.js";
import { readOfficeLocalDirectoryEffectsV2, validateOfficeLocalDirectoryObservationV2 } from "./host-office-local-directory-v2-records.js";
import { validateOfficeDirectoryHistoryV2, type OfficeDirectoryHistoryEntryV2 } from "./host-office-local-directory-v2-history.js";
import { directoryV2Failure, v2Digest, v2Exact, v2Object, v2OptionalKeys, v2Same, v2Source, v2Text, v2Timestamp } from "./host-office-local-directory-v2-validation.js";

function ref(value: unknown): { effectId: string; ordinal: number } {
  validateOfficeDirectoryBindingV2({ resourceSlotId: "validation-only", nativeLifetimeId: "validation-only", acquisitionCallRef: value });
  return value as { effectId: string; ordinal: number };
}
/** Exact full terminal roster. Unverified publication is retained as facts, never a safe certificate. */
export function validateOfficeLocalDirectoryTerminalPayloadV2(execution: HostOfficeLocalDirectoryExecutionRecordV2,
  value: unknown, entries: readonly OfficeDirectoryHistoryEntryV2[]): HostOfficeLocalDirectoryTerminalManifestV2 {
  if (!v2Object(value) || !v2Exact(value, ["schemaVersion", "protocol", "kind", "executionId", "executionIdentityDigest", "source", "preparedArtifactId", "preparedDigest",
    "outcome", "installationEntered", "effects", "resources", "canonicalVisibility", "completedAt"])
    || value.schemaVersion !== 2 || value.protocol !== HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL || value.kind !== "office_local_directory_terminal_v2"
    || value.executionId !== execution.executionId || value.executionIdentityDigest !== execution.identityDigest || !v2Source(value.source) || !v2Same(value.source, execution.source)
    || value.preparedArtifactId !== execution.preparedArtifactId || value.preparedDigest !== execution.preparedDigest
    || !["published_native_only", "failed", "unknown"].includes(String(value.outcome)) || typeof value.installationEntered !== "boolean"
    || !Array.isArray(value.effects) || value.effects.length !== entries.length || !Array.isArray(value.resources)
    || !v2Object(value.canonicalVisibility) || !v2Exact(value.canonicalVisibility, ["state", "blockerCode"])
    || value.canonicalVisibility.state !== "unverified" || !v2Text(value.canonicalVisibility.blockerCode)) return directoryV2Failure();
  const completedAt = v2Timestamp(value.completedAt), resources = validateOfficeDirectoryHistoryV2(entries);
  const expected = new Set(officeDirectorySlotsV2(execution).map(item => item.resourceSlotId));
  const ancestors = new Set([...execution.stage.ancestors, ...execution.destination.ancestors].map(item => item.resourceSlotId));
  if (value.resources.length !== expected.size) return directoryV2Failure();
  const uncertain = entries.some(item => !!item.effect.enteredAt && (!item.observation || item.observation.native.state !== "returned" || item.observation.host.state !== "returned"));
  let installationEntered = false, installed = false;
  for (const [index, { effect, observation }] of entries.entries()) {
    const terminalEffect = value.effects[index];
    if (!v2Object(terminalEffect) || !v2Exact(terminalEffect, ["ordinal", "effectId", "effectDigest", "enteredAt", "observation"])
      || terminalEffect.ordinal !== effect.ordinal || terminalEffect.effectId !== effect.effectId || terminalEffect.effectDigest !== effect.effectDigest
      || terminalEffect.enteredAt !== (effect.enteredAt ?? null)) return directoryV2Failure();
    if (effect.observationArtifactId) {
      if (!v2Object(terminalEffect.observation) || !v2Exact(terminalEffect.observation, ["artifactId", "digest"])
        || terminalEffect.observation.artifactId !== effect.observationArtifactId || !v2Digest(terminalEffect.observation.digest) || !observation) return directoryV2Failure();
    } else if (terminalEffect.observation !== null) return directoryV2Failure();
    if (completedAt < v2Timestamp(observation?.completedAt ?? effect.enteredAt ?? effect.preparedAt)) return directoryV2Failure();
    if (observation?.native.state === "returned") {
      installationEntered ||= observation.native.result.snapshot.installationEntered;
      if (effect.kind === "install_tree" && observation.native.result.success) installed = true;
    }
  }
  if (value.installationEntered !== installationEntered || value.outcome === "published_native_only" && (!installed || uncertain)
    || uncertain && value.outcome !== "unknown") return directoryV2Failure();
  for (const raw of value.resources) {
    if (!v2Object(raw) || !v2Text(raw.resourceSlotId) || !expected.delete(raw.resourceSlotId)) return directoryV2Failure();
    const known = resources.get(raw.resourceSlotId);
    if (raw.state === "not_acquired") {
      if (!v2Exact(raw, ["resourceSlotId", "state"]) || known && known.fact.state !== "not_acquired"
        || entries.some(item => item.effect.enteredAt && (!item.observation || item.observation.native.state !== "returned")
          && (item.effect.kind === "capture_parents" && ancestors.has(String(raw.resourceSlotId))
            || "resourceSlotId" in item.effect && item.effect.resourceSlotId === raw.resourceSlotId))) return directoryV2Failure();
      continue;
    }
    if (raw.state === "unknown" && !Object.hasOwn(raw, "nativeLifetimeId")) {
      if (!v2Exact(raw, ["resourceSlotId", "state", "unknownCause"]) || raw.unknownCause !== "native_reply_unknown" || !uncertain || known) return directoryV2Failure();
      continue;
    }
    if (!known || !["retained", "closed", "unknown"].includes(String(raw.state))
      || !v2Exact(raw, ["resourceSlotId", "nativeLifetimeId", "state", ...v2OptionalKeys(raw, ["acquisitionCallRef", "firstFstatCallRef", "closeCallRef", "unknownCause"])])) return directoryV2Failure();
    const binding = { resourceSlotId: raw.resourceSlotId, nativeLifetimeId: raw.nativeLifetimeId,
      ...Object.fromEntries(["acquisitionCallRef", "firstFstatCallRef"].filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]])) };
    validateOfficeDirectoryBindingV2(binding);
    if (!v2Same(binding, known.binding) || raw.state !== known.fact.state && !(raw.state === "unknown" && raw.unknownCause === "native_reply_unknown" && uncertain)) return directoryV2Failure();
    if (raw.state === "retained") {
      if (Object.hasOwn(raw, "closeCallRef") || Object.hasOwn(raw, "unknownCause")) return directoryV2Failure();
    } else if (raw.state === "closed" || raw.unknownCause === "close_entered") {
      const close = ref(raw.closeCallRef), original = entries.find(item => item.effect.effectId === close.effectId)?.observation;
      const call = original?.native.state === "returned" ? original.native.result.calls[close.ordinal] : undefined;
      if (!call || call.syscall !== "close" || call.resourceLifetimeId !== known.fact.lifetimeId
        || raw.state === "closed" && (Object.hasOwn(raw, "unknownCause") || call.nativeReturnState !== "returned" || call.returned !== 0)
        || raw.state === "unknown" && call.nativeReturnState === "returned" && call.success) return directoryV2Failure();
    } else if (raw.state !== "unknown" || !["original_fstat_lost", "native_reply_unknown"].includes(String(raw.unknownCause))
      || Object.hasOwn(raw, "closeCallRef") || raw.unknownCause === "native_reply_unknown" && !uncertain) return directoryV2Failure();
    if (raw.unknownCause === "original_fstat_lost") {
      const last = entries.flatMap(item => item.observation?.native.state === "returned" ? item.observation.native.result.calls : [])
        .filter(call => call.resourceLifetimeId === known.fact.lifetimeId).at(-1);
      const initial = known.fact.initialIdentity, identity = last?.identity;
      if (!last || last.syscall !== "fstat" || last.nativeReturnState !== "returned" || !(last.errno === 9
        || initial && identity && (initial.device !== identity.device || initial.inode !== identity.inode || initial.isFile !== identity.isFile || initial.isDirectory !== identity.isDirectory))) return directoryV2Failure();
    }
  }
  return value as unknown as HostOfficeLocalDirectoryTerminalManifestV2;
}

export function validateOfficeLocalDirectoryTerminalSealV2(database: DatabaseSync, execution: HostOfficeLocalDirectoryExecutionRecordV2,
  input: SealHostOfficeLocalTerminalInput): HostOfficeLocalDirectoryTerminalRecordV2 {
  if (!v2Text(input.terminalArtifactId) || !v2Digest(input.terminalDigest)) return directoryV2Failure();
  const seal = readOfficeLocalSeal(database, input.terminalArtifactId, execution.source.runId), effects = readOfficeLocalDirectoryEffectsV2(database, execution);
  const entries = effects.map(effect => ({ effect, observation: effect.observationArtifactId ? validateOfficeLocalDirectoryObservationV2(database, execution, effect, effect.observationArtifactId) : null }));
  const terminal = validateOfficeLocalDirectoryTerminalPayloadV2(execution, seal.payload, entries);
  const expectedEffects = effects.map(effect => ({ ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest, enteredAt: effect.enteredAt ?? null,
    observation: effect.observationArtifactId ? { artifactId: effect.observationArtifactId, digest: readOfficeLocalSeal(database, effect.observationArtifactId, execution.source.runId).hash } : null }));
  if (seal.hash !== input.terminalDigest || !v2Same(terminal.effects, expectedEffects) || v2Timestamp(seal.createdAt) < v2Timestamp(terminal.completedAt)) return directoryV2Failure();
  return { ...terminal, terminalArtifactId: input.terminalArtifactId, terminalDigest: seal.hash, effectSetDigest: digestHarnessToolValue(expectedEffects), effectCount: effects.length, sealedAt: seal.createdAt };
}
export function readOfficeLocalDirectoryTerminalV2(database: DatabaseSync, execution: HostOfficeLocalDirectoryExecutionRecordV2): HostOfficeLocalDirectoryTerminalRecordV2 | undefined {
  const row = database.prepare("SELECT * FROM host_office_local_directory_v2_terminals WHERE execution_id=?").get(execution.executionId);
  if (!row) return undefined;
  const terminal = validateOfficeLocalDirectoryTerminalSealV2(database, execution, { terminalArtifactId: String(row.terminal_artifact_id), terminalDigest: String(row.terminal_digest) });
  if (row.schema_version !== 2 || row.protocol !== HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL || row.execution_identity_digest !== execution.identityDigest
    || row.effect_set_digest !== terminal.effectSetDigest || row.effect_count !== terminal.effectCount || row.sealed_at !== terminal.sealedAt) return directoryV2Failure();
  return terminal;
}
