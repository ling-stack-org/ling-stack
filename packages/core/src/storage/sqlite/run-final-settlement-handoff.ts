import { isDeepStrictEqual as same } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { RunSession, RunEventEnvelope } from "../../run-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { readRootSuspensionActivationRecord } from "./run-suspension-activation-records.js";
import { readRootSuspensionStartRecord } from "./run-suspension-start-records.js";
import { readDelegatedSuspensionActivationRecord, readDelegatedSuspensionStartRecord } from "./run-suspension-delegated-records.js";
import { readRunSuspensionStopRecord, runSuspensionStopArtifacts } from "./run-suspension-stop-records.js";
import { parseRunSuspensionWitness } from "./run-suspension-witness.js";
import { validateRunProgressRecoveryBookkeeping } from "./run-progress-checkpoint-effects.js";
import { readFinalSettlementArtifact, readRunFinalSettlementRecord, finalSettlementFail as fail,
  type RestoredFinalSettlementHandoff } from "./run-final-settlement-records.js";

/** A restored SDK completion has no new model final. Its authority is the exact
 * immutable activation/physical ACK of the stopped, already-final predecessor. */
export function readRestoredFinalSettlementHandoff(database: DatabaseSync, run: RunSession,
  fence: RuntimeAttemptFenceV1, view: readonly unknown[], events: readonly RunEventEnvelope[]): {
    readonly handoff: RestoredFinalSettlementHandoff; readonly artifactIds: readonly string[];
  } {
  const root = database.prepare("SELECT suspension_id FROM run_suspension_root_activations WHERE run_id=? AND target_attempt_id=?").get(run.id, fence.attemptId);
  const child = database.prepare("SELECT suspension_id FROM run_suspension_delegated_activations WHERE run_id=? AND target_attempt_id=?").get(run.id, fence.attemptId);
  if (Boolean(root) === Boolean(child)) fail("checkpoint.lineage_mismatch");
  const suspensionId = String((root ?? child)!.suspension_id);
  const activation = root ? readRootSuspensionActivationRecord(database, suspensionId) : readDelegatedSuspensionActivationRecord(database, suspensionId);
  const start = root ? readRootSuspensionStartRecord(database, suspensionId) : readDelegatedSuspensionStartRecord(database, suspensionId);
  if (!activation || !start || activation.activation.runId !== run.id || !same(activation.activation.targetFence, fence)) fail("checkpoint.lineage_mismatch");
  const stopped = readRunSuspensionStopRecord(database, suspensionId);
  const sealRow = database.prepare("SELECT seal_artifact_id FROM run_suspensions WHERE id=? AND state='sealed'").get(suspensionId);
  if (!stopped?.receipt || !sealRow) fail("checkpoint.lineage_mismatch");
  const seal = readFinalSettlementArtifact(database, String(sealRow.seal_artifact_id), run.id).payload;
  if (!seal || typeof seal !== "object" || Array.isArray(seal)) fail();
  const predecessor = parseRunSuspensionWitness((seal as { witness?: unknown }).witness);
  if (predecessor.kind !== "settlement" || !same(predecessor.settlement.sourceFence, activation.activation.sourceFence)) fail("checkpoint.lineage_mismatch");
  const prior = readRunFinalSettlementRecord(database, predecessor.settlement.id);
  if (!same(prior.witness, predecessor) || !same(prior.modelView, view)) fail("checkpoint.effect_unknown");
  const tail = events.filter(event => event.seq > predecessor.settlement.boundaryEventSeq);
  // A complete restore must not enter a new provider turn, narrate, or run tools.
  if (tail.length !== 1 || tail[0]!.type !== "run_start") fail("checkpoint.effect_unknown");
  validateRunProgressRecoveryBookkeeping(run, tail, fence.attemptId);
  if (database.prepare("SELECT 1 FROM delegation_budget_charges WHERE run_id=? AND attempt_id=? LIMIT 1").get(run.id, fence.attemptId)) fail("checkpoint.effect_unknown");
  const artifacts = new Set([activation.artifactId, start.artifactId, ...runSuspensionStopArtifacts(database, stopped)]);
  if (root && "replayArtifactId" in activation.activation) artifacts.add(activation.activation.replayArtifactId);
  if (child && "preparationArtifactId" in activation.activation) {
    artifacts.add(activation.activation.preparationArtifactId); artifacts.add(activation.activation.parentStartArtifactId);
  }
  return { handoff: { suspensionId, predecessor, activationArtifactId: activation.artifactId, activationDigest: activation.digest,
    startArtifactId: start.artifactId, startDigest: start.digest }, artifactIds: [...artifacts].sort() };
}
