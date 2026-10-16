import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import { hostCompactionResourceBoundaryArtifactId, type SealHostCompactionResourceBoundaryInput } from "../../host-compaction-resource-types.js";
import type { HostAttemptEffectInventory } from "../../host-attempt-completion-types.js";
import type { RunStore } from "../../run-types.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

type ReadPorts = Pick<RunStore, "getRun" | "getArtifact" | "listArtifacts"
  | "getLatestRunCompactionCheckpoint" | "getLatestWorkspaceProvenanceWatermark">;
type Ports = ReadPorts & Pick<RunStore, "createArtifact">;
const boundaryType = "application/vnd.ling.host-compaction-resource-boundary+json";
const nativeType = "application/vnd.ling.native-file-mutation-completion+json";
class UnverifiedBoundary extends Error {}
function reject(): never { throw new UnverifiedBoundary("host_compaction_resource_boundary_unverified"); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const strings = (value: unknown): value is string[] => Array.isArray(value)
  && value.every(item => typeof item === "string" && item.length > 0) && new Set(value).size === value.length;
const sourceKeys = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const;
const sameSource = (value: unknown, source: HostOperationSource): boolean => record(value)
  && Object.keys(value).sort().join(",") === "attemptId,fencingToken,runId,runtimeInstanceId,workUnitId"
  && sourceKeys.every(key => typeof source[key] === "string" && source[key].length > 0 && value[key] === source[key]);

/** Source-local checkpoint observation. This never changes completion, resources or Run state. */
export function sealHostCompactionResourceBoundary(context: SqliteStoreContext, ports: Ports,
  input: SealHostCompactionResourceBoundaryInput): string | undefined {
  context.database.exec("BEGIN IMMEDIATE");
  try {
    if (!isCurrentRunExecutionOwner(context, input.source.runId, input.source, false)) reject();
    const checkpoint = verifyCheckpoint(context.database, ports, input.source, input.checkpointId);
    const nativeCompletionArtifactIds = verifyInventory(context.database, ports, input.source, input.inventory, input.now);
    const payload = { schemaVersion: 1, boundary: "host-compaction-resource-boundary", source: input.source,
      checkpointId: checkpoint.id, sourceEventSeq: checkpoint.sourceEventSeq,
      summaryContentSha256: checkpoint.summaryContentSha256, inventory: input.inventory, nativeCompletionArtifactIds };
    const id = hostCompactionResourceBoundaryArtifactId(input.source, checkpoint.id);
    const existing = ports.getArtifact(id);
    if (existing) {
      if (existing.runId !== input.source.runId || existing.contentType !== boundaryType || existing.contentSha256 !== digest(payload)) reject();
    } else {
      ports.createArtifact({ id, runId: input.source.runId, type: "json", path: `${input.source.runId}/compaction/resource-boundaries/${id}.json`,
        title: "Host checkpoint resource boundary", contentType: boundaryType, sealedPayload: payload, createdAt: input.now });
    }
    context.database.exec("COMMIT");
    return id;
  } catch (error) {
    rollbackOwnedSqliteTransaction(context.database);
    if (error instanceof UnverifiedBoundary) return undefined;
    throw error;
  }
}

/** Caller owns the continuation transaction. Never used by generic release, expiry or stop confirmation. */
export function releaseCompactionSourceResourcesWithinTransaction(context: SqliteStoreContext, ports: ReadPorts,
  input: { readonly source: HostOperationSource; readonly checkpointId: string; readonly artifactId: string;
    readonly now: string; readonly successorRuntimeInstanceId: string; readonly idempotencyKey: string }): boolean {
  try {
    const { source } = input;
    const owner = context.database.prepare(`SELECT attempt.status,unit.status AS unit_status,unit.active_attempt_id
      FROM work_unit_attempts attempt JOIN work_units unit ON unit.id=attempt.work_unit_id
      WHERE attempt.id=? AND attempt.work_unit_id=? AND attempt.runtime_instance_id=? AND attempt.fencing_token=?`)
      .get(source.attemptId, source.workUnitId, source.runtimeInstanceId, source.fencingToken);
    if (!owner || owner.status !== "lost" || owner.unit_status !== "stale" || owner.active_attempt_id !== source.attemptId
      || input.successorRuntimeInstanceId === source.runtimeInstanceId) reject();
    if (input.artifactId !== hostCompactionResourceBoundaryArtifactId(source, input.checkpointId)) reject();
    const checkpoint = verifyCheckpoint(context.database, ports, source, input.checkpointId);
    const artifact = readArtifact(ports, input.artifactId, source.runId, boundaryType);
    const payload = artifact.sealedPayload as Record<string, unknown>;
    if (payload.schemaVersion !== 1 || payload.boundary !== "host-compaction-resource-boundary" || !sameSource(payload.source, source)
      || payload.checkpointId !== checkpoint.id || payload.sourceEventSeq !== checkpoint.sourceEventSeq
      || payload.summaryContentSha256 !== checkpoint.summaryContentSha256
      || Date.parse(artifact.createdAt) > Date.parse(input.now)) reject();
    const nativeIds = verifyInventory(context.database, ports, source, payload.inventory, input.now);
    if (JSON.stringify(nativeIds) !== JSON.stringify(payload.nativeCompletionArtifactIds)) reject();
    // These exact-source releases are one part of the successor's activation
    // transaction. They do not declare the original SDK drained or reusable.
    for (const table of ["resource_leases", "runtime_semaphore_slots"] as const) {
      context.database.prepare(`UPDATE ${table} SET status='released',released_at=?,release_reason=?
        WHERE status='active' AND work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=?`)
        .run(input.now, `compaction-checkpoint-handoff:${input.idempotencyKey}`, source.workUnitId,
          source.attemptId, source.runtimeInstanceId, source.fencingToken);
    }
    return true;
  } catch (error) {
    if (error instanceof UnverifiedBoundary) return false;
    throw error;
  }
}

function verifyCheckpoint(database: DatabaseSync, ports: ReadPorts, source: HostOperationSource, checkpointId: string) {
  const run = ports.getRun(source.runId), checkpoint = ports.getLatestRunCompactionCheckpoint(source.runId);
  if (!run || run.workUnitId !== source.workUnitId || !["running", "queued"].includes(run.status)
    || !checkpoint || checkpoint.id !== checkpointId || checkpoint.state !== "committed" || checkpoint.attemptId !== source.attemptId
    || checkpoint.contextViewId !== run.contextViewId || checkpoint.providerName !== run.providerName || checkpoint.providerModel !== run.providerModel
    || checkpoint.unresolvedToolCallIds.length || checkpoint.unresolvedApprovalIds.length || checkpoint.unresolvedQuestionIds.length
    || checkpoint.workspaceProvenanceWatermark !== ports.getLatestWorkspaceProvenanceWatermark()) return reject();
  const summary = readArtifact(ports, checkpoint.summaryArtifactId, source.runId, "application/vnd.ling.run-compaction-summary+json");
  if (summary.contentSha256 !== checkpoint.summaryContentSha256) reject();
  const sourceEvent = database.prepare("SELECT type FROM run_events WHERE run_id=? AND seq=?").get(source.runId, checkpoint.sourceEventSeq);
  if (!sourceEvent) reject();
  let installed = sourceEvent.type !== "context_compaction_start";
  for (const event of database.prepare("SELECT type,data_json FROM run_events WHERE run_id=? AND seq>? ORDER BY seq")
    .iterate(source.runId, checkpoint.sourceEventSeq)) {
    if (event.type === "turn_start" || event.type === "turn_end") continue;
    const data: unknown = JSON.parse(String(event.data_json));
    if (!installed && event.type === "context_compaction_end" && record(data)
      && data.attemptId === source.attemptId && data.outcome === "sdk_installed") { installed = true; continue; }
    // Initial SDK summary events precede installation; the same events after
    // installation are task progress and must invalidate this checkpoint.
    if (!installed && ["assistant_text_delta", "assistant_thinking_delta", "assistant_reasoning_summary",
      "message_end"].includes(String(event.type))) continue;
    if (event.type === "artifact_created" && record(data) && record(data.artifact)
      && data.artifact.id === checkpoint.contextSnapshotArtifactId) continue;
    reject();
  }
  if (!installed) reject();
  return checkpoint;
}

function verifyInventory(database: DatabaseSync, ports: ReadPorts, source: HostOperationSource,
  value: unknown, at: string): readonly string[] {
  if (!record(value) || value.schemaVersion !== 1 || !strings(value.toolCallIds) || !Array.isArray(value.settledBuiltinReads)
    || Object.keys(value).sort().join(",") !== "schemaVersion,settledBuiltinReads,toolCallIds" || !Number.isFinite(Date.parse(at))) reject();
  const inventory = value as unknown as HostAttemptEffectInventory;
  let settled: ReadonlyMap<string, string>;
  try { settled = assertUserInputDurableQuiescence(database, source.runId, source, Date.parse(at)); } catch { return reject(); }
  const covered = new Map(settled);
  for (const read of inventory.settledBuiltinReads) {
    if (!record(read) || !inventory.toolCallIds.includes(read.toolCallId)
      || !["read", "grep", "find", "ls"].includes(read.toolName)
      || Object.keys(read).sort().join(",") !== "toolCallId,toolName" || covered.has(read.toolCallId)) reject();
    covered.set(read.toolCallId, read.toolName);
  }
  const nativeIds: string[] = [];
  for (const candidate of ports.listArtifacts(source.runId)) {
    if (candidate.contentType !== nativeType || !record(candidate.sealedPayload) || !sameSource(candidate.sealedPayload.source, source)) continue;
    const receipt = readArtifact(ports, candidate.id, source.runId, nativeType);
    const payload = receipt.sealedPayload as Record<string, unknown>;
    if (payload.schemaVersion !== 1 || payload.boundary !== "native-file-mutation-completion" || payload.outcome !== "applied"
      || typeof payload.toolCallId !== "string" || !inventory.toolCallIds.includes(payload.toolCallId)
      || !["write", "edit"].includes(String(payload.toolName)) || !strings(payload.touchedPaths) || !payload.touchedPaths.length
      || !strings(payload.provenanceArtifactIds) || payload.provenanceArtifactIds.length !== 2
      || typeof payload.rawPatchSha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.rawPatchSha256)
      || Date.parse(receipt.createdAt) > Date.parse(at)) reject();
    verifyNativeProvenance(database, ports, source, payload);
    if (covered.has(payload.toolCallId) && covered.get(payload.toolCallId) !== payload.toolName) reject();
    covered.set(payload.toolCallId, String(payload.toolName));
    nativeIds.push(receipt.id);
  }
  if (inventory.toolCallIds.some(id => !covered.has(id)) || [...covered.keys()].some(id => !inventory.toolCallIds.includes(id))) reject();
  return nativeIds.sort();
}

function verifyNativeProvenance(database: DatabaseSync, ports: ReadPorts, source: HostOperationSource, receipt: Record<string, unknown>): void {
  const [forwardId, inverseId] = receipt.provenanceArtifactIds as string[];
  const forward = readArtifact(ports, forwardId!, source.runId, "application/json");
  readArtifact(ports, inverseId!, source.runId, "application/json");
  const plan = forward.sealedPayload as Record<string, unknown>;
  if (plan.rawPatchSha256 !== receipt.rawPatchSha256 || JSON.stringify(plan.touchedPaths) !== JSON.stringify(receipt.touchedPaths)
    || !Array.isArray(plan.operations) || !plan.operations.length) reject();
  const rows = database.prepare(`SELECT operation_index,path,operation,effect_state,inverse_patch_artifact_id,patch_plan_id
    FROM workspace_mutation_records WHERE run_id=? AND tool_call_id=? AND forward_patch_artifact_id=? ORDER BY operation_index`)
    .all(source.runId, String(receipt.toolCallId), forwardId!);
  if (rows.length !== plan.operations.length) reject();
  for (const [index, row] of rows.entries()) {
    const operation: unknown = plan.operations[index];
    if (!record(operation) || row.operation_index !== index || row.path !== operation.path || row.operation !== operation.kind
      || row.effect_state !== "applied" || row.inverse_patch_artifact_id !== inverseId || row.patch_plan_id !== `patch_plan_${forwardId}`) reject();
  }
}

function readArtifact(ports: Pick<Ports, "getArtifact">, id: string, runId: string, contentType: string) {
  const artifact = ports.getArtifact(id);
  if (!artifact || artifact.runId !== runId || artifact.type !== "json" || artifact.contentType !== contentType
    || !record(artifact.sealedPayload) || artifact.contentSha256 !== digest(artifact.sealedPayload)
    || !Number.isFinite(Date.parse(artifact.createdAt))) return reject();
  return artifact;
}
