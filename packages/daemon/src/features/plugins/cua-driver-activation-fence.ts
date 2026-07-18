import type { CuaDriverActivationFenceV1, DesktopCuaDriverLease } from "@ling-stack/contracts";
import type {
  CommitCuaDriverActivationInput,
  CommitCuaDriverActivationResult,
  CuaDriverActivationState,
  CuaDriverActivationStoreFacet,
} from "@ling-stack/core";
import type { CuaDriverLeaseRegistry } from "./cua-driver-lease.js";

export function captureCuaDriverActivationFence(
  lease: DesktopCuaDriverLease,
  state: CuaDriverActivationState,
): CuaDriverActivationFenceV1 {
  return {
    schemaVersion: 1,
    desktopInstanceId: lease.desktopInstanceId,
    desktopInstanceEpoch: lease.desktopInstanceEpoch,
    bridgeConnectionId: lease.bridgeConnectionId,
    daemonAuthorityEpoch: lease.daemonAuthorityEpoch,
    leaseGeneration: lease.generation,
    lockDigest: lease.lockDigest,
    providerSealDigest: lease.providerSealDigest,
    providerCatalogDigest: lease.providerCatalogDigest,
    activationEpoch: state.activationEpoch,
    requestedRevision: state.requestedRevision,
  };
}

export function isCurrentCuaDriverActivationFence(input: {
  readonly token: CuaDriverActivationFenceV1;
  readonly leaseRegistry: CuaDriverLeaseRegistry;
  readonly state: CuaDriverActivationState | undefined;
  readonly now?: string;
}): boolean {
  const lease = input.leaseRegistry.getCurrent(input.now);
  const state = input.state;
  return Boolean(lease && state
    && state.requestedRevision === input.token.requestedRevision
    && state.activationEpoch === input.token.activationEpoch
    && lease.desktopInstanceId === input.token.desktopInstanceId
    && lease.desktopInstanceEpoch === input.token.desktopInstanceEpoch
    && lease.bridgeConnectionId === input.token.bridgeConnectionId
    && lease.daemonAuthorityEpoch === input.token.daemonAuthorityEpoch
    && lease.generation === input.token.leaseGeneration
    && lease.lockDigest === input.token.lockDigest
    && lease.providerSealDigest === input.token.providerSealDigest
    && lease.providerCatalogDigest === input.token.providerCatalogDigest);
}

/**
 * Final synchronous fence check plus SQLite CAS. Call this only after every
 * asynchronous readiness/tool operation has completed; there must be no await
 * between the registry check and the Store call below.
 */
export function commitCurrentCuaDriverActivation(input: {
  readonly store: CuaDriverActivationStoreFacet;
  readonly leaseRegistry: CuaDriverLeaseRegistry;
  readonly token: CuaDriverActivationFenceV1;
  readonly projection: Omit<CommitCuaDriverActivationInput, "expected">;
}): CommitCuaDriverActivationResult {
  const state = input.store.getCuaDriverActivationState(input.projection.pluginId);
  if (!isCurrentCuaDriverActivationFence({
    token: input.token,
    leaseRegistry: input.leaseRegistry,
    state,
    now: input.projection.now,
  })) {
    return { committed: false, ...(state ? { state } : {}) };
  }
  return input.store.commitCuaDriverActivation({
    ...input.projection,
    expected: {
      requestedRevision: input.token.requestedRevision,
      activationEpoch: input.token.activationEpoch,
    },
  });
}
