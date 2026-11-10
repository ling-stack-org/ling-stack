import { createHash } from "node:crypto";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import type { OfficeLocalDirectoryReplayInputV2 } from "../../host-office-local-directory-v2-replay-types.js";
import type { HostOfficeLocalDirectoryEffectRecordV2, HostOfficeLocalDirectoryObservationV2 } from "../../host-office-local-directory-v2-types.js";
import type { HostOfficeNativeResultFactsV2 } from "../../host-office-local-native-v2-types.js";
import { validateOfficeLocalDirectoryPreparedV2 } from "./host-office-local-directory-v2-prepared.js";
import { validateOfficeLocalDirectoryEffectV2 } from "./host-office-local-directory-v2-effects.js";
import { validateOfficeLocalDirectoryObservationPayloadV2 } from "./host-office-local-directory-v2-observations.js";
import { validateOfficeLocalDirectoryTerminalPayloadV2 } from "./host-office-local-directory-v2-terminal.js";
import { officeDirectoryEffectDigestV2, officeDirectoryIdentityDigestV2 } from "./host-office-local-directory-v2-records.js";
import { directoryV2Failure, v2Digest, v2Exact, v2Object, v2Same, v2Text, v2Timestamp } from "./host-office-local-directory-v2-validation.js";

export interface CompleteOfficeDirectoryEntryV2 {
  readonly effect: HostOfficeLocalDirectoryEffectRecordV2;
  readonly observation: HostOfficeLocalDirectoryObservationV2;
  readonly result: HostOfficeNativeResultFactsV2;
}
export const officeDirectoryReplayHashV2 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const object = (value: unknown): boolean => v2Object(value);
const exact = (value: unknown, keys: readonly string[]): boolean => v2Object(value) && v2Exact(value, keys);

/** Pure consistency checks, not an independent SQLite seal/lineage or live issuer verification. */
export function officeDirectoryReplayIntegrityV2(input: OfficeLocalDirectoryReplayInputV2): readonly CompleteOfficeDirectoryEntryV2[] {
  if (!exact(input, ["execution", "terminal", "effects"]) || !object(input.execution)
    || !object(input.terminal) || !Array.isArray(input.effects) || input.effects.length < 1 || input.effects.length > 1024) return directoryV2Failure();
  const { execution, terminal: record } = input;
  const { preparedArtifactId, preparedDigest, identityDigest, revision, ...prepared } = execution;
  validateOfficeLocalDirectoryPreparedV2(prepared);
  if (!v2Text(preparedArtifactId) || !v2Digest(preparedDigest) || revision !== 0 || preparedDigest !== officeDirectoryReplayHashV2(prepared)
    || identityDigest !== officeDirectoryIdentityDigestV2(prepared, preparedArtifactId, preparedDigest)) return directoryV2Failure();
  const { terminalArtifactId, terminalDigest, effectSetDigest, effectCount, sealedAt, ...terminal } = record;
  if (!v2Text(terminalArtifactId) || !v2Digest(terminalDigest) || terminalDigest !== officeDirectoryReplayHashV2(terminal)
    || effectCount !== input.effects.length || effectSetDigest !== digestHarnessToolValue(terminal.effects)
    || v2Timestamp(sealedAt) < v2Timestamp(terminal.completedAt) || terminal.outcome !== "published_native_only"
    || !terminal.installationEntered || terminal.canonicalVisibility?.state !== "unverified") return directoryV2Failure();
  const ids = new Set<string>(), artifacts = new Set<string>([preparedArtifactId]);
  if (artifacts.has(terminalArtifactId)) return directoryV2Failure();
  artifacts.add(terminalArtifactId);
  let completed = v2Timestamp(prepared.preparedAt), monotonic = 0n;
  const entries = input.effects.map((entry, index): CompleteOfficeDirectoryEntryV2 => {
    if (!exact(entry, ["effect", "observation"]) || !object(entry.effect) || !object(entry.observation)) return directoryV2Failure();
    const { effect, observation } = entry;
    if (!observation) return directoryV2Failure();
    const { executionId, effectDigest, enteredAt, observationArtifactId, revision: effectRevision, ...descriptor } = effect;
    validateOfficeLocalDirectoryEffectV2(execution, descriptor);
    if (executionId !== execution.executionId || effect.ordinal !== index || ids.has(effect.effectId)
      || effectDigest !== officeDirectoryEffectDigestV2(execution, descriptor) || effectRevision !== 2
      || !v2Text(observationArtifactId) || artifacts.has(observationArtifactId) || !enteredAt
      || effect.mode !== "forward" && (effect.kind !== "close_session" || index !== input.effects.length - 1)
      || v2Timestamp(effect.preparedAt) < completed || v2Timestamp(enteredAt) < v2Timestamp(effect.preparedAt)) return directoryV2Failure();
    validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, observation, terminal.completedAt);
    const ref = terminal.effects?.[index];
    if (!ref?.observation || ref.ordinal !== index || ref.effectId !== effect.effectId || ref.effectDigest !== effectDigest
      || ref.enteredAt !== enteredAt || ref.observation.artifactId !== observationArtifactId || ref.observation.digest !== officeDirectoryReplayHashV2(observation)
      || observation.native.state !== "returned" || observation.host.state !== "returned" || !observation.native.result.success
      || Object.hasOwn(observation.native.result, "blockerCode")) return directoryV2Failure();
    const result = observation.native.result;
    for (const call of result.calls) {
      if (call.nativeReturnState !== "returned" || call.calledAtMonotonicNs === "0" || BigInt(call.calledAtMonotonicNs) < monotonic
        || BigInt(call.returnedAtMonotonicNs) < BigInt(call.calledAtMonotonicNs)) return directoryV2Failure();
      monotonic = BigInt(call.returnedAtMonotonicNs);
    }
    ids.add(effect.effectId); artifacts.add(observationArtifactId); completed = v2Timestamp(observation.completedAt);
    return { effect, observation, result };
  });
  validateOfficeLocalDirectoryTerminalPayloadV2(execution, terminal, entries);
  if (terminal.effects.length !== entries.length || v2Timestamp(terminal.completedAt) < completed
    || !v2Same(record.source, execution.source)) return directoryV2Failure();
  return entries;
}
