import type { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { HOST_OFFICE_LOCAL_PROTOCOL, type HostOfficeLocalEffectObservation,
  type HostOfficeLocalExecutionRecord } from "../../host-office-local-types.js";
import type { HostOfficeLocalTerminalEffect, HostOfficeLocalTerminalRecord,
  SealHostOfficeLocalTerminalInput } from "../../host-office-local-terminal-types.js";
import { hostOperationTimestamp } from "./host-operation-journal-evidence.js";
import { officeLocalFailure, readOfficeLocalEffects, readOfficeLocalSeal, validateOfficeLocalObservation } from "./host-office-local-records.js";
import { validateOfficeLocalTerminalPayload } from "./host-office-local-terminal-payload.js";

/** Load complete SQLite effects and exact original observation seals, never model text or today's filesystem. */
export function validateOfficeLocalTerminalSeal(database: DatabaseSync, execution: HostOfficeLocalExecutionRecord,
  input: SealHostOfficeLocalTerminalInput): HostOfficeLocalTerminalRecord {
  const seal = readOfficeLocalSeal(database, input.terminalArtifactId, execution.source.runId);
  if (seal.hash !== input.terminalDigest) return officeLocalFailure();
  const manifest = validateOfficeLocalTerminalPayload(execution, seal.payload, seal.createdAt);
  const effects = readOfficeLocalEffects(database, execution), completedAt = hostOperationTimestamp(manifest.completedAt);
  const observations = new Map<string, HostOfficeLocalEffectObservation>();
  const expected: HostOfficeLocalTerminalEffect[] = effects.map(effect => {
    if (hostOperationTimestamp(effect.preparedAt) > completedAt
      || (effect.enteredAt && hostOperationTimestamp(effect.enteredAt) > completedAt)) return officeLocalFailure();
    let observation: HostOfficeLocalTerminalEffect["observation"] = null;
    if (effect.observationArtifactId) {
      const original = readOfficeLocalSeal(database, effect.observationArtifactId, execution.source.runId);
      const fact = validateOfficeLocalObservation(database, execution, effect, effect.observationArtifactId);
      if (hostOperationTimestamp(original.createdAt) > completedAt || hostOperationTimestamp(fact.completedAt) > completedAt) return officeLocalFailure();
      observations.set(effect.effectId, fact);
      observation = { artifactId: effect.observationArtifactId, digest: original.hash };
    }
    return { ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest,
      enteredAt: effect.enteredAt ?? null, observation };
  });
  // Count equality alone cannot establish a set. Order, identity, entry and every seal hash must match.
  if (manifest.effects.length !== expected.length || digestHarnessToolValue(manifest.effects) !== digestHarnessToolValue(expected)) return officeLocalFailure();
  const effectResources = new Map(manifest.resources.filter(resource => resource.origin === "effect")
    .map(resource => [resource.openEffectId, resource] as const));
  const descriptors = new Map(effects.map(effect => [effect.effectId, effect] as const));
  for (const [openId, resource] of effectResources) {
    const open = descriptors.get(openId), observation = observations.get(openId);
    if (!open || open.kind !== "open" || open.memberId !== resource.memberId
      || open.resourceLifetimeId !== resource.resourceLifetimeId
      || (observation && observation.native.state !== "returned")) return officeLocalFailure();
    if (resource.identityObservedAt && hostOperationTimestamp(resource.identityObservedAt)
      < hostOperationTimestamp(open.enteredAt ?? open.preparedAt)) return officeLocalFailure();
    if (observation?.native.state === "returned" && resource.identityObservedAt
      && hostOperationTimestamp(resource.identityObservedAt) < hostOperationTimestamp(observation.native.returnedAt)) return officeLocalFailure();
    // A later cleanup fstat must not rewrite the first returned-open identity seal.
    if (observation?.openResource && (!resource.identity || resource.identityObservedAt !== observation.openResource.observedAt
      || digestHarnessToolValue(resource.identity) !== digestHarnessToolValue(observation.openResource.identity))) return officeLocalFailure();
    if (resource.state !== "retained") {
      const close = descriptors.get(resource.closeEffectId), closeObservation = observations.get(resource.closeEffectId);
      if (!close || close.kind !== "close" || close.ordinal <= open.ordinal || close.memberId !== resource.memberId
        || close.resourceLifetimeId !== resource.resourceLifetimeId
        || (closeObservation && (closeObservation.native.state === "not_entered"
          || (resource.state === "closed" && closeObservation.native.state !== "returned")))) return officeLocalFailure();
      if (resource.identityObservedAt && hostOperationTimestamp(resource.identityObservedAt)
        > hostOperationTimestamp(close.enteredAt ?? close.preparedAt)) return officeLocalFailure();
    }
  }
  for (const effect of effects) {
    const observation = observations.get(effect.effectId);
    if (effect.kind === "open" && observation?.native.state === "returned" && !effectResources.has(effect.effectId)) return officeLocalFailure();
    // Core callback entry precedes the writer's guard. Only the native fact proves publication was called.
    if (["link", "rename"].includes(effect.kind) && observation && observation.native.state !== "not_entered"
      && !manifest.publicationEntered) return officeLocalFailure();
  }
  if (manifest.publicationEntered && !effects.some(effect => ["link", "rename"].includes(effect.kind))) return officeLocalFailure();
  return { ...manifest, terminalArtifactId: input.terminalArtifactId, terminalDigest: seal.hash,
    effectSetDigest: digestHarnessToolValue(manifest.effects), effectCount: manifest.effects.length, sealedAt: seal.createdAt };
}

/** Revalidate the append-only terminal row and immutable complete manifest on every read. */
export function readOfficeLocalTerminal(database: DatabaseSync, execution: HostOfficeLocalExecutionRecord): HostOfficeLocalTerminalRecord | undefined {
  const row = database.prepare("SELECT * FROM host_office_local_terminals WHERE execution_id=?").get(execution.executionId);
  if (!row) return undefined;
  const terminal = validateOfficeLocalTerminalSeal(database, execution, {
    terminalArtifactId: String(row.terminal_artifact_id), terminalDigest: String(row.terminal_digest),
  });
  if (row.schema_version !== 1 || row.protocol !== HOST_OFFICE_LOCAL_PROTOCOL || row.execution_id !== execution.executionId
    || row.execution_identity_digest !== execution.identityDigest || row.effect_set_digest !== terminal.effectSetDigest
    || row.effect_count !== terminal.effectCount || row.sealed_at !== terminal.sealedAt) return officeLocalFailure();
  return terminal;
}
