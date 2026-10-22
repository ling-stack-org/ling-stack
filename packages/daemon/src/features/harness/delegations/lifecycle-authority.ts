import {
  delegationFence, delegationId, delegationRecord, delegationTimestamp,
  type DelegationRunnerStartObservation,
} from "@ling-stack/core";

export interface DelegationLifecycleObservationSource {
  /** Must authenticate the original adapter/journal reference, not accept a DTO. */
  readonly readAcceptedRunnerStart: (reference: unknown) => DelegationRunnerStartObservation;
}

/** Process-local receipt custody. Serialized or copied tokens do not authenticate. */
export function createDelegationLifecycleAuthority(source: DelegationLifecycleObservationSource): {
  readonly captureStart: (adapterReference: unknown) => object;
  readonly readRunnerStartObservation: (receipt: unknown) => DelegationRunnerStartObservation;
} {
  const starts = new WeakMap<object, DelegationRunnerStartObservation>();
  return Object.freeze({
    captureStart(reference: unknown): object {
      const row = delegationRecord(source.readAcceptedRunnerStart(reference),
        ["childRunId", "sourceFence", "runnerId", "observationId", "observedAt"], "delegation.authority_invalid");
      const snapshot = Object.freeze({ childRunId: delegationId(row.childRunId), sourceFence: delegationFence(row.sourceFence),
        runnerId: delegationId(row.runnerId), observationId: delegationId(row.observationId), observedAt: delegationTimestamp(row.observedAt) });
      const receipt = Object.freeze(Object.create(null) as object);
      starts.set(receipt, snapshot);
      return receipt;
    },
    readRunnerStartObservation(receipt: unknown): DelegationRunnerStartObservation {
      if (!receipt || typeof receipt !== "object" || !starts.has(receipt)) {
        throw Object.assign(new Error("delegation.authority_invalid"), { code: "delegation.authority_invalid" });
      }
      return starts.get(receipt)!;
    },
  });
}
