import { HostOperationJournalError } from "./host-operation-journal-types.js";
import type { HostOfficeLocalDirectoryExecutionRecordV2 } from "./host-office-local-directory-v2-types.js";

declare const readerBrand: unique symbol;
declare const setupBrand: unique symbol;
declare const authorityBrand: unique symbol;
export interface OriginalOfficeHostBridgeReader { readonly [readerBrand]: true }
export interface OriginalOfficeHostBridgeSetup { readonly [setupBrand]: true }
export interface OriginalOfficeDirectoryAuthorityV2 { readonly [authorityBrand]: true }

/** Internal startup transport. Only the fixed Host composition constructs the endpoint. */
export interface FixedOriginalOfficeHostEndpoint {
  readonly assertBinding: (custody: object, expected: HostOfficeLocalDirectoryExecutionRecordV2) => void;
}
/** Captured by the actual owning Store constructor, never returned through RunStore. */
export interface CapturedOriginalOfficeHostBridge {
  readonly assertAuthorityOwned: (authority: OriginalOfficeDirectoryAuthorityV2) => void;
  readonly bindAuthority: (authority: OriginalOfficeDirectoryAuthorityV2, expected: HostOfficeLocalDirectoryExecutionRecordV2) => void;
  readonly retire: () => void;
}
interface BridgeState {
  owner?: object;
  phase: "unsealed" | "sealing" | "sealed" | "invalid";
  endpoint?: { readonly receiver: FixedOriginalOfficeHostEndpoint; readonly assertBinding: FixedOriginalOfficeHostEndpoint["assertBinding"] };
}
const readers = new WeakMap<OriginalOfficeHostBridgeReader, BridgeState>();
const setups = new WeakMap<OriginalOfficeHostBridgeSetup, BridgeState>();
const authorities = new WeakMap<OriginalOfficeDirectoryAuthorityV2, {
  readonly bridge: BridgeState; readonly custody: object; bindingEntered: boolean;
}>();
const fail = (code: string): never => { throw new HostOperationJournalError(code); };
const object = (value: unknown): value is object => typeof value === "object" && value !== null;

/**
 * Pair only at trusted startup. Setup key custody, not a brand or first callback,
 * supplies the trust boundary. This does not attest arbitrary malicious Host JS.
 * Tokens expose no endpoint, setup getter, descriptor integer or native session.
 */
export function createOriginalOfficeHostBridgeForComposition(): Readonly<{
  reader: OriginalOfficeHostBridgeReader; setup: OriginalOfficeHostBridgeSetup;
}> {
  const reader = Object.freeze({}) as OriginalOfficeHostBridgeReader, setup = Object.freeze({}) as OriginalOfficeHostBridgeSetup;
  const state: BridgeState = { phase: "unsealed" };
  readers.set(reader, state); setups.set(setup, state);
  return Object.freeze({ reader, setup });
}

/** One exact constructor owner. A second/reopened Store cannot adopt this realm. */
export function captureOriginalOfficeHostBridgeReader(reader: OriginalOfficeHostBridgeReader,
  owner: object): CapturedOriginalOfficeHostBridge {
  const state = readers.get(reader);
  if (!state || !object(owner)) return fail("host_office_local_bridge_invalid");
  if (state.owner || state.phase !== "unsealed") return fail("host_office_local_bridge_owner_invalid");
  state.owner = owner;
  const assertAuthorityOwned = (authority: OriginalOfficeDirectoryAuthorityV2): void => {
    if (state.owner !== owner || state.phase !== "sealed" || !state.endpoint) return fail("host_office_local_bridge_unavailable");
    if (authorities.get(authority)?.bridge !== state) return fail("host_office_local_authority_invalid");
  };
  return Object.freeze({ assertAuthorityOwned,
    bindAuthority(authority: OriginalOfficeDirectoryAuthorityV2, expected: HostOfficeLocalDirectoryExecutionRecordV2): void {
      assertAuthorityOwned(authority);
      const endpoint = state.endpoint!;
      const original = authorities.get(authority)!;
      if (original.bindingEntered) return fail("host_office_local_authority_already_entered");
      original.bindingEntered = true; // Channel-local capability also survives reentry/return loss.
      assertEndpointCurrent(endpoint);
      const result: unknown = Reflect.apply(endpoint.assertBinding, endpoint.receiver, [original.custody, expected]);
      if (object(result) || typeof result === "function") {
        // Observe a native rejected Promise without executing an arbitrary thenable.
        try { void Promise.prototype.then.call(result, undefined, () => undefined); } catch { /* not a native Promise */ }
      }
      if (result !== undefined) return fail("host_office_local_bridge_endpoint_result_invalid");
      assertAuthorityOwned(authority); assertEndpointCurrent(endpoint);
    },
    retire(): void { state.phase = "invalid"; },
  });
}

/** Only the startup holder has setup; validation failure consumes this installation. */
export function sealOriginalOfficeHostBridgeForComposition(setup: OriginalOfficeHostBridgeSetup,
  owner: object, endpoint: FixedOriginalOfficeHostEndpoint): void {
  const state = setups.get(setup);
  if (!state) return fail("host_office_local_bridge_invalid");
  if (state.phase !== "unsealed") return fail("host_office_local_bridge_seal_closed");
  state.phase = "sealing"; // Before any endpoint descriptor/Proxy trap can reenter.
  try {
    if (state.owner !== owner || !object(endpoint) || !Object.isFrozen(endpoint)) return fail("host_office_local_bridge_owner_invalid");
    const keys = Reflect.ownKeys(endpoint), descriptor = Object.getOwnPropertyDescriptor(endpoint, "assertBinding");
    if (keys.length !== 1 || keys[0] !== "assertBinding" || !descriptor || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function" || Object.prototype.toString.call(descriptor.value) === "[object AsyncFunction]") {
      return fail("host_office_local_bridge_endpoint_invalid");
    }
    if (state.phase !== "sealing") return fail("host_office_local_bridge_seal_closed");
    state.endpoint = Object.freeze({ receiver: endpoint, assertBinding: descriptor.value as FixedOriginalOfficeHostEndpoint["assertBinding"] });
    state.phase = "sealed";
  } catch (error) { state.phase = "invalid"; throw error; }
}

/** Mint only a channel-local handle. The fixed Host endpoint must also verify its private custody map. */
export function mintOriginalOfficeDirectoryAuthorityV2(setup: OriginalOfficeHostBridgeSetup,
  originalHostCustodyRef: object): OriginalOfficeDirectoryAuthorityV2 {
  const state = setups.get(setup);
  if (!state || !object(originalHostCustodyRef)) return fail("host_office_local_bridge_invalid");
  if (!state.owner || state.phase !== "sealed" || !state.endpoint) return fail("host_office_local_bridge_unavailable");
  const authority = Object.freeze({}) as OriginalOfficeDirectoryAuthorityV2;
  authorities.set(authority, { bridge: state, custody: originalHostCustodyRef, bindingEntered: false });
  return authority;
}

/** Fixed Host lifecycle enrollment only. This reads private ownership, not caller flags. */
export function assertOriginalOfficeHostBridgeForCompositionCurrent(setup: OriginalOfficeHostBridgeSetup, owner: object): void {
  const state = setups.get(setup);
  if (!state || state.owner !== owner) return fail("host_office_local_bridge_owner_invalid");
  if (state.phase !== "sealed" || !state.endpoint) return fail("host_office_local_bridge_unavailable");
  assertEndpointCurrent(state.endpoint);
}

/** Supervisor retirement closes every enrolled Store before native cleanup can fail. */
export function retireOriginalOfficeHostBridgeForComposition(setup: OriginalOfficeHostBridgeSetup, owner: object): void {
  const state = setups.get(setup);
  if (!state || state.owner !== owner) return fail("host_office_local_bridge_owner_invalid");
  if (state.phase === "invalid") return;
  if (state.phase !== "sealed") return fail("host_office_local_bridge_unavailable");
  state.phase = "invalid";
}

function assertEndpointCurrent(endpoint: NonNullable<BridgeState["endpoint"]>): void {
  const descriptor = Object.getOwnPropertyDescriptor(endpoint.receiver, "assertBinding");
  if (!Object.isFrozen(endpoint.receiver) || !descriptor || !Object.hasOwn(descriptor, "value")
    || descriptor.value !== endpoint.assertBinding) return fail("host_office_local_bridge_endpoint_invalid");
}
