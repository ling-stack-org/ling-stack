import type { RunProgressCheckpointBlockerCode, RunProgressCheckpointLineage } from "./run-progress-checkpoint-types.js";
import type { RunSuspensionSettlementWitness } from "./run-suspension-types.js";
import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

/** Original SDK callback observation, obtained only through a captured Host reader.
 * This is not a transport receipt, effect-settlement proof, or stop authority. */
export interface RunFinalSettlementObservationV1 {
  /** A restored completion is a separate physical callback, never agent_settled. */
  readonly kind: "pi_final_settlement" | "pi_restored_final_settlement";
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly modelView: readonly unknown[];
  readonly toolCallIds: readonly string[];
  readonly settledBuiltinReads: readonly { readonly toolCallId: string; readonly toolName: "read" | "grep" | "find" | "ls" }[];
}
export interface CommitRunFinalSettlementInput {
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly expectedLineage: RunProgressCheckpointLineage;
  readonly observation: unknown;
  readonly modelView: readonly unknown[];
  readonly now: string;
}
export type ReadRunFinalSettlementResult = {
  readonly kind: "verified";
  readonly witness: RunSuspensionSettlementWitness;
  readonly modelViewArtifactId: string;
  readonly modelView: readonly unknown[];
  /** Exact verified recovery closure, including inherited child-stop evidence. */
  readonly artifactIds: readonly string[];
} | { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode }
  | { readonly kind: "not_settled" };
