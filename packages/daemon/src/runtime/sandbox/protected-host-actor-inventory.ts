import { CORE_OFFICIAL_SKILL_GIT_ENTRY, CORE_EXTERNAL_WORK_SCHEDULER_ENTRY,
  bindCoreOriginalProcessGuard, readCoreOriginalProcessEntry,
  type CoreOriginalProcessEntry, type CoreOriginalProcessRecord } from "@ling-stack/core";
import { assertOriginalProtectedHostActorDomainHistoryCurrent, commitOriginalProtectedHostActorDomainHistory,
  assertOriginalProtectedHostActorHistoryEnrollment, readOriginalProtectedHostActorLaunchDomain,
  type ProtectedHostActorPreparation, type ProtectedHostStageRegistry } from "./protected-host-staging.js";
import type { ProtectedHostActorDomain } from "./protected-host-actor-domain.js";
import { isDeepStrictEqual } from "node:util";
import { readConsumedOriginalPackagedCodesignHostProof, readOriginalPackagedCodesignHostProof,
  retainOriginalPackagedCodesignHostProof, type OriginalPackagedCodesignHostProof } from "./packaged-codesign-host-source.js";

/** Audited native-entry inventory. These names describe source-owned producers, not runner labels. */
function createActorEntryKinds() { return Object.freeze({
  macos_native_command: "controlled",
  unified_exec_raw: "controlled",
  // A distinct DB-backed confirmed source, never the absence of a native dispatch.
  unified_exec_full_access: "user_external",
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
  // Fixed OS paths are not an audited protection domain or descendant-closure proof.
  keychain_security: "controlled",
  packaged_codesign: "controlled",
  docker_probe: "controlled",
} as const); }
// Source modules can reach this factory during the staging/manifest import
// cycle. Hoisted lazy state keeps the one exact list/ownership map intact.
var actorEntryKinds: ReturnType<typeof createActorEntryKinds> | undefined;
function readActorEntryKinds(): ReturnType<typeof createActorEntryKinds> {
  return actorEntryKinds ??= createActorEntryKinds();
}
export const PROTECTED_HOST_ACTOR_ENTRIES = readActorEntryKinds();
export type ProtectedHostActorEntryId = keyof typeof PROTECTED_HOST_ACTOR_ENTRIES;
declare const entryBrand: unique symbol;
export interface ProtectedHostActorEntry<Args extends unknown[] = unknown[], Result = unknown> {
  readonly [entryBrand]: true;
  readonly entryId: ProtectedHostActorEntryId;
  /** Read-only preflight, before the Host journal claims launch. Never retires or creates process history. */
  assertMayInvoke(actor: ProtectedHostActorPreparation | undefined): void;
  /** This original wrapper performs the gate itself and invokes only its captured producer. */
  invoke(actor: ProtectedHostActorPreparation | undefined, ...args: Args): Result;
}
interface EntryState {
  readonly entryId: ProtectedHostActorEntryId;
  readonly originalProducer: (...args: never[]) => unknown;
  readonly invoke: (...args: never[]) => unknown;
  readonly assertMayInvoke: ProtectedHostActorEntry["assertMayInvoke"];
  readonly registries: Set<WeakRef<ProtectedHostStageRegistry>>;
  /** Catch provenance only, never process-history or no-start authority. */
  readonly launchRefusals: WeakSet<object>;
  readonly coreSource?: CoreOriginalProcessEntry;
  readonly certifiedHostHistory: Set<OriginalPackagedCodesignHostProof>;
  actorDomainHistory?: OriginalProtectedHostActorDomainHistory;
  historyEpoch: object;
  unboundLaunchEntered: boolean;
}
var originalEntries: WeakMap<object, EntryState> | undefined;
function originalEntryStates(): WeakMap<object, EntryState> { return originalEntries ??= new WeakMap(); }
declare const actorDomainHistoryBrand: unique symbol;
export interface OriginalProtectedHostActorDomainHistory { readonly [actorDomainHistoryBrand]: true }
const originalActorDomainHistories = new WeakMap<OriginalProtectedHostActorDomainHistory, Readonly<{
  entry: ProtectedHostActorEntry; domain: ProtectedHostActorDomain | undefined; epoch: object;
}>>();
function requireEntry(value: unknown): void { if (!value) throw new Error("protected_host_actor_entry_invalid"); }

/** Only the canonical physical launcher can issue domain history; a same-name factory cannot. */
function captureActorDomainHistory(entry: ProtectedHostActorEntry, state: EntryState,
  actor: ProtectedHostActorPreparation): OriginalProtectedHostActorDomainHistory {
  const current = readOriginalProtectedHostActorLaunchDomain(actor, entry);
  const prior = state.actorDomainHistory && readOriginalProtectedHostActorDomainHistory(entry, state.actorDomainHistory);
  let domain: ProtectedHostActorDomain | undefined;
  if (current && !state.unboundLaunchEntered && (!prior || isDeepStrictEqual(prior.backend, current.backend))) {
    const roots = [...new Set([...(prior?.staticReadRoots ?? []), ...current.staticReadRoots])];
    if (roots.length <= 128) domain = Object.freeze({ backend: current.backend, staticReadRoots: Object.freeze(roots) });
  }
  const history = Object.freeze({}) as OriginalProtectedHostActorDomainHistory;
  originalActorDomainHistories.set(history, Object.freeze({ entry, domain, epoch: state.historyEpoch }));
  return history;
}

/** Immutable permission over-approximation only, never foreign Run, source or execution authority. */
export function readOriginalProtectedHostActorDomainHistory(entry: ProtectedHostActorEntry,
  history: OriginalProtectedHostActorDomainHistory): ProtectedHostActorDomain | undefined {
  const original = originalActorDomainHistories.get(history);
  requireEntry(original && original.entry === entry);
  return original!.domain;
}

function forAttachedRegistries(state: EntryState, effect: (registry: ProtectedHostStageRegistry) => void): void {
  for (const reference of state.registries) {
    const registry = reference.deref();
    if (registry) effect(registry);
    else state.registries.delete(reference);
  }
}

function assertAttachedRegistries(entry: ProtectedHostActorEntry, state: EntryState,
  actor: ProtectedHostActorPreparation | undefined, trackEntry = true): void {
  for (const reference of state.registries) {
    const registry = reference.deref();
    if (registry) registry.assertActorEntryLaunchCurrent(entry, actor, trackEntry);
    else state.registries.delete(reference);
  }
}

/**
 * Called by the actual producer module, with its module-private native producer.
 * A separate string/flag registration cannot claim installation: the Supervisor
 * manifest must retain the exact exported object, and native execution goes
 * through this object's immutable original invoke method.
 */
export function defineProtectedHostActorEntry<Args extends unknown[], Result>(
  entryId: ProtectedHostActorEntryId, originalProducer: (...args: Args) => Result,
  consumeOriginalArgs?: (...args: Args) => void,
): ProtectedHostActorEntry<Args, Result> {
  requireEntry(Object.hasOwn(readActorEntryKinds(), entryId) && typeof originalProducer === "function");
  requireEntry(consumeOriginalArgs === undefined || typeof consumeOriginalArgs === "function"
    && Object.prototype.toString.call(consumeOriginalArgs) !== "[object AsyncFunction]");
  const registries = new Set<WeakRef<ProtectedHostStageRegistry>>();
  let state: EntryState;
  const entry = Object.freeze({ entryId,
    assertMayInvoke(actor: ProtectedHostActorPreparation | undefined): void {
      if (actor && entryId === "macos_native_command") {
        const history = captureActorDomainHistory(entry as ProtectedHostActorEntry, state, actor);
        forAttachedRegistries(state, registry => assertOriginalProtectedHostActorDomainHistoryCurrent(registry,
          entry as ProtectedHostActorEntry, history));
        return;
      }
      assertAttachedRegistries(entry as ProtectedHostActorEntry, state, actor, false);
    },
    invoke(actor: ProtectedHostActorPreparation | undefined, ...args: Args): Result {
      // The actual source consumes its opaque single-use record before any gate.
      // Invalid records/callback results cannot poison coverage or gain denial provenance.
      if (consumeOriginalArgs) {
        let result: unknown;
        try { result = Reflect.apply(consumeOriginalArgs, undefined, args); }
        catch (error) {
          if (isWeakKey(error)) state.launchRefusals.delete(error);
          throw error;
        }
        if (result !== undefined) {
          observeOriginalPromise(result);
          throw new Error("protected_host_actor_entry_invalid");
        }
      }
      let hostProof: OriginalPackagedCodesignHostProof | undefined;
      let actorHistory: OriginalProtectedHostActorDomainHistory | undefined;
      try {
        // This is a fixed direct reader. A generic same-name factory has neither
        // canonical entry identity nor the source's consumed private record.
        if (entryId === "packaged_codesign") {
          requireEntry(actor === undefined);
          hostProof = readConsumedOriginalPackagedCodesignHostProof(entry as ProtectedHostActorEntry, args);
        }
      } catch (error) { if (isWeakKey(error)) state.launchRefusals.delete(error); throw error; }
      // Every attached original Supervisor must allow the same source proof
      // before any history/domain/custody commit occurs.
      try {
        if (actor && entryId === "macos_native_command")
          actorHistory = captureActorDomainHistory(entry as ProtectedHostActorEntry, state, actor);
        if (hostProof) {
          for (const reference of registries) {
            const registry = reference.deref();
            if (registry) registry.assertOriginalHostProofBatch([{ entry: entry as ProtectedHostActorEntry, proof: hostProof }]);
            else registries.delete(reference);
          }
        } else if (actorHistory) forAttachedRegistries(state, registry =>
          assertOriginalProtectedHostActorDomainHistoryCurrent(registry, entry as ProtectedHostActorEntry, actorHistory!));
        else assertAttachedRegistries(entry as ProtectedHostActorEntry, state, actor, false);
        if (actorHistory && originalActorDomainHistories.get(actorHistory)!.epoch !== state.historyEpoch)
          throw new Error("protected_host_actor_history_changed");
      }
      catch (error) {
        if (isWeakKey(error)) state.launchRefusals.add(error);
        throw error;
      }
      // All registries allowed the read-only preflight. Only now enter the
      // original producer phase; a later registry's refusal creates no history.
      try {
        if (hostProof) {
          try {
            retainOriginalPackagedCodesignHostProof(entry as ProtectedHostActorEntry, hostProof);
            state.certifiedHostHistory.add(hostProof);
            for (const reference of registries) {
              const registry = reference.deref();
              if (registry) registry.commitOriginalHostProofBatch([{ entry: entry as ProtectedHostActorEntry, proof: hostProof }]);
              else registries.delete(reference);
            }
          } catch (error) {
            // An unexpected commit failure cannot leave a successful partial
            // fan-out or downgrade to raw execution. Permanent custody stays.
            state.unboundLaunchEntered = true;
            for (const reference of registries) reference.deref()?.markActorEntryCoverageUnknown();
            throw error;
          }
        } else if (actorHistory) {
          try {
            state.historyEpoch = Object.freeze({});
            state.actorDomainHistory = actorHistory;
            if (!readOriginalProtectedHostActorDomainHistory(entry as ProtectedHostActorEntry, actorHistory))
              state.unboundLaunchEntered = true;
            forAttachedRegistries(state, registry => commitOriginalProtectedHostActorDomainHistory(registry,
              entry as ProtectedHostActorEntry, actorHistory!));
          } catch (error) {
            state.unboundLaunchEntered = true;
            for (const reference of registries) reference.deref()?.markActorEntryCoverageUnknown();
            throw error;
          }
        } else if ((!registries.size || actor === undefined) && readActorEntryKinds()[entryId] === "controlled") {
          state.historyEpoch = Object.freeze({});
          state.unboundLaunchEntered = true;
          for (const reference of registries) {
            const registry = reference.deref();
            if (registry) registry.markActorEntryCoverageUnknown();
            else registries.delete(reference);
          }
        }
        const result = originalProducer(...args);
        observeOriginalPromise(result, error => { if (isWeakKey(error)) state.launchRefusals.delete(error); });
        return result;
      } catch (error) {
        // An entered notification failure is not a new readonly refusal,
        // even if it reuses that refusal's Error. Sticky history stays intact.
        if (isWeakKey(error)) state.launchRefusals.delete(error);
        throw error;
      }
    },
  }) as ProtectedHostActorEntry<Args, Result>;
  state = { entryId, originalProducer: originalProducer as (...args: never[]) => unknown,
    invoke: entry.invoke as (...args: never[]) => unknown, assertMayInvoke: entry.assertMayInvoke,
    registries, launchRefusals: new WeakSet(), certifiedHostHistory: new Set(), historyEpoch: Object.freeze({}), unboundLaunchEntered: false };
  originalEntryStates().set(entry, state);
  return entry;
}

/**
 * Dependency inversion for the two actual Core-owned producers. The Core entry
 * retains its private record factory and native producer; this bridge only gates
 * that entry, including direct Core calls. No replacement launch callback exists.
 */
export function defineCoreProtectedHostActorEntry<Result>(coreSource: CoreOriginalProcessEntry<Result>):
  ProtectedHostActorEntry<[CoreOriginalProcessRecord], Result> {
  requireEntry(coreSource === CORE_OFFICIAL_SKILL_GIT_ENTRY || coreSource === CORE_EXTERNAL_WORK_SCHEDULER_ENTRY);
  const source = readCoreOriginalProcessEntry(coreSource);
  const entryId = source.sourceId;
  let state: EntryState;
  const entry = Object.freeze({ entryId,
    assertMayInvoke(actor: ProtectedHostActorPreparation | undefined): void {
      requireEntry(actor === undefined); // No certified Core hook profile yet; cannot borrow a Run actor.
      assertAttachedRegistries(entry as ProtectedHostActorEntry, state, undefined, false);
    },
    invoke(actor: ProtectedHostActorPreparation | undefined, record: CoreOriginalProcessRecord): Result {
      requireEntry(actor === undefined);
      return coreSource.invoke(record); // Every valid record must enter the Core-owned guard below.
    },
  }) as ProtectedHostActorEntry<[CoreOriginalProcessRecord], Result>;
  state = { entryId, originalProducer: coreSource.invoke as (...args: never[]) => unknown,
    invoke: entry.invoke as (...args: never[]) => unknown, assertMayInvoke: entry.assertMayInvoke,
    registries: new Set(), launchRefusals: new WeakSet(), coreSource, certifiedHostHistory: new Set(),
    historyEpoch: Object.freeze({}), unboundLaunchEntered: source.nativeEntryEntered };
  originalEntryStates().set(entry, state);
  bindCoreOriginalProcessGuard(coreSource, Object.freeze({
    // All registries must allow this invocation before any unknown history is
    // created. An earlier no-stage registry must not be poisoned by a later
    // active-stage refusal of a genuinely never-entered producer.
    assertMayLaunch(): void { assertAttachedRegistries(entry as ProtectedHostActorEntry, state, undefined, false); },
    nativeEntryEntered(): void {
      state.unboundLaunchEntered = true;
      state.historyEpoch = Object.freeze({});
      for (const reference of state.registries) {
        const registry = reference.deref();
        if (registry) registry.markActorEntryCoverageUnknown();
        else state.registries.delete(reference);
      }
    },
  }));
  return entry;
}

/** Reject clones, accessors, replacement methods, unknown names and duplicate manifest slots. */
export function readProtectedHostActorEntry(entry: ProtectedHostActorEntry): Readonly<{
  entryId: ProtectedHostActorEntryId; kind: "controlled" | "user_external" | "system_bootstrap";
}> {
  const state = originalEntryStates().get(entry);
  const descriptors = Object.getOwnPropertyDescriptors(entry);
  requireEntry(state && Object.isFrozen(entry) && descriptors.entryId?.value === state.entryId
    && descriptors.invoke?.value === state.invoke && Object.hasOwn(descriptors.invoke, "value"));
  requireEntry(descriptors.assertMayInvoke?.value === state!.assertMayInvoke && Object.hasOwn(descriptors.assertMayInvoke, "value"));
  if (state!.coreSource) requireEntry(readCoreOriginalProcessEntry(state!.coreSource).sourceId === state!.entryId);
  return Object.freeze({ entryId: state!.entryId, kind: readActorEntryKinds()[state!.entryId] });
}

/** Only a denial from this exact original entry's read-only gate may survive a business catch. */
export function isProtectedHostActorEntryLaunchRefusal(entry: ProtectedHostActorEntry, error: unknown): boolean {
  readProtectedHostActorEntry(entry);
  return isWeakKey(error) && originalEntryStates().get(entry)!.launchRefusals.has(error);
}

function isWeakKey(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/** Observe native Promise rejection without changing its identity or invoking arbitrary thenables/getters. */
function observeOriginalPromise(value: unknown, rejected?: (error: unknown) => void): void {
  if (!isWeakKey(value)) return;
  try {
    void Promise.prototype.then.call(value, () => undefined, (error: unknown) => { rejected?.(error); });
  } catch { /* Ordinary values and thenables are not native Promise receivers. */ }
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
    const histories: { entry: ProtectedHostActorEntry; proof: OriginalPackagedCodesignHostProof }[] = [];
    for (const entry of next.values()) for (const proof of originalEntryStates().get(entry)!.certifiedHostHistory) {
      try {
        requireEntry(readOriginalPackagedCodesignHostProof(entry, proof).phase === "retained");
        histories.push({ entry, proof });
      } catch (error) { registry.markActorEntryCoverageUnknown(); throw error; }
    }
    // Aggregate preflight includes every historical domain before mutation.
    // A newly bound registry gets its own private epoch; no old binding is reused.
    const actorHistories: { entry: ProtectedHostActorEntry; history: OriginalProtectedHostActorDomainHistory }[] = [];
    for (const entry of next.values()) {
      const history = originalEntryStates().get(entry)!.actorDomainHistory;
      if (history) actorHistories.push({ entry, history });
    }
    assertOriginalProtectedHostActorHistoryEnrollment(registry, histories, actorHistories);
    for (const [id, entry] of next) {
      this.#entries.set(id, entry);
      const state = originalEntryStates().get(entry)!;
      state.registries.add(new WeakRef(registry));
      if (state.unboundLaunchEntered || (state.coreSource && readCoreOriginalProcessEntry(state.coreSource).nativeEntryEntered)) {
        registry.markActorEntryCoverageUnknown();
      }
    }
    try { registry.commitOriginalHostProofBatch(histories); }
    catch (error) { registry.markActorEntryCoverageUnknown(); throw error; }
    try {
      for (const entry of next.values()) {
        const history = originalEntryStates().get(entry)!.actorDomainHistory;
        if (history) commitOriginalProtectedHostActorDomainHistory(registry, entry, history);
      }
    } catch (error) { registry.markActorEntryCoverageUnknown(); throw error; }
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
