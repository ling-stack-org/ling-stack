import type { SqliteRuntimeHostCapacityStore } from "./storage/sqlite/runtime-host-capacity-store.js";

export { HostRunCapacityStore, createHostRunCapacityStore } from "./storage/host-run-capacity-store.js";
export { RuntimeHostCapacityBridge } from "./runtime-host-capacity-bridge.js";
export type { ReserveRuntimeHostCapacityAttemptResult } from "./runtime-host-capacity-bridge.js";
export type * from "./host-run-capacity-types.js";
export type * from "./runtime-host-capacity-types.js";
export type { HostOperationSource } from "./host-operation-journal-types.js";

declare const bindingBrand: unique symbol;

/** Opaque constructor custody; a Store cannot recover the caller's workspace accessor. */
export interface RuntimeHostCapacityStoreBinding { readonly [bindingBrand]: true }

export type RuntimeHostCapacityJournal = Pick<SqliteRuntimeHostCapacityStore,
  "getWorkspaceIdentity" | "assertOutsideTransaction" | "prepareAttempt" | "prepareExecution" | "prepareWorkflowStart" | "prepareDelegationSpawn" | "prepareDelegationPending"
  | "prepareApprovalResumePending" | "prepareUserInputContinuation" | "getIntent" | "getAttemptIntent" | "attachReservation"
  | "consumeDispatchGateWithinTransaction" | "consumeDispatchGate" | "bindDelegationSourceWithinTransaction"
  | "bindApprovalResumeSourceWithinTransaction" | "bindUserInputSourceWithinTransaction"
  | "prepareNoDispatchRelease" | "prepareStoppedRelease" | "getRelease"
  | "listPendingReleases" | "acknowledgeRelease">;

interface BindingState {
  owner?: object;
  factory?: (workspaceId: string) => RuntimeHostCapacityJournal;
  readonly workspaces: Map<string, RuntimeHostCapacityJournal>;
  retired: boolean;
}

const bindings = new WeakMap<RuntimeHostCapacityStoreBinding, BindingState>();
const fail = (): never => { throw new Error("runtime_host_capacity.binding_invalid"); };

/** Only the creator retains the workspace journal accessor, independent of the opaque handle. */
export function createRuntimeHostCapacityStoreBinding(): {
  readonly binding: RuntimeHostCapacityStoreBinding;
  readonly workspace: (workspaceId: string) => RuntimeHostCapacityJournal;
} {
  const binding = Object.freeze({}) as RuntimeHostCapacityStoreBinding;
  const state: BindingState = { workspaces: new Map(), retired: false };
  bindings.set(binding, state);
  return Object.freeze({ binding,
    workspace(workspaceId: string): RuntimeHostCapacityJournal {
      if (state.retired || !state.factory || !state.owner) return fail();
      const journal = state.factory(workspaceId);
      const existing = state.workspaces.get(workspaceId);
      if (existing) return existing;
      const owner = state.owner;
      const invoke = <K extends keyof RuntimeHostCapacityJournal>(method: K): RuntimeHostCapacityJournal[K] => {
        const call = journal[method].bind(journal);
        return ((...args: unknown[]) => {
          if (state.retired || state.owner !== owner || !state.factory) return fail();
          return Reflect.apply(call, undefined, args);
        }) as RuntimeHostCapacityJournal[K];
      };
      const facade = Object.freeze({
        getWorkspaceIdentity: invoke("getWorkspaceIdentity"),
        assertOutsideTransaction: invoke("assertOutsideTransaction"),
        prepareAttempt: invoke("prepareAttempt"),
        prepareExecution: invoke("prepareExecution"),
        prepareWorkflowStart: invoke("prepareWorkflowStart"),
        prepareDelegationSpawn: invoke("prepareDelegationSpawn"),
        prepareDelegationPending: invoke("prepareDelegationPending"),
        prepareApprovalResumePending: invoke("prepareApprovalResumePending"),
        prepareUserInputContinuation: invoke("prepareUserInputContinuation"),
        consumeDispatchGate: invoke("consumeDispatchGate"),
        consumeDispatchGateWithinTransaction: invoke("consumeDispatchGateWithinTransaction"),
        bindDelegationSourceWithinTransaction: invoke("bindDelegationSourceWithinTransaction"),
        bindApprovalResumeSourceWithinTransaction: invoke("bindApprovalResumeSourceWithinTransaction"),
        bindUserInputSourceWithinTransaction: invoke("bindUserInputSourceWithinTransaction"),
        getIntent: invoke("getIntent"),
        getAttemptIntent: invoke("getAttemptIntent"),
        attachReservation: invoke("attachReservation"),
        prepareNoDispatchRelease: invoke("prepareNoDispatchRelease"),
        prepareStoppedRelease: invoke("prepareStoppedRelease"),
        getRelease: invoke("getRelease"),
        listPendingReleases: invoke("listPendingReleases"),
        acknowledgeRelease: invoke("acknowledgeRelease"),
      });
      state.workspaces.set(workspaceId, facade);
      return facade;
    },
  });
}

/** A binding belongs to one exact constructor, including failed construction and close/reopen. */
export function captureRuntimeHostCapacityStoreBinding(binding: RuntimeHostCapacityStoreBinding, owner: object): {
  readonly install: (factory: (workspaceId: string) => RuntimeHostCapacityJournal) => void;
  readonly retire: () => void;
} {
  const state = bindings.get(binding);
  if (!state || state.retired || state.owner) return fail();
  state.owner = owner;
  return Object.freeze({
    install(factory: (workspaceId: string) => RuntimeHostCapacityJournal): void {
      if (state.retired || state.owner !== owner || state.factory || typeof factory !== "function") return fail();
      state.factory = factory;
    },
    retire(): void {
      state.retired = true;
      state.factory = undefined;
      state.workspaces.clear();
    },
  });
}
