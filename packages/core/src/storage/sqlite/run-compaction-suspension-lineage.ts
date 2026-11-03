import { isDeepStrictEqual as same } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { RunCompactionCheckpointV1 } from "@ling-stack/contracts";
import { RunProgressCheckpointError } from "../../run-progress-checkpoint-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { readRootSuspensionStartRecord } from "./run-suspension-start-records.js";
import { readRootSuspensionActivationRecord } from "./run-suspension-activation-records.js";
import { readDelegatedSuspensionActivationRecord, readDelegatedSuspensionStartRecord } from "./run-suspension-delegated-records.js";
import { parseRunSuspensionWitness } from "./run-suspension-witness.js";

function fail(): never { throw new RunProgressCheckpointError("checkpoint.lineage_mismatch"); }

/** Zero-tool handoff keeps the real older checkpoint. Only immutable, physically
 * ACKed suspension edges may carry it forward; an active pointer is not proof. */
export function readCompactionSuspensionHandoffAttempts(database: DatabaseSync, checkpoint: RunCompactionCheckpointV1,
  sourceFence: RuntimeAttemptFenceV1): ReadonlySet<string> {
  const targets = new Set<string>();
  let cursor = sourceFence;
  while (cursor.attemptId !== checkpoint.attemptId) {
    if (targets.size >= 128 || targets.has(cursor.attemptId)) fail();
    targets.add(cursor.attemptId);
    const root = database.prepare("SELECT suspension_id FROM run_suspension_root_activations WHERE run_id=? AND target_attempt_id=?")
      .get(checkpoint.runId, cursor.attemptId);
    const child = database.prepare("SELECT suspension_id FROM run_suspension_delegated_activations WHERE run_id=? AND target_attempt_id=?")
      .get(checkpoint.runId, cursor.attemptId);
    if (Boolean(root) === Boolean(child)) fail();
    const id = String((root ?? child)!.suspension_id);
    const start = root ? readRootSuspensionStartRecord(database, id) : readDelegatedSuspensionStartRecord(database, id);
    const activation = root ? readRootSuspensionActivationRecord(database, id)?.activation
      : readDelegatedSuspensionActivationRecord(database, id)?.activation;
    if (!start || !activation || activation.runId !== checkpoint.runId || !same(activation.targetFence, cursor)) fail();
    const suspension = database.prepare("SELECT seal_artifact_id,seal_digest FROM run_suspensions WHERE id=? AND state='sealed'").get(id);
    if (!suspension || readHarnessRetainedBody(database, String(suspension.seal_artifact_id)).contentSha256 !== suspension.seal_digest) fail();
    const payload = JSON.parse(String(database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(suspension.seal_artifact_id!)?.sealed_payload_json));
    const witness = parseRunSuspensionWitness(payload.witness);
    if (witness.kind !== "compaction" || !same(witness.checkpoint.sourceFence, activation.sourceFence)
      || witness.checkpoint.checkpointId !== checkpoint.id || witness.checkpoint.revision !== checkpoint.revision
      || witness.checkpoint.sourceEventSeq !== checkpoint.sourceEventSeq || witness.checkpoint.summaryArtifactId !== checkpoint.summaryArtifactId
      || witness.checkpoint.summaryContentSha256 !== checkpoint.summaryContentSha256
      || witness.checkpoint.contextSnapshotArtifactId !== checkpoint.contextSnapshotArtifactId) fail();
    cursor = activation.sourceFence;
  }
  return targets;
}
