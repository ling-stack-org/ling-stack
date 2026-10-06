import { SqliteRunStore, resolveStoragePaths, type RunStore } from "@ling-stack/core";
import { createOriginalOfficeHostBridgeForComposition, sealOriginalOfficeHostBridgeForComposition,
  mintOriginalOfficeDirectoryAuthorityV2, type OriginalOfficeHostBridgeSetup,
  type OriginalOfficeDirectoryAuthorityV2 } from "@ling-stack/core/original-office-host-bridge";
import type { RunStoreFactory } from "../../runtime/store-registry.js";
import { isOriginalRuntimeSupervisorOfficeRoot, retainOriginalRuntimeSupervisorOfficeStoreBridge,
  type RuntimeSupervisor } from "../../runtime/supervisor.js";
import { isOwnedOfficeLocalNativeRuntime, captureOriginalOfficeDirectoryRuntimeCustody,
  assertOriginalOfficeDirectoryRuntimeBinding, type OfficeLocalNativeRuntime,
  closeOriginalOfficeDirectoryRuntimeWindow, assertOriginalOfficeDirectoryRuntimeWindowClosed,
  type OfficeLocalNativeTypedScope } from "./office-local-native-runtime.js";

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
function requireOriginal(value: unknown): asserts value {
  if (!value) throw new Error("office_local_directory_core_composition_invalid");
}

/** Trusted startup factory. It constructs the exact Store; no caller factory/endpoint/reader retrofit. */
export function createOriginalOfficeDirectoryStoreFactory(supervisor: RuntimeSupervisor): RunStoreFactory {
  requireOriginal(isOriginalRuntimeSupervisorOfficeRoot(supervisor));
  return (cwd: string): RunStore => {
    requireOriginal(isOriginalRuntimeSupervisorOfficeRoot(supervisor));
    const { reader, setup } = createOriginalOfficeHostBridgeForComposition();
    const store = new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, originalOfficeHostBridge: reader });
    try {
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
      return store;
    } catch (error) {
      try { store.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], "office_local_directory_core_composition_close_unknown"); }
      throw error;
    }
  };
}

/** Fixed readers validate the original cached runtime and private scope before minting the opaque Core handle. */
export function captureOriginalOfficeDirectoryAuthorityV2(store: RunStore, runtime: OfficeLocalNativeRuntime,
  scope: OfficeLocalNativeTypedScope): OriginalOfficeDirectoryAuthorityV2 {
  const composition = stores.get(store);
  requireOriginal(composition && runtime.store === store && runtime.supervisor === composition.supervisor
    && isOriginalRuntimeSupervisorOfficeRoot(composition.supervisor) && isOwnedOfficeLocalNativeRuntime(runtime));
  const runtimeCustody = captureOriginalOfficeDirectoryRuntimeCustody(runtime, scope);
  const custodyRef = Object.freeze({});
  custodies.set(custodyRef, Object.freeze({ store, runtime, runtimeCustody }));
  return mintOriginalOfficeDirectoryAuthorityV2(composition.setup, custodyRef);
}
