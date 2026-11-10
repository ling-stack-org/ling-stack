import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationInteger, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import { RunSuspensionStopError, type RunSuspensionDescendantV1, type RunSuspensionDescendantProofV1,
  type RunSuspensionStopBeginV1, type RunSuspensionStopRecord, type RunSuspensionStoppedV1 } from "../../run-suspension-stop-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { runSuspensionWitnessArtifactIds } from "./run-suspension-dependencies.js";
import { parseRunSuspensionWitness } from "./run-suspension-witness.js";

export function stopFail(code: string): never { throw new RunSuspensionStopError(code); }
export function stopDigest(value: unknown): string {
  const result = delegationId(value);
  if (!/^[a-f0-9]{64}$/u.test(result)) stopFail("artifact_invalid");
  return result;
}
export function readSuspensionStopBody(database: DatabaseSync, id: string, runId: string, digest: string, kind: "begin" | "receipt"): unknown {
  const body = readHarnessRetainedBody(database, id);
  const row = database.prepare("SELECT * FROM artifacts WHERE id=?").get(id);
  if (body.bytes > 1_048_576 || body.contentSha256 !== digest || !row || row.run_id !== runId || row.type !== "json"
    || row.path !== `sqlite:run-suspension-stop-${kind}` || row.content_type !== `application/vnd.ling.run-suspension-stop-${kind}+json`
    || typeof row.sealed_payload_json !== "string") stopFail("artifact_invalid");
  const value: unknown = JSON.parse(row.sealed_payload_json as string);
  if (delegationDigest(value) !== digest) stopFail("artifact_invalid");
  return value;
}

function descendants(raw: unknown): readonly RunSuspensionDescendantV1[] {
  if (!Array.isArray(raw) || raw.length > 4096) stopFail("artifact_invalid");
  const rows = (raw as unknown[]).map(item => {
    const row = delegationRecord(item, ["runId", "parentRunId", "workUnitId", "stepId", "reservationId", "lineageDigest", "sourceFence", "neverDispatchedDigest"]);
    for (const key of ["runId", "parentRunId", "workUnitId", "stepId", "reservationId"]) delegationId(row[key]);
    stopDigest(row.lineageDigest);
    if (row.sourceFence !== undefined) delegationFence(row.sourceFence);
    if (row.neverDispatchedDigest !== undefined) {
      stopDigest(row.neverDispatchedDigest);
      if (row.sourceFence !== undefined) stopFail("artifact_invalid");
    }
    return item as RunSuspensionDescendantV1;
  });
  if (rows.some((row, index) => index > 0 && rows[index - 1]!.runId >= row.runId)) stopFail("artifact_invalid");
  return rows;
}
function proofs(raw: unknown): readonly RunSuspensionDescendantProofV1[] {
  if (!Array.isArray(raw) || raw.length > 4096) stopFail("artifact_invalid");
  const rows = (raw as unknown[]).map(item => {
    const kind = (item as { kind?: unknown })?.kind;
    const row = delegationRecord(item, kind === "stopped"
      ? ["runId", "kind", "suspensionId", "receiptArtifactId", "receiptDigest"] : ["runId", "kind", "evidenceDigest"]);
    delegationId(row.runId);
    if (kind === "stopped") { delegationId(row.suspensionId); delegationId(row.receiptArtifactId); stopDigest(row.receiptDigest); }
    else if (kind === "terminal" || kind === "never_dispatched") stopDigest(row.evidenceDigest);
    else stopFail("artifact_invalid");
    return item as RunSuspensionDescendantProofV1;
  });
  if (rows.some((row, index) => index > 0 && rows[index - 1]!.runId >= row.runId)) stopFail("artifact_invalid");
  return rows;
}

/** Immutable provenance reader only. Current stop/recovery authority is checked by its owning writer. */
export function readRunSuspensionStopRecord(database: DatabaseSync, id: string): RunSuspensionStopRecord | undefined {
  const row = database.prepare("SELECT * FROM run_suspension_stops WHERE suspension_id=?").get(delegationId(id));
  if (!row) return undefined;
  const begin = readSuspensionStopBody(database, String(row.begin_artifact_id), String(row.run_id), String(row.begin_digest), "begin") as RunSuspensionStopBeginV1;
  const item = delegationRecord(begin, ["schemaVersion", "kind", "suspensionId", "runId", "sourceFence", "sealDigest", "modelAdmissionDigest", "canonicalEventDigest", "source", "descendants", "begunAt"]);
  const fence = delegationFence(item.sourceFence);
  if (item.schemaVersion !== 1 || item.kind !== "run.suspension_stop_begin.v1" || item.suspensionId !== id || item.runId !== row.run_id
    || fence.workUnitId !== row.work_unit_id || fence.attemptId !== row.attempt_id || fence.runtimeInstanceId !== row.runtime_instance_id
    || fence.fencingToken !== row.fencing_token || delegationTimestamp(item.begunAt) !== row.begun_at) stopFail("artifact_invalid");
  stopDigest(item.sealDigest); stopDigest(item.modelAdmissionDigest); stopDigest(item.canonicalEventDigest); descendants(item.descendants);
  if ((item.source as { kind?: unknown })?.kind === "root") delegationRecord(item.source, ["kind"]);
  else {
    const source = delegationRecord(item.source, ["kind", "reservationId", "stepId", "parentRunId", "parentFence", "lineageDigest",
      "interruptMessageId", "interruptArtifactId", "interruptDigest"]);
    if (source.kind !== "delegated") stopFail("artifact_invalid");
    for (const key of ["reservationId", "stepId", "parentRunId", "interruptMessageId", "interruptArtifactId"]) delegationId(source[key]);
    delegationFence(source.parentFence); stopDigest(source.lineageDigest); stopDigest(source.interruptDigest);
  }
  let receipt: RunSuspensionStoppedV1 | undefined;
  if (row.state === "stopped") {
    receipt = readSuspensionStopBody(database, String(row.receipt_artifact_id), begin.runId, String(row.receipt_digest), "receipt") as RunSuspensionStoppedV1;
    const value = delegationRecord(receipt, ["schemaVersion", "kind", "suspensionId", "runId", "sourceFence", "beginDigest", "sealDigest",
      "completionDigest", "drainedAt", "audit", "descendants", "stoppedAt"]);
    if (value.schemaVersion !== 1 || value.kind !== "run.suspension_stopped.v1" || value.suspensionId !== id || value.runId !== begin.runId
      || !isDeepStrictEqual(delegationFence(value.sourceFence), fence) || value.beginDigest !== row.begin_digest
      || value.sealDigest !== begin.sealDigest || delegationTimestamp(value.stoppedAt) !== row.stopped_at
      || String(row.stopped_at) < begin.begunAt || delegationTimestamp(value.drainedAt) > String(row.stopped_at)) stopFail("artifact_invalid");
    stopDigest(value.completionDigest);
    const audit = delegationRecord(value.audit, ["seq", "digest"]);
    if (delegationInteger(audit.seq) < 1) stopFail("artifact_invalid");
    stopDigest(audit.digest); proofs(value.descendants);
    if (!isDeepStrictEqual(receipt.descendants.map(proof => proof.runId), begin.descendants.map(node => node.runId))) stopFail("artifact_invalid");
    for (const [index, proof] of receipt.descendants.entries()) {
      const node = begin.descendants[index]!;
      if (proof.kind === "never_dispatched"
        ? node.sourceFence !== undefined || node.neverDispatchedDigest !== proof.evidenceDigest
        : node.neverDispatchedDigest !== undefined) stopFail("artifact_invalid");
    }
  } else if (row.state !== "stopping" || row.receipt_artifact_id !== null || row.receipt_digest !== null || row.stopped_at !== null) stopFail("artifact_invalid");
  const result: RunSuspensionStopRecord = { suspensionId: id, state: row.state as "stopping" | "stopped",
    beginArtifactId: String(row.begin_artifact_id), beginDigest: String(row.begin_digest), begin,
    ...(receipt ? { receiptArtifactId: String(row.receipt_artifact_id), receiptDigest: String(row.receipt_digest), receipt } : {}) };
  for (const artifactId of runSuspensionStopArtifacts(database, result)) {
    for (const [kind, reason] of [["run_suspension_stop", "recovery"], ["run_suspension_stop_audit", "audit_hold"]] as const) {
      if (!database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason=? AND released_at IS NULL")
        .get(artifactId, harnessArtifactOwnerHolder(kind, id), reason)) stopFail("pin_missing");
    }
  }
  return result;
}

export function runSuspensionStopArtifacts(database: DatabaseSync, record: RunSuspensionStopRecord): readonly string[] {
  const saved = database.prepare("SELECT * FROM run_suspensions WHERE id=? AND state='sealed'").get(record.suspensionId);
  if (!saved || saved.seal_digest !== record.begin.sealDigest) stopFail("seal_changed");
  const sealBody = readHarnessRetainedBody(database, String(saved.seal_artifact_id));
  if (sealBody.contentSha256 !== saved.seal_digest) stopFail("seal_changed");
  const seal = JSON.parse(String(database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(saved.seal_artifact_id!)?.sealed_payload_json)) as { modelViewArtifactId?: unknown; witness?: unknown };
  const source = record.begin.source;
  return [record.beginArtifactId, String(saved.request_artifact_id), String(saved.seal_artifact_id), delegationId(seal.modelViewArtifactId),
    ...runSuspensionWitnessArtifactIds({ database }, parseRunSuspensionWitness(seal.witness)),
    ...(source.kind === "delegated" ? [source.interruptArtifactId] : []),
    ...(record.receiptArtifactId ? [record.receiptArtifactId] : []),
    ...(record.receipt?.descendants.flatMap(proof => proof.kind === "stopped" ? [proof.receiptArtifactId] : []) ?? [])];
}
