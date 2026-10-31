import { isDeepStrictEqual } from "node:util";
import type { RunFinalSettlementObservationV1, RuntimeAttemptFenceV1 } from "@ling-stack/core";
import { readPiSettledBoundarySnapshot, readPiRestoredCompleteSnapshot, type PiToolBoundaryObservation } from "@ling-stack/runner-pi";
import { HttpError } from "../../../errors.js";

const reject = (): never => {
  throw new HttpError(409, "checkpoint.effect_unknown", "Final settlement requires its original live SDK observation.");
};

/** One constructor owner. No model/HTTP DTO can reconstruct the opaque reference. */
export function createFinalSettlementObservationAuthority() {
  const observations = new WeakMap<object, () => RunFinalSettlementObservationV1>();
  return Object.freeze({
    readObservation(reference: unknown): RunFinalSettlementObservationV1 {
      const read = reference && typeof reference === "object" ? observations.get(reference) : undefined;
      if (!read) return reject();
      return read();
    },
    withObservation<Result>(input: {
      readonly runId: string;
      readonly sourceFence: RuntimeAttemptFenceV1;
      readonly boundary: "original" | "restored";
      readonly observation: PiToolBoundaryObservation | undefined;
      readonly hostToolCallIds: readonly string[];
      readonly activeToolCallIds: readonly string[];
      readonly hostBoundaryUnverified: boolean;
      readonly assertCurrent: () => void;
      readonly redact: (view: readonly unknown[]) => readonly unknown[] | undefined;
    }, commit: (reference: object) => Result): Result {
      if (input.hostBoundaryUnverified || input.activeToolCallIds.length) return reject();
      const sourceFence = Object.freeze(structuredClone(input.sourceFence));
      const read = (): RunFinalSettlementObservationV1 => {
        input.assertCurrent();
        const snapshot = (input.boundary === "restored" ? readPiRestoredCompleteSnapshot : readPiSettledBoundarySnapshot)(
          input.observation, input.runId, sourceFence.attemptId);
        if (!snapshot || input.hostToolCallIds.some(id => !snapshot.inventory.toolCallIds.includes(id))) return reject();
        const modelView = input.redact(snapshot.modelView);
        if (!Array.isArray(modelView) || !isDeepStrictEqual(input.sourceFence, sourceFence)) return reject();
        return { kind: input.boundary === "restored" ? "pi_restored_final_settlement" : "pi_final_settlement", runId: input.runId, sourceFence,
          modelView, toolCallIds: snapshot.inventory.toolCallIds, settledBuiltinReads: snapshot.inventory.settledBuiltinReads };
      };
      // Validate before entering the writer, then let Core reread the original
      // SDK window throughout its own transaction and final owner check.
      read();
      const reference = Object.freeze(Object.create(null) as object);
      observations.set(reference, read);
      try { return commit(reference); }
      finally { observations.delete(reference); }
    },
  });
}
