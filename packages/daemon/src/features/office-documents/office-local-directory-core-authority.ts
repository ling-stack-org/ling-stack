import { SqliteRunStore, resolveStoragePaths, type RunStore } from "@ling-stack/core";
import { createOriginalOfficeHostBridgeForComposition, sealOriginalOfficeHostBridgeForComposition,
  mintOriginalOfficeDirectoryAuthorityV2, type OriginalOfficeHostBridgeSetup,
  type OriginalOfficeDirectoryAuthorityV2 } from "@ling-stack/core/original-office-host-bridge";
import type { RunStoreFactory } from "../../runtime/store-registry.js";
import { isOriginalRuntimeSupervisorOfficeRoot, retainOriginalRuntimeSupervisorOfficeStoreBridge,
  isRuntimeSupervisorOfficeCacheEntry, type RuntimeSupervisor } from "../../runtime/supervisor.js";
import { isOwnedOfficeLocalNativeRuntime, captureOriginalOfficeDirectoryRuntimeCustody,
  assertOriginalOfficeDirectoryRuntimeBinding, type OfficeLocalNativeRuntime,
  closeOriginalOfficeDirectoryRuntimeWindow, assertOriginalOfficeDirectoryRuntimeWindowClosed,
  releaseOriginalOfficeDirectoryRuntimeLeaseV2,
  assertOriginalOfficeDirectoryRuntimeLeaseReleasedV2,
  type OfficeLocalNativeTypedScope } from "./office-local-native-runtime.js";
import type { HostOfficeLocalDirectoryCloseClaimV2, HostOfficeLocalDirectoryCommittedPairV2 } from "@ling-stack/core";
import type { SecretResolver } from "@ling-stack/core";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { createOriginalDelegationStoreComposition, type OriginalDelegationLifecycle } from "../harness/delegations/store-composition.js";
import { createDelegatedRunDispatchAuthority } from "../harness/delegations/delegated-run-dispatch.js";

interface CompositionStore {
  readonly supervisor: RuntimeSupervisor;
  readonly setup: OriginalOfficeHostBridgeSetup;
}
interface Custody {
  readonly store: RunStore;
  readonly runtime: OfficeLocalNativeRuntime;
  readonly runtimeCustody: object;
}
const stores = new WeakMap<RunStore, CompositionStore>();
const custodies = new WeakMap<object, Custody>();
const authorityCustodies = new WeakMap<OriginalOfficeDirectoryAuthorityV2, Custody>();
function requireOriginal(value: unknown): asserts value {
  if (!value) throw new Error("office_local_directory_core_composition_invalid");
}

/** Trusted startup factory. It constructs the exact Store; no caller factory/endpoint/reader retrofit. */
export function createOriginalOfficeDirectoryStoreFactory(supervisor: RuntimeSupervisor,
  delegationDependencies?: { readonly runnerRegistry: RunnerRegistry; readonly secretResolver: SecretResolver;
    readonly onDelegationStore?: (store: RunStore, lifecycle: OriginalDelegationLifecycle) => void }): RunStoreFactory {
  requireOriginal(isOriginalRuntimeSupervisorOfficeRoot(supervisor));
  return (cwd: string): RunStore => {
    requireOriginal(isOriginalRuntimeSupervisorOfficeRoot(supervisor));
    const { reader, setup } = createOriginalOfficeHostBridgeForComposition();
    const features = supervisor.getHarnessFeatures();
    // Ordinary Pi suspension uses the same constructor-private writer even
    // when dynamic creation is disabled. This does not enable that producer.
    const needsRunLifecycle = features.delegations.mode !== "off" || features.continuations.mode === "enforce";
    const delegation = needsRunLifecycle && delegationDependencies ? createOriginalDelegationStoreComposition({ supervisor,
        runnerRegistry: delegationDependencies.runnerRegistry, secretResolver: delegationDependencies.secretResolver,
        delegatedDispatchAuthority: createDelegatedRunDispatchAuthority() }) : undefined;
    if (supervisor.getHarnessFeatures().delegations.mode !== "off" && !delegation) throw new Error("delegation.host_composition_unavailable");
    const store = new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, originalOfficeHostBridge: reader,
      ...(delegation ? { delegationHostBinding: delegation.binding } : {}) });
    try {
      delegation?.bindExactStore(store);
      const originalCustody = (custodyRef: object): Custody => {
        const original = custodies.get(custodyRef);
        requireOriginal(original && original.store === store && original.runtime.store === store
          && original.runtime.supervisor === supervisor
          && isOwnedOfficeLocalNativeRuntime(original.runtime));
        return original;
      };
      const endpoint = Object.freeze({ assertBinding(custodyRef: object, expected: Parameters<typeof assertOriginalOfficeDirectoryRuntimeBinding>[2]): void {
        const original = originalCustody(custodyRef);
        requireOriginal(isOriginalRuntimeSupervisorOfficeRoot(supervisor));
        assertOriginalOfficeDirectoryRuntimeBinding(original.runtime, original.runtimeCustody, expected);
      }, closeBoundWindow(custodyRef: object, expected: Parameters<typeof assertOriginalOfficeDirectoryRuntimeBinding>[2]): void {
        const original = originalCustody(custodyRef);
        closeOriginalOfficeDirectoryRuntimeWindow(original.runtime, original.runtimeCustody, expected);
      }, assertClosedBoundWindow(custodyRef: object, expected: Parameters<typeof assertOriginalOfficeDirectoryRuntimeBinding>[2]): void {
        const original = originalCustody(custodyRef);
        assertOriginalOfficeDirectoryRuntimeWindowClosed(original.runtime, original.runtimeCustody, expected);
      } });
      sealOriginalOfficeHostBridgeForComposition(setup, store, endpoint);
      retainOriginalRuntimeSupervisorOfficeStoreBridge(supervisor, store, setup);
      stores.set(store, Object.freeze({ supervisor, setup }));
      if (delegation) delegationDependencies?.onDelegationStore?.(store, delegation.lifecycle);
      return store;
    } catch (error) {
      try { store.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], "office_local_directory_core_composition_close_unknown"); }
      throw error;
    }
  };
}

/**
 * Resolve only the exact Store's startup-owned Supervisor runtime. No options,
 * provider callback, copied Store or public runtime field can enroll custody.
 * An unconfigured original Host returns undefined; it never enables V1 fallback.
 */
export function readOriginalOfficeDirectoryNativeRuntime(store: RunStore): OfficeLocalNativeRuntime | undefined {
  const composition = stores.get(store);
  requireOriginal(composition && isOriginalRuntimeSupervisorOfficeRoot(composition.supervisor));
  const runtime = composition.supervisor.getOfficeLocalNativeRuntime(store.paths.cwd, store);
  if (runtime === undefined) return undefined;
  requireOriginal(isOwnedOfficeLocalNativeRuntime(runtime) && runtime.store === store
    && runtime.supervisor === composition.supervisor
    && isRuntimeSupervisorOfficeCacheEntry(composition.supervisor, store, runtime.registry, runtime));
  return runtime;
}

/** Fixed readers validate the original cached runtime and private scope before minting the opaque Core handle. */
export function captureOriginalOfficeDirectoryAuthorityV2(store: RunStore, runtime: OfficeLocalNativeRuntime,
  scope: OfficeLocalNativeTypedScope): OriginalOfficeDirectoryAuthorityV2 {
  const composition = stores.get(store);
  requireOriginal(composition && runtime.store === store && runtime.supervisor === composition.supervisor
    && isOriginalRuntimeSupervisorOfficeRoot(composition.supervisor) && isOwnedOfficeLocalNativeRuntime(runtime));
  const runtimeCustody = captureOriginalOfficeDirectoryRuntimeCustody(runtime, scope);
  const custodyRef = Object.freeze({});
  const original = Object.freeze({ store, runtime, runtimeCustody });
  custodies.set(custodyRef, original);
  const authority = mintOriginalOfficeDirectoryAuthorityV2(composition.setup, custodyRef);
  authorityCustodies.set(authority, original);
  return authority;
}

/** Keep raw custody private: exposing it would allow bypassing the Core close-claim gate. */
function readOriginalOfficeDirectoryAuthorityCustodyForReleaseV2(authority: OriginalOfficeDirectoryAuthorityV2): Readonly<Custody> {
  const original = authorityCustodies.get(authority);
  requireOriginal(original);
  return original;
}

/** Validate an actual private composition authority before the original Tracker requires its lease history. */
export function assertOriginalOfficeDirectoryLeaseAuthorityV2(authority: OriginalOfficeDirectoryAuthorityV2, store: object): void {
  const original = readOriginalOfficeDirectoryAuthorityCustodyForReleaseV2(authority);
  requireOriginal(original.store === store);
}

/** Release exactly the original lease after Core commit; no caller window, expected DTO or callback is admitted. */
export function releaseOriginalOfficeDirectoryLeaseV2(authority: OriginalOfficeDirectoryAuthorityV2,
  grant: HostOfficeLocalDirectoryCommittedPairV2, claim: HostOfficeLocalDirectoryCloseClaimV2): void {
  const original = readOriginalOfficeDirectoryAuthorityCustodyForReleaseV2(authority);
  releaseOriginalOfficeDirectoryRuntimeLeaseV2(original.runtime, original.runtimeCustody, authority, grant, claim);
}

/** Pure completed-release history for the same original authority/grant/claim; never performs a first deletion. */
export function assertOriginalOfficeDirectoryLeaseReleasedV2(authority: OriginalOfficeDirectoryAuthorityV2,
  grant: HostOfficeLocalDirectoryCommittedPairV2, claim: HostOfficeLocalDirectoryCloseClaimV2): void {
  const original = readOriginalOfficeDirectoryAuthorityCustodyForReleaseV2(authority);
  assertOriginalOfficeDirectoryRuntimeLeaseReleasedV2(original.runtime, original.runtimeCustody, authority, grant, claim);
}
