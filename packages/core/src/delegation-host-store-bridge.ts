import { DelegationWriteError, type DelegationWriteAuthorityPorts, type DelegationExecutionAuthority } from "./harness/delegation-write-types.js";
import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";
import type { SqliteDelegationWriteStore } from "./storage/sqlite/delegation-write-store.js";
import type { SqliteDelegationLifecycleStore } from "./storage/sqlite/delegation-lifecycle-store.js";
import type { DelegationLifecycleStorePorts } from "./harness/delegation-lifecycle-types.js";
import type { SqliteRunTerminalIntentStore } from "./storage/sqlite/run-terminal-intent-store.js";
import type { SqliteRunSuspensionStore } from "./storage/sqlite/run-suspension-store.js";
import type { SqliteRunSuspensionStopStore } from "./storage/sqlite/run-suspension-stop-store.js";
import type { SqliteRunSuspensionActivationStore } from "./storage/sqlite/run-suspension-activation-store.js";
import type { RootRunSuspensionStartObservationV1 } from "./run-suspension-start-types.js";
import type { SqliteRunSuspensionStartStore } from "./storage/sqlite/run-suspension-start-store.js";
import type { SqliteRunSuspensionDelegatedStore } from "./storage/sqlite/run-suspension-delegated-store.js";
import type { SqliteRunFinalSettlementStore } from "./storage/sqlite/run-final-settlement-store.js";
import type { RunFinalSettlementObservationV1 } from "./run-final-settlement-types.js";
import type { DelegationHostStoreBinding } from "./delegation-host-store-binding-types.js";

export type { DelegationHostStoreBinding } from "./delegation-host-store-binding-types.js";

/** Startup-only mutation custody. Not part of RunStore or a serialized route. */
export type DelegationHostWriter = Pick<SqliteDelegationWriteStore,
  "getRootDelegationBudget" | "getDelegationBudgetReservation" | "getDelegationBudgetCharge"
  | "freezeRootDelegationBudget" | "prepareDelegatedChild" | "reserveModelInvocation"
  | "settleModelInvocation" | "settleDelegatedChild">
  & Pick<SqliteDelegationLifecycleStore, "claimDelegatedChild" | "commitDelegatedChildStart"
    | "appendDelegationInstruction" | "classifyDelegatedChildRecovery"
    | "requestDelegatedChildInterrupt" | "commitDelegatedChildInterrupted"
    | "resumeDelegatedChild" | "commitDelegatedChildTerminal"
    | "commitDelegatedChildPreparation" | "getDelegatedChildPreparation" | "listDelegatedRecoveryCandidates">
  & Pick<SqliteRunTerminalIntentStore, "prepareRunTerminalIntent" | "getRunTerminalIntent" | "listUnfinishedRunTerminalIntents"
    | "reconcileRunTerminalIntent" | "acknowledgeRunTerminalIntent">
  & Pick<SqliteRunSuspensionStore, "requestRunSuspension" | "sealRunSuspension" | "getRunSuspensionForAttempt" | "getRunSuspension">
  & Pick<SqliteRunSuspensionStopStore, "beginRunSuspensionStop" | "commitRunSuspensionStopped" | "getRunSuspensionStop"
    | "readStoppedCompactionSuspensionRecovery" | "readStoppedFinalSettlementRecovery">
  & Pick<SqliteRunFinalSettlementStore, "commitRunFinalSettlement">
  & Pick<SqliteRunSuspensionActivationStore, "activateRootRunSuspension" | "getRootRunSuspensionActivation">
  & Pick<SqliteRunSuspensionStartStore, "acknowledgeRootRunSuspensionStart" | "getRootRunSuspensionStart">
  & Pick<SqliteRunSuspensionDelegatedStore, "activateDelegatedRunSuspension" | "getDelegatedRunSuspensionActivation" | "getDelegatedRunSuspensionStart">;

export interface DelegationHostStoreReaders extends DelegationWriteAuthorityPorts {
  readonly readRunnerStartObservation?: DelegationLifecycleStorePorts["readRunnerStartObservation"];
  readonly readExecutionPreparation?: DelegationLifecycleStorePorts["readExecutionPreparation"];
  /** Separate restart receiver. It never borrows or populates the live runtime registry's facts. */
  readonly readRootSuspensionRecoveryAuthority?: (runId: string, sourceFence: RuntimeAttemptFenceV1) => DelegationExecutionAuthority;
  readonly readRootSuspensionStartObservation?: (ref: unknown) => RootRunSuspensionStartObservationV1;
  readonly readRootSuspensionStartAuthority?: (runId: string, targetFence: RuntimeAttemptFenceV1) => DelegationExecutionAuthority;
  readonly readDelegatedSuspensionRecoveryAuthority?: (runId: string, sourceFence: RuntimeAttemptFenceV1) => DelegationExecutionAuthority;
  readonly readFinalSettlementObservation?: (ref: unknown) => RunFinalSettlementObservationV1;
}

interface BindingState {
  readonly readers: Required<DelegationHostStoreReaders>;
  owner?: object;
  writer?: DelegationHostWriter;
  retired: boolean;
}
const bindings = new WeakMap<DelegationHostStoreBinding, BindingState>();
const fail = (): never => { throw new DelegationWriteError("delegation.authority_invalid"); };

/** Verify the exact constructor owner without exposing its writer or database. */
export function assertDelegationHostStoreOwner(binding: DelegationHostStoreBinding, owner: object): void {
  const state = bindings.get(binding);
  if (!state || state.retired || state.owner !== owner || !state.writer) return fail();
}

/** The caller retains the only writer accessor; an ordinary Store cannot recover it. */
export function createDelegationHostStoreBinding(readers: DelegationHostStoreReaders): {
  readonly binding: DelegationHostStoreBinding;
  readonly writer: () => DelegationHostWriter;
} {
  const binding = Object.freeze({}) as DelegationHostStoreBinding;
  // Capture functions now. A mutable transport object cannot swap the authority
  // source after the owning Store has accepted this constructor binding.
  const capturedReaders = Object.freeze({
    readCapture: readers.readCapture.bind(readers),
    readCurrentAuthority: readers.readCurrentAuthority.bind(readers),
    readUsageReceipt: readers.readUsageReceipt.bind(readers),
    readChildReceipt: readers.readChildReceipt.bind(readers),
    readRunnerStartObservation: readers.readRunnerStartObservation?.bind(readers) ?? fail,
    readExecutionPreparation: readers.readExecutionPreparation?.bind(readers) ?? fail,
    readRootSuspensionRecoveryAuthority: readers.readRootSuspensionRecoveryAuthority?.bind(readers) ?? fail,
    readRootSuspensionStartObservation: readers.readRootSuspensionStartObservation?.bind(readers) ?? fail,
    readRootSuspensionStartAuthority: readers.readRootSuspensionStartAuthority?.bind(readers) ?? fail,
    readDelegatedSuspensionRecoveryAuthority: readers.readDelegatedSuspensionRecoveryAuthority?.bind(readers) ?? fail,
    readFinalSettlementObservation: readers.readFinalSettlementObservation?.bind(readers) ?? fail,
  });
  const state: BindingState = { readers: capturedReaders, retired: false };
  bindings.set(binding, state);
  return Object.freeze({ binding, writer: () => {
    if (state.retired || !state.writer) return fail();
    return state.writer;
  } });
}

/** One owning constructor only, including across close/reopen. */
export function captureDelegationHostStoreBinding(binding: DelegationHostStoreBinding, owner: object): {
  readonly readers: Required<DelegationHostStoreReaders>;
  readonly install: (writer: DelegationHostWriter) => void;
  readonly retire: () => void;
} {
  const state = bindings.get(binding);
  if (!state || state.retired || state.owner) return fail();
  state.owner = owner;
  return Object.freeze({ readers: state.readers,
    install(writer: DelegationHostWriter): void {
      if (state.retired || state.owner !== owner || state.writer) return fail();
      const invoke = <K extends keyof DelegationHostWriter>(method: K): DelegationHostWriter[K] => {
        const call = writer[method].bind(writer);
        return ((...args: unknown[]) => {
          if (state.retired || state.owner !== owner) return fail();
          return Reflect.apply(call, undefined, args);
        }) as DelegationHostWriter[K];
      };
      state.writer = Object.freeze({
        getRootDelegationBudget: invoke("getRootDelegationBudget"),
        getDelegationBudgetReservation: invoke("getDelegationBudgetReservation"),
        getDelegationBudgetCharge: invoke("getDelegationBudgetCharge"),
        freezeRootDelegationBudget: invoke("freezeRootDelegationBudget"),
        prepareDelegatedChild: invoke("prepareDelegatedChild"),
        reserveModelInvocation: invoke("reserveModelInvocation"),
        settleModelInvocation: invoke("settleModelInvocation"),
        settleDelegatedChild: invoke("settleDelegatedChild"),
        claimDelegatedChild: invoke("claimDelegatedChild"),
        commitDelegatedChildStart: invoke("commitDelegatedChildStart"),
        appendDelegationInstruction: invoke("appendDelegationInstruction"),
        classifyDelegatedChildRecovery: invoke("classifyDelegatedChildRecovery"),
        requestDelegatedChildInterrupt: invoke("requestDelegatedChildInterrupt"),
        commitDelegatedChildInterrupted: invoke("commitDelegatedChildInterrupted"),
        resumeDelegatedChild: invoke("resumeDelegatedChild"),
        commitDelegatedChildTerminal: invoke("commitDelegatedChildTerminal"),
        commitDelegatedChildPreparation: invoke("commitDelegatedChildPreparation"),
        getDelegatedChildPreparation: invoke("getDelegatedChildPreparation"),
        listDelegatedRecoveryCandidates: invoke("listDelegatedRecoveryCandidates"),
        prepareRunTerminalIntent: invoke("prepareRunTerminalIntent"),
        getRunTerminalIntent: invoke("getRunTerminalIntent"),
        listUnfinishedRunTerminalIntents: invoke("listUnfinishedRunTerminalIntents"),
        reconcileRunTerminalIntent: invoke("reconcileRunTerminalIntent"),
        acknowledgeRunTerminalIntent: invoke("acknowledgeRunTerminalIntent"),
        requestRunSuspension: invoke("requestRunSuspension"),
        sealRunSuspension: invoke("sealRunSuspension"),
        getRunSuspensionForAttempt: invoke("getRunSuspensionForAttempt"),
        getRunSuspension: invoke("getRunSuspension"),
        beginRunSuspensionStop: invoke("beginRunSuspensionStop"),
        commitRunSuspensionStopped: invoke("commitRunSuspensionStopped"),
        getRunSuspensionStop: invoke("getRunSuspensionStop"),
        readStoppedCompactionSuspensionRecovery: invoke("readStoppedCompactionSuspensionRecovery"),
        readStoppedFinalSettlementRecovery: invoke("readStoppedFinalSettlementRecovery"),
        commitRunFinalSettlement: invoke("commitRunFinalSettlement"),
        activateRootRunSuspension: invoke("activateRootRunSuspension"),
        getRootRunSuspensionActivation: invoke("getRootRunSuspensionActivation"),
        acknowledgeRootRunSuspensionStart: invoke("acknowledgeRootRunSuspensionStart"),
        getRootRunSuspensionStart: invoke("getRootRunSuspensionStart"),
        activateDelegatedRunSuspension: invoke("activateDelegatedRunSuspension"),
        getDelegatedRunSuspensionActivation: invoke("getDelegatedRunSuspensionActivation"),
        getDelegatedRunSuspensionStart: invoke("getDelegatedRunSuspensionStart"),
      });
    },
    retire(): void { state.retired = true; state.writer = undefined; },
  });
}
