import type { ProtectedHostActorPreparation, ProtectedHostStageRegistry } from "./protected-host-staging.js";

/** Audited native-entry inventory. These names describe source-owned producers, not runner labels. */
export const PROTECTED_HOST_ACTOR_ENTRIES = Object.freeze({
  macos_native_command: "controlled",
  unified_exec_raw: "controlled",
  native_input_capture: "controlled",
  mcp_host_stdio: "controlled",
  mcp_sdk_stdio: "controlled",
  workspace_changes_git: "controlled",
  managed_worktrees_git: "controlled",
  action_classifier_git: "controlled",
  // These physical producers belong to manual raw/UI routes, not run tools.
  // This classification does not claim a verified human gesture or isolation.
  workspace_terminal: "user_external",
  workspace_directory_picker: "user_external",
  external_work_scheduler: "controlled",
  official_skill_git: "controlled",
  workspace_file_launch: "user_external",
  local_path_open: "user_external",
  workspace_file_probe: "controlled",
  workspace_icon_probe: "controlled",
  keychain_security: "system_bootstrap",
  packaged_codesign: "system_bootstrap",
  docker_probe: "controlled",
} as const);
export type ProtectedHostActorEntryId = keyof typeof PROTECTED_HOST_ACTOR_ENTRIES;
declare const entryBrand: unique symbol;
export interface ProtectedHostActorEntry<Args extends unknown[] = unknown[], Result = unknown> {
  readonly [entryBrand]: true;
  readonly entryId: ProtectedHostActorEntryId;
  /** This original wrapper performs the gate itself and invokes only its captured producer. */
  invoke(actor: ProtectedHostActorPreparation | undefined, ...args: Args): Result;
}
interface EntryState {
  readonly entryId: ProtectedHostActorEntryId;
  readonly originalProducer: (...args: never[]) => unknown;
  readonly invoke: (...args: never[]) => unknown;
  readonly registries: Set<WeakRef<ProtectedHostStageRegistry>>;
  unboundLaunchEntered: boolean;
}
const originalEntries = new WeakMap<object, EntryState>();
const requireEntry = (value: unknown): void => { if (!value) throw new Error("protected_host_actor_entry_invalid"); };

/**
 * Called by the actual producer module, with its module-private native producer.
 * A separate string/flag registration cannot claim installation: the Supervisor
 * manifest must retain the exact exported object, and native execution goes
 * through this object's immutable original invoke method.
 */
export function defineProtectedHostActorEntry<Args extends unknown[], Result>(
  entryId: ProtectedHostActorEntryId, originalProducer: (...args: Args) => Result,
): ProtectedHostActorEntry<Args, Result> {
  requireEntry(Object.hasOwn(PROTECTED_HOST_ACTOR_ENTRIES, entryId) && typeof originalProducer === "function");
  const registries = new Set<WeakRef<ProtectedHostStageRegistry>>();
  let state: EntryState;
  const entry = Object.freeze({ entryId,
    invoke(actor: ProtectedHostActorPreparation | undefined, ...args: Args): Result {
      // Registry is not a call-site option. Every attached original Supervisor
      // gate participates; supplying another registry cannot bypass protection.
      for (const reference of registries) {
        const registry = reference.deref();
        if (registry) registry.assertActorEntryLaunchCurrent(entry as ProtectedHostActorEntry, actor);
        else registries.delete(reference);
      }
      if ((!registries.size || actor === undefined) && PROTECTED_HOST_ACTOR_ENTRIES[entryId] === "controlled") state.unboundLaunchEntered = true;
      return originalProducer(...args);
    },
  }) as ProtectedHostActorEntry<Args, Result>;
  state = { entryId, originalProducer: originalProducer as (...args: never[]) => unknown,
    invoke: entry.invoke as (...args: never[]) => unknown, registries, unboundLaunchEntered: false };
  originalEntries.set(entry, state);
  return entry;
}

/** Reject clones, accessors, replacement methods, unknown names and duplicate manifest slots. */
export function readProtectedHostActorEntry(entry: ProtectedHostActorEntry): Readonly<{
  entryId: ProtectedHostActorEntryId; kind: "controlled" | "user_external" | "system_bootstrap";
}> {
  const state = originalEntries.get(entry);
  const descriptors = Object.getOwnPropertyDescriptors(entry);
  requireEntry(state && Object.isFrozen(entry) && descriptors.entryId?.value === state.entryId
    && descriptors.invoke?.value === state.invoke && Object.hasOwn(descriptors.invoke, "value"));
  return Object.freeze({ entryId: state!.entryId, kind: PROTECTED_HOST_ACTOR_ENTRIES[state!.entryId] });
}

/** No runtime caller chooses exclusions; each exclusion is an independently audited source entry. */
export class ProtectedHostActorInventory {
  readonly #entries = new Map<ProtectedHostActorEntryId, ProtectedHostActorEntry>();
  #sealed = false;
  bindOriginalEntries(entries: readonly ProtectedHostActorEntry[], registry: ProtectedHostStageRegistry): void {
    if (this.#sealed || this.#entries.size) throw new Error("protected_host_actor_inventory_already_bound");
    const next = new Map<ProtectedHostActorEntryId, ProtectedHostActorEntry>();
    for (const entry of entries) {
      const { entryId } = readProtectedHostActorEntry(entry);
      if (next.has(entryId)) throw new Error("protected_host_actor_inventory_duplicate");
      next.set(entryId, entry);
    }
    for (const [id, entry] of next) {
      this.#entries.set(id, entry);
      const state = originalEntries.get(entry)!;
      state.registries.add(new WeakRef(registry));
      if (state.unboundLaunchEntered) registry.markActorEntryCoverageUnknown();
    }
    this.#sealed = true;
  }
  assertCurrent(): void {
    if (!this.#sealed || this.#entries.size !== Object.keys(PROTECTED_HOST_ACTOR_ENTRIES).length)
      throw new Error("protected_host_actor_inventory_incomplete");
    for (const [id, entry] of this.#entries) {
      if (readProtectedHostActorEntry(entry).entryId !== id) throw new Error("protected_host_actor_inventory_changed");
    }
  }
  assertOriginalSourceManifest(entries: readonly ProtectedHostActorEntry[]): void {
    this.assertCurrent();
    if (entries.length !== this.#entries.size || new Set(entries).size !== entries.length)
      throw new Error("protected_host_actor_source_manifest_incomplete");
    for (const entry of entries) this.assertOriginal(entry);
  }
  assertOriginal(entry: ProtectedHostActorEntry): ReturnType<typeof readProtectedHostActorEntry> {
    const facts = readProtectedHostActorEntry(entry);
    if (this.#entries.get(facts.entryId) !== entry) throw new Error("protected_host_actor_entry_unbound");
    return facts;
  }
}
