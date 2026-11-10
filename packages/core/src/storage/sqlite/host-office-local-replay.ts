import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { HOST_OFFICE_LOCAL_PROTOCOL, type HostOfficeLocalEffectObservation, type HostOfficeLocalEffectRecord,
  type HostOfficeLocalExecutionRecord } from "../../host-office-local-types.js";
import type { HostOfficeLocalTerminalManifest, HostOfficeLocalTerminalRecord } from "../../host-office-local-terminal-types.js";
import { hostOperationTimestamp, sameHostOperationSource } from "./host-operation-journal-evidence.js";
import { validateOfficeLocalEffect, validateOfficeLocalPrepared } from "./host-office-local-records.js";
import { validateOfficeLocalObservationPayload } from "./host-office-local-observations.js";
import { validateOfficeLocalTerminalPayload } from "./host-office-local-terminal-payload.js";
import { OfficeReplayResources, officeReplayFailure, type OfficeReplayFile } from "./host-office-local-replay-resources.js";

export interface OfficeLocalReplayEffect {
  readonly effect: HostOfficeLocalEffectRecord;
  readonly observation: HostOfficeLocalEffectObservation | null;
}
export interface OfficeLocalReplayInput {
  readonly execution: HostOfficeLocalExecutionRecord;
  readonly terminal: HostOfficeLocalTerminalManifest;
  readonly effects: readonly OfficeLocalReplayEffect[];
}
export interface OfficeLocalReplayResult {
  readonly kind: "office_local_published_verified";
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly effectCount: number;
  readonly targetMemberId: string;
  readonly recoveryMemberId?: string;
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const at = hostOperationTimestamp;

/** Also accept a reverified getter record, without ignoring unknown manifest fields. */
function terminalFacts(execution: HostOfficeLocalExecutionRecord,
  value: HostOfficeLocalTerminalManifest): HostOfficeLocalTerminalManifest {
  const record = value as HostOfficeLocalTerminalManifest & Partial<HostOfficeLocalTerminalRecord>;
  const { terminalArtifactId, terminalDigest, effectSetDigest, effectCount, sealedAt, ...manifest } = record;
  const hasRecord = ["terminalArtifactId", "terminalDigest", "effectSetDigest", "effectCount", "sealedAt"]
    .some(key => Object.hasOwn(record, key));
  if (hasRecord && (typeof terminalArtifactId !== "string" || !terminalArtifactId || terminalArtifactId.includes("\0")
    || terminalDigest !== hash(manifest) || effectCount !== manifest.effects?.length
    || effectSetDigest !== digestHarnessToolValue(manifest.effects) || !sealedAt)) officeReplayFailure();
  return validateOfficeLocalTerminalPayload(execution, manifest, sealedAt ?? manifest.completedAt);
}

/** Fixed writer graph, including the complete parent directory chain, not arbitrary file effects. */
function assertWriterMembers(execution: HostOfficeLocalExecutionRecord): void {
  const parent = dirname(execution.targetPath), overwrite = execution.input.state === "file";
  const files = execution.members.filter(member => member.role !== "directory");
  const expected = [
    { memberId: "target", role: "target", path: execution.targetPath },
    { memberId: "temporary", role: "temporary", path: join(parent, `.ling-office-${execution.executionId}.tmp`) },
    ...(overwrite ? [{ memberId: "recovery", role: "recovery", path: join(parent, `.ling-office-recovery-${execution.executionId}.${execution.format}`) }] : []),
  ];
  if (files.length !== expected.length || expected.some((member, index) => files[index]?.memberId !== member.memberId
    || files[index]?.role !== member.role || files[index]?.path !== member.path)) officeReplayFailure();
  const directories = execution.members.filter(member => member.role === "directory");
  const parts = relative(execution.workspacePath, parent).split(sep).filter(Boolean);
  if (directories.length !== parts.length || execution.members.length !== expected.length + parts.length) officeReplayFailure();
  let path = execution.workspacePath;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const member = directories[index];
    if (!member || member.memberId !== `directory-${index}` || member.path !== path
      || execution.members[expected.length + index] !== member) officeReplayFailure();
    // mkdir's returned {kind} plus post-mkdir lstat is not a creator-bound receipt.
    if (member.initial.state !== "directory") officeReplayFailure();
  }
}

/**
 * Pure whole-file verification over already sealed Core facts. This does not
 * access SQLite/filesystem, settle journal roles, reopen FDs or grant authority.
 * Only a complete successful fixed-writer graph is presently supported; failed
 * facts remain recordable, but uncertain native/Host outcomes cannot earn safety.
 */
export function verifyOfficeLocalReplay(input: OfficeLocalReplayInput): OfficeLocalReplayResult {
  const { execution, effects } = input;
  const { preparedArtifactId, preparedDigest, identityDigest, revision, ...prepared } = execution;
  validateOfficeLocalPrepared(prepared);
  const terminal = terminalFacts(execution, input.terminal);
  const sourceKeys = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"];
  if (hash(prepared) !== preparedDigest || identityDigest !== digestHarnessToolValue({ prepared, preparedArtifactId, preparedDigest })
    || !Number.isSafeInteger(revision) || revision < 0 || !preparedArtifactId
    || Object.keys(execution.source).length !== sourceKeys.length
    || terminal.schemaVersion !== 1 || terminal.protocol !== HOST_OFFICE_LOCAL_PROTOCOL || terminal.kind !== "office_local_terminal_v1"
    || terminal.executionId !== execution.executionId || terminal.executionIdentityDigest !== identityDigest
    || terminal.preparedArtifactId !== preparedArtifactId || terminal.preparedDigest !== preparedDigest
    || !terminal.source || Object.keys(terminal.source).length !== sourceKeys.length
    || !sameHostOperationSource(terminal.source, execution.source) || !Array.isArray(effects) || !Array.isArray(terminal.effects)
    || terminal.effects.length !== effects.length || effects.length === 0 || effects.length > 1024
    || at(terminal.completedAt) < at(execution.preparedAt)) officeReplayFailure();
  assertWriterMembers(execution);
  const resources = new OfficeReplayResources(execution, terminal), seen = new Set<string>();
  const artifacts = new Set<string>([preparedArtifactId]);
  const terminalArtifactId = (input.terminal as Partial<HostOfficeLocalTerminalRecord>).terminalArtifactId;
  if (terminalArtifactId) {
    if (artifacts.has(terminalArtifactId)) officeReplayFailure();
    artifacts.add(terminalArtifactId);
  }
  let previousCompletedAt = execution.preparedAt;
  for (const [index, { effect, observation }] of effects.entries()) {
    const { executionId, effectDigest, enteredAt, observationArtifactId, revision: effectRevision, ...descriptor } = effect;
    validateOfficeLocalEffect(execution, descriptor);
    const ref = terminal.effects[index];
    if (executionId !== execution.executionId || effect.ordinal !== index || seen.has(effect.effectId)
      || effectDigest !== digestHarnessToolValue({ executionIdentityDigest: identityDigest, effect: descriptor })
      || !Number.isSafeInteger(effectRevision) || effectRevision < 0 || !enteredAt || !observationArtifactId || !observation
      || artifacts.has(observationArtifactId)
      || !ref || ref.ordinal !== index || ref.effectId !== effect.effectId || ref.effectDigest !== effectDigest
      || ref.enteredAt !== enteredAt || !ref.observation || ref.observation.artifactId !== observationArtifactId
      || ref.observation.digest !== hash(observation) || at(effect.preparedAt) < at(previousCompletedAt)
      || at(enteredAt) < at(effect.preparedAt)) officeReplayFailure();
    validateOfficeLocalObservationPayload(execution, effect, observation, terminal.completedAt);
    if (effect.mode !== "forward" || observation.native.state !== "returned" || observation.host.state !== "returned") officeReplayFailure();
    seen.add(effect.effectId);
    artifacts.add(observationArtifactId);
    previousCompletedAt = observation.completedAt;
  }

  let index = 0;
  const take = (kind: HostOfficeLocalEffectRecord["kind"], memberId: string, lifetime?: string): OfficeLocalReplayEffect => {
    const item = effects[index++];
    if (!item || item.effect.kind !== kind || item.effect.memberId !== memberId
      || (lifetime !== undefined && item.effect.resourceLifetimeId !== lifetime)) return officeReplayFailure();
    return item;
  };
  const writeFile = (memberId: string, bytes: { readonly sizeBytes: number; readonly bytesSha256: string }): OfficeReplayFile => {
    const open = take("open", memberId), lifetime = open.effect.resourceLifetimeId;
    if (!lifetime || !open.observation) return officeReplayFailure();
    const identity = resources.openedFile(open.effect, open.observation);
    let offset = 0;
    while (offset < bytes.sizeBytes) {
      const write = take("write", memberId, lifetime), native = write.observation?.native;
      if (write.effect.offset !== offset || write.effect.sizeBytes !== bytes.sizeBytes - offset || native?.state !== "returned"
        || native.result.kind !== "write" || !Number.isSafeInteger(native.result.bytesWritten)
        || native.result.bytesWritten <= 0 || native.result.bytesWritten > bytes.sizeBytes - offset) return officeReplayFailure();
      offset += native.result.bytesWritten;
      resources.refresh(memberId, identity, offset, write.observation!);
    }
    take("fsync", memberId, lifetime);
    const close = take("close", memberId, lifetime);
    resources.closedFile(close.effect);
    return { identity, sizeBytes: bytes.sizeBytes, bytesSha256: bytes.bytesSha256 };
  };
  const files = new Map<string, OfficeReplayFile>();
  if (execution.input.state === "file") files.set("recovery", writeFile("recovery", execution.input));
  const temporary = writeFile("temporary", execution.output);
  const publish = take(execution.input.state === "absent" ? "link" : "rename", "target");
  if (publish.effect.fromMemberId !== "temporary" || !publish.observation) officeReplayFailure();
  resources.refresh("target", temporary.identity, temporary.sizeBytes, publish.observation);
  if (execution.input.state === "absent") {
    resources.refresh("temporary", temporary.identity, temporary.sizeBytes, publish.observation);
    take("unlink", "temporary");
  }
  files.set("target", temporary);
  if (index !== effects.length || terminal.outcome !== "published" || terminal.publicationEntered !== true) officeReplayFailure();
  resources.finish(files, previousCompletedAt);
  return { kind: "office_local_published_verified", executionId: execution.executionId, executionIdentityDigest: identityDigest,
    effectCount: effects.length, targetMemberId: "target", ...(execution.input.state === "file" ? { recoveryMemberId: "recovery" } : {}) };
}
