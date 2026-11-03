import type { RunSuspensionWitness } from "../../run-suspension-types.js";
import { compactionSuspensionArtifactIds } from "./run-compaction-suspension-witness.js";
import { finalSettlementArtifactIds } from "./run-final-settlement-records.js";
import type { SqliteStoreContext } from "./store-context.js";

/** Complete immutable dependency closure for every suspension lifecycle owner. */
export function runSuspensionWitnessArtifactIds(context: SqliteStoreContext, witness: RunSuspensionWitness): readonly string[] {
  return witness.kind === "settlement" ? finalSettlementArtifactIds(context.database, witness)
    : compactionSuspensionArtifactIds(context, witness);
}
