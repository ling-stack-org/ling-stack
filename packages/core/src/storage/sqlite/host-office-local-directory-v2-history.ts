import type { HostOfficeLocalDirectoryEffectRecordV2, HostOfficeLocalDirectoryObservationV2, HostOfficeDirectoryResourceBindingV2 } from "../../host-office-local-directory-v2-types.js";
import type { HostOfficeNativeCallV2, HostOfficeNativeResourceFactV2 } from "../../host-office-local-native-v2-types.js";
import { directoryV2Failure, v2Same } from "./host-office-local-directory-v2-validation.js";

export interface OfficeDirectoryHistoryEntryV2 { readonly effect: HostOfficeLocalDirectoryEffectRecordV2; readonly observation: HostOfficeLocalDirectoryObservationV2 | null }
export interface OfficeDirectoryHistoryResourceV2 { readonly binding: HostOfficeDirectoryResourceBindingV2; readonly fact: HostOfficeNativeResourceFactV2 }

/** Verify exact original call references and lifetime continuity. Existing inode aliases are legal. */
export function validateOfficeDirectoryHistoryV2(entries: readonly OfficeDirectoryHistoryEntryV2[]): Map<string, OfficeDirectoryHistoryResourceV2> {
  const resources = new Map<string, OfficeDirectoryHistoryResourceV2>(), calls = new Map<string, HostOfficeNativeCallV2>(), acquired = new Map<string, string>();
  let nonce: string | undefined, monotonic = 0n;
  for (const { effect, observation } of entries) {
    if (!observation || observation.native.state !== "returned") continue;
    const result = observation.native.result;
    if (nonce && nonce !== result.snapshot.sessionNonce) return directoryV2Failure();
    nonce = result.snapshot.sessionNonce;
    for (let ordinal = 0; ordinal < result.calls.length; ordinal++) {
      const call = result.calls[ordinal]!;
      if (BigInt(call.calledAtMonotonicNs) < monotonic) return directoryV2Failure();
      if (call.nativeReturnState === "returned") monotonic = BigInt(call.returnedAtMonotonicNs);
      calls.set(effect.effectId + ":" + ordinal, call);
    }
    const current = new Map(result.snapshot.resources.map(item => [item.lifetimeId, item]));
    if ([...resources.values()].some(item => !current.has(item.fact.lifetimeId))) return directoryV2Failure();
    for (const binding of observation.resourceBindings) {
      const fact = current.get(binding.nativeLifetimeId)!;
      const previous = resources.get(binding.resourceSlotId);
      if (previous && (!v2Same(previous.binding, binding) || previous.fact.kind !== fact.kind || previous.fact.basename !== fact.basename
        || previous.fact.parentLifetimeId !== fact.parentLifetimeId || (previous.fact.identityObserved && (!fact.identityObserved
          || !v2Same(previous.fact.initialIdentity, fact.initialIdentity) || previous.fact.initialObservedAtMonotonicNs !== fact.initialObservedAtMonotonicNs))
        || (previous.fact.state === "closed" || previous.fact.state === "unknown") && fact.state !== previous.fact.state)) return directoryV2Failure();
      if (!previous && effect.kind !== "capture_parents" && !(effect.kind === "observe_publication" && ["publication_directory", "publication_file"].includes(fact.kind))
        && (!((effect.kind === "create_directory" || effect.kind === "create_file") && effect.resourceSlotId === binding.resourceSlotId))) return directoryV2Failure();
      if (binding.acquisitionCallRef) {
        const key = binding.acquisitionCallRef.effectId + ":" + binding.acquisitionCallRef.ordinal, call = calls.get(key);
        if (!call || !["open", "openat", "openat_create_exclusive"].includes(call.syscall) || call.resourceLifetimeId !== binding.nativeLifetimeId
          || call.nativeReturnState !== "returned" || call.returned !== "descriptor_acquired_redacted"
          || acquired.has(key) && acquired.get(key) !== binding.nativeLifetimeId) return directoryV2Failure();
        acquired.set(key, binding.nativeLifetimeId);
      }
      if (binding.firstFstatCallRef) {
        const call = calls.get(binding.firstFstatCallRef.effectId + ":" + binding.firstFstatCallRef.ordinal);
        if (!call || call.syscall !== "fstat" || call.resourceLifetimeId !== binding.nativeLifetimeId || call.nativeReturnState !== "returned" || call.returned !== 0
          || fact.initialObservedAtMonotonicNs !== call.returnedAtMonotonicNs || call.identity && !v2Same(call.identity, fact.initialIdentity)) return directoryV2Failure();
      }
      resources.set(binding.resourceSlotId, { binding, fact });
    }
    // Every successful descriptor acquisition has one exact slot. A matching inode cannot adopt an omitted original lifetime.
    result.calls.forEach((call, ordinal) => {
      if (call.nativeReturnState === "returned" && call.returned === "descriptor_acquired_redacted"
        && acquired.get(effect.effectId + ":" + ordinal) !== call.resourceLifetimeId) return directoryV2Failure();
    });
  }
  return resources;
}
