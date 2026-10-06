import { officeDirectoryPreparedIdentityMatchesV2, officeDirectorySlotsV2, type HostOfficeDirectoryResourceBindingV2,
  type HostOfficeLocalDirectoryPreparedV2, type HostOfficeNativeResultFactsV2 } from "@ling-stack/core";

const fail = (): never => { throw new Error("office_local_directory_resource_binding_invalid"); };

/**
 * Private factual slot ledger, not a resource owner. Live capabilities remain in
 * the fixed adapter's lexical frame; a binding, inode or persisted row cannot
 * obtain a native session. Original call refs never come from later snapshots.
 */
export class OfficeLocalDirectoryResourceFacts {
  readonly #slots: ReturnType<typeof officeDirectorySlotsV2>;
  readonly #bindings = new Map<string, HostOfficeDirectoryResourceBindingV2>();
  #nonce: string | undefined;

  constructor(execution: HostOfficeLocalDirectoryPreparedV2) {
    this.#slots = officeDirectorySlotsV2(execution);
  }

  /** Validate the whole returned roster before advancing any original binding. */
  accept(effectId: string, facts: HostOfficeNativeResultFactsV2): readonly HostOfficeDirectoryResourceBindingV2[] {
    if (this.#nonce && this.#nonce !== facts.snapshot.sessionNonce) return fail();
    const next = new Map(this.#bindings), seen = new Set<string>(), result: HostOfficeDirectoryResourceBindingV2[] = [];
    if (facts.snapshot.resources.length > this.#slots.length || facts.snapshot.resources.length < next.size) return fail();
    for (const [index, resource] of facts.snapshot.resources.entries()) {
      const slot = this.#slots[index];
      if (!slot || slot.kind !== resource.kind || slot.basename !== resource.basename || seen.has(resource.lifetimeId)) return fail();
      seen.add(resource.lifetimeId);
      const parent = slot.parentResourceSlotId ? next.get(slot.parentResourceSlotId) : undefined;
      if (resource.parentLifetimeId !== (parent?.nativeLifetimeId ?? "")) return fail();
      if (slot.initialIdentity && resource.identityObserved
        && (!resource.initialIdentity || !officeDirectoryPreparedIdentityMatchesV2(slot.initialIdentity, resource.initialIdentity))) return fail();
      let binding = next.get(slot.resourceSlotId);
      if (binding && binding.nativeLifetimeId !== resource.lifetimeId) return fail();
      if (!binding) {
        const acquired = facts.calls.findIndex(call => call.resourceLifetimeId === resource.lifetimeId
          && ["open", "openat", "openat_create_exclusive"].includes(call.syscall)
          && call.nativeReturnState === "returned" && call.returned === "descriptor_acquired_redacted");
        const firstStat = facts.calls.findIndex(call => call.resourceLifetimeId === resource.lifetimeId
          && call.syscall === "fstat" && call.nativeReturnState === "returned" && call.returned === 0);
        if (resource.state !== "not_acquired" && acquired < 0 || resource.identityObserved && (firstStat < 0 || firstStat <= acquired)) return fail();
        binding = Object.freeze({ resourceSlotId: slot.resourceSlotId, nativeLifetimeId: resource.lifetimeId,
          ...(acquired < 0 ? {} : { acquisitionCallRef: Object.freeze({ effectId, ordinal: acquired }) }),
          ...(firstStat < 0 ? {} : { firstFstatCallRef: Object.freeze({ effectId, ordinal: firstStat }) }) });
        next.set(slot.resourceSlotId, binding);
      }
      if (resource.identityObserved && !binding.firstFstatCallRef || resource.state !== "not_acquired" && !binding.acquisitionCallRef) return fail();
      result.push(binding);
    }
    for (const [ordinal, call] of facts.calls.entries()) {
      if (call.nativeReturnState !== "returned" || call.returned !== "descriptor_acquired_redacted") continue;
      if (!result.some(binding => binding.nativeLifetimeId === call.resourceLifetimeId
        && binding.acquisitionCallRef?.effectId === effectId && binding.acquisitionCallRef.ordinal === ordinal)) return fail();
    }
    this.#nonce = facts.snapshot.sessionNonce;
    this.#bindings.clear();
    for (const [slot, binding] of next) this.#bindings.set(slot, binding);
    return Object.freeze(result);
  }

  binding(resourceSlotId: string): HostOfficeDirectoryResourceBindingV2 {
    return this.#bindings.get(resourceSlotId) ?? fail();
  }
}
