import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationInteger, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import { assertRunProgressPayloadSecretFree } from "../../run-progress-checkpoint-lineage.js";
import { RUN_PROGRESS_MAX_PAYLOAD_BYTES, RunProgressCheckpointError } from "../../run-progress-checkpoint-types.js";
import type { RunSuspensionCompactionWitness, RunSuspensionSettlementWitness } from "../../run-suspension-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { compactionSuspensionArtifactIds } from "./run-compaction-suspension-witness.js";
import { parseRunSuspensionLineage, parseRunSuspensionWitness } from "./run-suspension-witness.js";

export const FINAL_SETTLEMENT_CONTENT_TYPE = "application/vnd.ling.run-final-settlement+json";
export const FINAL_SETTLEMENT_VIEW_CONTENT_TYPE = "application/vnd.ling.run-final-settlement-view+json";
export interface RestoredFinalSettlementHandoff {
  readonly suspensionId: string;
  readonly predecessor: RunSuspensionSettlementWitness;
  readonly activationArtifactId: string; readonly activationDigest: string;
  readonly startArtifactId: string; readonly startDigest: string;
}
export interface FinalSettlementPayload {
  readonly schemaVersion: 1; readonly kind: "run.final_settlement.v1"; readonly id: string; readonly runId: string;
  readonly observationKind: "pi_final_settlement" | "pi_restored_final_settlement";
  readonly restoredHandoff?: RestoredFinalSettlementHandoff;
  readonly sourceFence: RunSuspensionSettlementWitness["settlement"]["sourceFence"];
  readonly lineage: RunSuspensionSettlementWitness["settlement"]["lineage"];
  readonly boundaryEventSeq: number; readonly canonicalEventDigest: string; readonly budgetDigest: string;
  readonly effectDigest: string; readonly modelViewArtifactId: string; readonly modelViewSha256: string;
  readonly dependencies: readonly { readonly id: string; readonly digest: string }[];
  readonly predecessorDigest: string; readonly compactionWitness?: RunSuspensionCompactionWitness;
  readonly committedAt: string;
}
export function finalSettlementFail(code: RunProgressCheckpointError["code"] = "checkpoint.snapshot_unavailable"): never {
  throw new RunProgressCheckpointError(code);
}
export function finalSettlementDigest(raw: unknown): string {
  const value = delegationId(raw);
  if (!/^[a-f0-9]{64}$/u.test(value)) finalSettlementFail();
  return value;
}
export function readFinalSettlementArtifact(database: DatabaseSync, id: string, runId: string, contentType?: string): { readonly payload: unknown; readonly digest: string } {
  const body = readHarnessRetainedBody(database, id), row = database.prepare("SELECT * FROM artifacts WHERE id=?").get(id);
  if (!row || row.run_id !== runId || row.type !== "json" || contentType && row.content_type !== contentType
    || body.bytes > RUN_PROGRESS_MAX_PAYLOAD_BYTES || typeof row.sealed_payload_json !== "string") finalSettlementFail();
  const payload: unknown = JSON.parse(row.sealed_payload_json as string);
  assertRunProgressPayloadSecretFree(payload);
  if (createHash("sha256").update(JSON.stringify(payload)).digest("hex") !== body.contentSha256) finalSettlementFail();
  return { payload, digest: body.contentSha256 };
}

/** Immutable history only: never infers current execution permission from a pointer. */
export function readRunFinalSettlementRecord(database: DatabaseSync, id: string): {
  readonly witness: RunSuspensionSettlementWitness; readonly payload: FinalSettlementPayload; readonly modelView: readonly unknown[];
} {
  const row = database.prepare("SELECT * FROM run_final_settlements WHERE id=?").get(delegationId(id));
  if (!row) finalSettlementFail();
  const saved = readFinalSettlementArtifact(database, String(row.artifact_id), String(row.run_id), FINAL_SETTLEMENT_CONTENT_TYPE);
  const value = delegationRecord(saved.payload, ["schemaVersion", "kind", "id", "runId", "observationKind", "restoredHandoff", "sourceFence", "lineage", "boundaryEventSeq",
    "canonicalEventDigest", "budgetDigest", "effectDigest", "modelViewArtifactId", "modelViewSha256", "dependencies", "predecessorDigest", "compactionWitness", "committedAt"]);
  const sourceFence = delegationFence(value.sourceFence), lineage = parseRunSuspensionLineage(value.lineage);
  const boundaryEventSeq = delegationInteger(value.boundaryEventSeq);
  if (value.schemaVersion !== 1 || value.kind !== "run.final_settlement.v1" || value.id !== row.id || value.runId !== row.run_id
    || sourceFence.workUnitId !== row.work_unit_id || sourceFence.attemptId !== row.attempt_id
    || sourceFence.runtimeInstanceId !== row.runtime_instance_id || sourceFence.fencingToken !== row.fencing_token
    || boundaryEventSeq < 1 || boundaryEventSeq !== row.boundary_event_seq || saved.digest !== row.digest
    || value.modelViewArtifactId !== row.model_view_artifact_id || value.modelViewSha256 !== row.model_view_sha256
    || delegationTimestamp(value.committedAt) !== row.committed_at || !Array.isArray(value.dependencies) || value.dependencies.length > 10_000) finalSettlementFail();
  for (const key of ["canonicalEventDigest", "budgetDigest", "effectDigest", "predecessorDigest", "modelViewSha256"]) finalSettlementDigest(value[key]);
  if (value.observationKind === "pi_restored_final_settlement") {
    const handoff = delegationRecord(value.restoredHandoff, ["suspensionId", "predecessor", "activationArtifactId", "activationDigest", "startArtifactId", "startDigest"]);
    for (const key of ["suspensionId", "activationArtifactId", "startArtifactId"]) delegationId(handoff[key]);
    for (const key of ["activationDigest", "startDigest"]) finalSettlementDigest(handoff[key]);
    const predecessor = parseRunSuspensionWitness(handoff.predecessor);
    if (predecessor.kind !== "settlement" || predecessor.settlement.sourceFence.attemptId === sourceFence.attemptId
      || predecessor.settlement.sourceFence.workUnitId !== sourceFence.workUnitId || !same(predecessor.settlement.lineage, lineage)
      || predecessor.settlement.boundaryEventSeq >= boundaryEventSeq || value.compactionWitness !== undefined) finalSettlementFail();
    for (const id of [handoff.activationArtifactId, handoff.startArtifactId, predecessor.settlement.artifactId, predecessor.settlement.modelViewArtifactId])
      if (!(value.dependencies as { id?: unknown }[]).some(dep => dep.id === id)) finalSettlementFail();
  } else if (value.observationKind !== "pi_final_settlement" || value.restoredHandoff !== undefined) finalSettlementFail();
  let previous = "";
  for (const raw of value.dependencies) {
    const dep = delegationRecord(raw, ["id", "digest"]), artifactId = delegationId(dep.id);
    if (artifactId <= previous || readHarnessRetainedBody(database, artifactId).contentSha256 !== finalSettlementDigest(dep.digest)) finalSettlementFail();
    previous = artifactId;
  }
  if (value.compactionWitness !== undefined) {
    const witness = parseRunSuspensionWitness(value.compactionWitness);
    if (witness.kind !== "compaction" || !same(witness.checkpoint.lineage, lineage)
      || !same(witness.checkpoint.sourceFence, sourceFence)) finalSettlementFail();
    for (const artifactId of compactionSuspensionArtifactIds({ database }, witness))
      if (!(value.dependencies as { id: string }[]).some(dep => dep.id === artifactId)) finalSettlementFail();
  }
  const view = readFinalSettlementArtifact(database, String(value.modelViewArtifactId), String(row.run_id), FINAL_SETTLEMENT_VIEW_CONTENT_TYPE);
  if (view.digest !== value.modelViewSha256 || !Array.isArray(view.payload)) finalSettlementFail();
  const witness: RunSuspensionSettlementWitness = { kind: "settlement", settlement: {
    id: String(row.id), artifactId: String(row.artifact_id), digest: saved.digest, modelViewArtifactId: String(value.modelViewArtifactId),
    modelViewSha256: view.digest, boundaryEventSeq, sourceFence, lineage,
  } };
  for (const artifactId of [witness.settlement.artifactId, witness.settlement.modelViewArtifactId, ...(value.dependencies as { id: string }[]).map(dep => dep.id)])
    for (const [kind, reason] of [["run_final_settlement", "recovery"], ["run_final_settlement_audit", "audit_hold"]] as const)
      if (!database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason=? AND released_at IS NULL")
        .get(artifactId, harnessArtifactOwnerHolder(kind, String(row.id)), reason)) finalSettlementFail();
  return { witness, payload: value as unknown as FinalSettlementPayload, modelView: view.payload };
}

export function finalSettlementArtifactIds(database: DatabaseSync, witness: RunSuspensionSettlementWitness): readonly string[] {
  const saved = readRunFinalSettlementRecord(database, witness.settlement.id);
  if (!same(saved.witness, witness)) finalSettlementFail();
  return [saved.witness.settlement.artifactId, saved.witness.settlement.modelViewArtifactId, ...saved.payload.dependencies.map(dep => dep.id)];
}
