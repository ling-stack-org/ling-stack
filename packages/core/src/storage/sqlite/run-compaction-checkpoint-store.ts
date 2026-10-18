import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  RUN_COMPACTION_CHECKPOINT_BLOCKER_CODES,
  RUN_COMPACTION_CHECKPOINT_STATES,
  type CreateRunCompactionCheckpointInput,
  type ListRunCompactionCheckpointsOptions,
  type RunCompactionCheckpointV1,
  type TransitionRunCompactionCheckpointInput,
} from "@ling-stack/contracts";
import { parseJson, readNullableString, readNumber, readString, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { RunSession, RunStore } from "../../run-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { captureRunProgressCheckpointLineage } from "../../run-progress-checkpoint-lineage.js";
import { assertNoUnsettledHostFacts, readRunProgressEvents, validateRunProgressRecoveryBookkeeping } from "./run-progress-checkpoint-effects.js";

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const selectSql = `
  SELECT id, schema_version, run_id, attempt_id, source_event_seq, predecessor_id,
    context_snapshot_artifact_id, summary_artifact_id, summary_content_sha256,
    context_view_id, provider_name, provider_model,
    policy_version, policy_snapshot_fingerprint, workspace_provenance_watermark,
    objective, constraints_json, unresolved_tool_call_ids_json,
    unresolved_approval_ids_json, unresolved_question_ids_json, state, revision,
    blocker_code, blocker_detail, created_at, updated_at, committed_at
  FROM run_compaction_checkpoints
`;

/** Durable Run/Attempt compaction checkpoint reads and CAS transitions. */
export class SqliteRunCompactionCheckpointStore {
  constructor(private readonly context: SqliteStoreContext) {}

  create(input: CreateRunCompactionCheckpointInput): RunCompactionCheckpointV1 {
    validateCreateInput(input);
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.context.database.prepare(
        `${selectSql} WHERE run_id = ? AND attempt_id = ? AND source_event_seq = ?`,
      ).get(input.runId, input.attemptId, input.sourceEventSeq);
      if (existing) {
        const checkpoint = mapCheckpoint(existing as Record<string, SQLOutputValue>);
        assertSameCheckpointIdentity(checkpoint, input);
        this.context.database.exec("COMMIT");
        return checkpoint;
      }
      assertReferences(this.context, input);
      const latest = this.context.database.prepare(
        `${selectSql} WHERE run_id = ? ORDER BY source_event_seq DESC, created_at DESC, id DESC LIMIT 1`,
      ).get(input.runId);
      if (latest) {
        const prior = mapCheckpoint(latest as Record<string, SQLOutputValue>);
        if (input.predecessorId !== prior.id || prior.state !== "committed"
          || input.sourceEventSeq <= prior.sourceEventSeq) {
          throw new Error(`Compaction checkpoint predecessor is not the latest committed checkpoint: ${input.predecessorId ?? "none"}`);
        }
      } else if (input.predecessorId) {
        throw new Error(`Compaction checkpoint predecessor not found: ${input.predecessorId}`);
      }
      if (input.predecessorId) {
        const successor = this.context.database.prepare(
          `${selectSql} WHERE run_id = ? AND predecessor_id = ?`,
        ).get(input.runId, input.predecessorId);
        if (successor) {
          throw new Error(`Compaction checkpoint predecessor already has a successor: ${input.predecessorId}`);
        }
      }
      const now = input.createdAt;
      const checkpoint: RunCompactionCheckpointV1 = {
        schemaVersion: 1,
        id: input.id ?? `run_compaction_checkpoint_${randomUUID()}`,
        runId: input.runId,
        attemptId: input.attemptId,
        sourceEventSeq: input.sourceEventSeq,
        ...(input.predecessorId ? { predecessorId: input.predecessorId } : {}),
        contextSnapshotArtifactId: input.contextSnapshotArtifactId,
        summaryArtifactId: input.summaryArtifactId,
        summaryContentSha256: input.summaryContentSha256,
        ...(input.contextViewId ? { contextViewId: input.contextViewId } : {}),
        providerName: input.providerName,
        providerModel: input.providerModel,
        policyVersion: input.policyVersion,
        policySnapshotFingerprint: input.policySnapshotFingerprint,
        workspaceProvenanceWatermark: input.workspaceProvenanceWatermark,
        objective: input.objective,
        constraints: uniqueStrings(input.constraints ?? []),
        unresolvedToolCallIds: uniqueStrings(input.unresolvedToolCallIds ?? []),
        unresolvedApprovalIds: uniqueStrings(input.unresolvedApprovalIds ?? []),
        unresolvedQuestionIds: uniqueStrings(input.unresolvedQuestionIds ?? []),
        state: "prepared",
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.context.database.prepare(`
        INSERT INTO run_compaction_checkpoints (
          id, schema_version, run_id, attempt_id, source_event_seq, predecessor_id,
          context_snapshot_artifact_id, summary_artifact_id, summary_content_sha256,
          context_view_id, provider_name, provider_model,
          policy_version, policy_snapshot_fingerprint, workspace_provenance_watermark,
          objective, constraints_json, unresolved_tool_call_ids_json,
          unresolved_approval_ids_json, unresolved_question_ids_json, state, revision,
          blocker_code, blocker_detail, created_at, updated_at, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpoint.id,
        checkpoint.schemaVersion,
        checkpoint.runId,
        checkpoint.attemptId,
        checkpoint.sourceEventSeq,
        checkpoint.predecessorId ?? null,
        checkpoint.contextSnapshotArtifactId,
        checkpoint.summaryArtifactId,
        checkpoint.summaryContentSha256,
        checkpoint.contextViewId ?? null,
        checkpoint.providerName,
        checkpoint.providerModel,
        checkpoint.policyVersion,
        checkpoint.policySnapshotFingerprint,
        checkpoint.workspaceProvenanceWatermark,
        checkpoint.objective,
        stringifyJson(checkpoint.constraints),
        stringifyJson(checkpoint.unresolvedToolCallIds),
        stringifyJson(checkpoint.unresolvedApprovalIds),
        stringifyJson(checkpoint.unresolvedQuestionIds),
        checkpoint.state,
        checkpoint.revision,
        null,
        null,
        checkpoint.createdAt,
        checkpoint.updatedAt,
        null,
      );
      this.context.database.exec("COMMIT");
      return checkpoint;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  get(id: string): RunCompactionCheckpointV1 | undefined {
    const row = this.context.database.prepare(`${selectSql} WHERE id = ?`).get(id);
    return row ? mapCheckpoint(row as Record<string, SQLOutputValue>) : undefined;
  }

  getLatestForRun(runId: string): RunCompactionCheckpointV1 | undefined {
    const row = this.context.database.prepare(
      `${selectSql} WHERE run_id = ? ORDER BY source_event_seq DESC, created_at DESC, id DESC LIMIT 1`,
    ).get(runId);
    return row ? mapCheckpoint(row as Record<string, SQLOutputValue>) : undefined;
  }

  list(options: ListRunCompactionCheckpointsOptions = {}): RunCompactionCheckpointV1[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ["run_id", options.runId], ["attempt_id", options.attemptId], ["state", options.state],
    ] as const) {
      if (value) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    params.push(Math.min(Math.max(options.limit ?? 100, 1), 500));
    return this.context.database.prepare(`
      ${selectSql}
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY source_event_seq ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(...params).map((row) => mapCheckpoint(row as Record<string, SQLOutputValue>));
  }

  transition(input: TransitionRunCompactionCheckpointInput): RunCompactionCheckpointV1 | undefined {
    validateTransitionInput(input);
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(input.id);
      if (!current || current.revision !== input.expectedRevision || current.state !== "prepared") {
        this.context.database.exec("COMMIT");
        return undefined;
      }
      const blockerCode = input.state === "blocked" ? input.blockerCode : undefined;
      const updated = this.context.database.prepare(`
        UPDATE run_compaction_checkpoints
        SET state = ?, revision = revision + 1, blocker_code = ?, blocker_detail = ?,
            updated_at = ?, committed_at = ?
        WHERE id = ? AND revision = ? AND state = 'prepared'
          AND (? <> 'committed' OR EXISTS (
            SELECT 1 FROM run_sessions run
            JOIN work_units unit ON unit.id = run.work_unit_id
            JOIN work_unit_attempts attempt ON attempt.id = unit.active_attempt_id
            WHERE run.id = run_compaction_checkpoints.run_id
              AND run.status = 'running' AND unit.status = 'running'
              AND attempt.id = run_compaction_checkpoints.attempt_id
              AND attempt.status = 'started'
          ))
      `).run(
        input.state,
        blockerCode ?? null,
        input.blockerDetail ?? null,
        input.now,
        input.state === "committed" ? input.now : null,
        input.id,
        input.expectedRevision,
        input.state,
      );
      const next = Number(updated.changes) === 1 ? this.get(input.id) : undefined;
      this.context.database.exec("COMMIT");
      return next;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }
}

function mapCheckpoint(row: Record<string, SQLOutputValue>): RunCompactionCheckpointV1 {
  const state = readString(row, "state");
  if (!RUN_COMPACTION_CHECKPOINT_STATES.includes(state as RunCompactionCheckpointV1["state"])) {
    throw new Error(`Invalid compaction checkpoint state: ${state}`);
  }
  const blockerCode = readNullableString(row, "blocker_code");
  if (blockerCode && !RUN_COMPACTION_CHECKPOINT_BLOCKER_CODES.includes(blockerCode as NonNullable<RunCompactionCheckpointV1["blockerCode"]>)) {
    throw new Error(`Invalid compaction checkpoint blocker code: ${blockerCode}`);
  }
  return {
    schemaVersion: readNumber(row, "schema_version") as 1,
    id: readString(row, "id"),
    runId: readString(row, "run_id"),
    attemptId: readString(row, "attempt_id"),
    sourceEventSeq: readNumber(row, "source_event_seq"),
    ...(readNullableString(row, "predecessor_id") ? { predecessorId: readNullableString(row, "predecessor_id") } : {}),
    contextSnapshotArtifactId: readString(row, "context_snapshot_artifact_id"),
    summaryArtifactId: readString(row, "summary_artifact_id"),
    summaryContentSha256: readString(row, "summary_content_sha256"),
    ...(readNullableString(row, "context_view_id") ? { contextViewId: readNullableString(row, "context_view_id") } : {}),
    providerName: readString(row, "provider_name"),
    providerModel: readString(row, "provider_model"),
    policyVersion: readString(row, "policy_version"),
    policySnapshotFingerprint: readString(row, "policy_snapshot_fingerprint"),
    workspaceProvenanceWatermark: readString(row, "workspace_provenance_watermark"),
    objective: readString(row, "objective"),
    constraints: readStringArray(row, "constraints_json"),
    unresolvedToolCallIds: readStringArray(row, "unresolved_tool_call_ids_json"),
    unresolvedApprovalIds: readStringArray(row, "unresolved_approval_ids_json"),
    unresolvedQuestionIds: readStringArray(row, "unresolved_question_ids_json"),
    state: state as RunCompactionCheckpointV1["state"],
    revision: readNumber(row, "revision"),
    ...(blockerCode ? { blockerCode: blockerCode as RunCompactionCheckpointV1["blockerCode"] } : {}),
    ...(readNullableString(row, "blocker_detail") ? { blockerDetail: readNullableString(row, "blocker_detail") } : {}),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    ...(readNullableString(row, "committed_at") ? { committedAt: readNullableString(row, "committed_at") } : {}),
  };
}

function assertReferences(context: SqliteStoreContext, input: CreateRunCompactionCheckpointInput): void {
  const run = context.database.prepare("SELECT work_unit_id, context_view_id, status FROM run_sessions WHERE id = ?").get(input.runId) as Record<string, SQLOutputValue> | undefined;
  if (!run) throw new Error(`Compaction checkpoint Run not found: ${input.runId}`);
  const attempt = context.database.prepare("SELECT work_unit_id, status FROM work_unit_attempts WHERE id = ?").get(input.attemptId) as Record<string, SQLOutputValue> | undefined;
  if (!attempt) throw new Error(`Compaction checkpoint Attempt not found: ${input.attemptId}`);
  if (readNullableString(run, "work_unit_id") !== readString(attempt, "work_unit_id")) {
    throw new Error(`Compaction checkpoint Attempt does not belong to Run: ${input.attemptId}`);
  }
  const workUnit = context.database.prepare("SELECT active_attempt_id, status FROM work_units WHERE id = ?").get(readString(attempt, "work_unit_id")) as Record<string, SQLOutputValue> | undefined;
  if (!workUnit || readString(run, "status") !== "running" || readString(attempt, "status") !== "started"
    || readString(workUnit, "status") !== "running" || readNullableString(workUnit, "active_attempt_id") !== input.attemptId) {
    throw new Error(`Compaction checkpoint source Attempt is not the active execution owner: ${input.attemptId}`);
  }
  assertDurableReferences(context, input);
}

/** Shared sealed identity checks; historical recovery must not require the original live lease. */
function assertDurableReferences(context: SqliteStoreContext, input: CreateRunCompactionCheckpointInput): void {
  const sourceEvent = context.database.prepare("SELECT seq FROM run_events WHERE run_id = ? AND seq = ?")
    .get(input.runId, input.sourceEventSeq);
  if (!sourceEvent) throw new Error(`Compaction checkpoint source event not found: ${input.runId}/${input.sourceEventSeq}`);
  const latestStart = context.database.prepare(`
    SELECT seq, data_json FROM run_events WHERE run_id = ? AND type = 'context_compaction_start'
      AND seq <= ? ORDER BY seq DESC LIMIT 1
  `).get(input.runId, input.sourceEventSeq) as Record<string, SQLOutputValue> | undefined;
  const startData = latestStart ? parseJson(readString(latestStart, "data_json")) : undefined;
  if (!latestStart || typeof startData !== "object" || startData === null || Array.isArray(startData)
    || (readNumber(latestStart, "seq") === input.sourceEventSeq
      && (startData as Record<string, unknown>).attemptId !== input.attemptId)
    || (startData as Record<string, unknown>).checkpointArtifactId !== input.contextSnapshotArtifactId
    || (startData as Record<string, unknown>).policyVersion !== input.policyVersion) {
    throw new Error(`Compaction checkpoint source event lineage mismatch: ${input.runId}/${input.sourceEventSeq}`);
  }
  if (readNumber(latestStart, "seq") !== input.sourceEventSeq) {
    const previous = input.predecessorId ? context.database.prepare(
      `${selectSql} WHERE id = ? AND run_id = ? AND state = 'committed'`,
    ).get(input.predecessorId, input.runId) : undefined;
    const predecessor = previous ? mapCheckpoint(previous as Record<string, SQLOutputValue>) : undefined;
    const toolEnd = predecessor && context.database.prepare(`
      SELECT seq FROM run_events WHERE run_id = ? AND type = 'tool_end'
        AND seq > ? AND seq <= ? ORDER BY seq DESC LIMIT 1
    `).get(input.runId, predecessor.sourceEventSeq, input.sourceEventSeq);
    if (!predecessor || predecessor.contextSnapshotArtifactId !== input.contextSnapshotArtifactId
      || predecessor.sourceEventSeq < readNumber(latestStart, "seq") || !toolEnd) {
      throw new Error(`Compaction progress source event lineage mismatch: ${input.runId}/${input.sourceEventSeq}`);
    }
  }
  const artifact = context.database.prepare("SELECT run_id, content_type FROM artifacts WHERE id = ?").get(input.contextSnapshotArtifactId) as Record<string, SQLOutputValue> | undefined;
  if (!artifact || readString(artifact, "run_id") !== input.runId) {
    throw new Error(`Compaction checkpoint snapshot artifact does not belong to Run: ${input.contextSnapshotArtifactId}`);
  }
  if (readNullableString(artifact, "content_type") !== "application/vnd.ling.pi-compaction-context+json") {
    throw new Error(`Compaction checkpoint snapshot artifact has wrong content type: ${input.contextSnapshotArtifactId}`);
  }
  const summary = context.database.prepare("SELECT run_id, content_sha256 FROM artifacts WHERE id = ?").get(input.summaryArtifactId) as Record<string, SQLOutputValue> | undefined;
  if (!summary || readString(summary, "run_id") !== input.runId
    || readNullableString(summary, "content_sha256") !== input.summaryContentSha256) {
    throw new Error(`Compaction checkpoint summary artifact lineage or digest mismatch: ${input.summaryArtifactId}`);
  }
}

/**
 * Narrow domain routing only: naked start events cannot displace ordinary progress authority.
 * Full compacted model restoration remains the existing Daemon/Runner contract.
 */
export function hasCommittedRunCompactionReceipt(context: SqliteStoreContext, ports: RunStore,
  run: RunSession, sourceFence: RuntimeAttemptFenceV1, binding: {
    readonly contextSnapshotArtifactId: string; readonly runnerId: string; readonly runnerCapabilityRevision: string;
  }, recoveryTargetFence?: RuntimeAttemptFenceV1): boolean {
  try {
    const checkpoint = new SqliteRunCompactionCheckpointStore(context).getLatestForRun(run.id);
    const attempt = ports.getWorkUnitAttempt(sourceFence.attemptId);
    if (!checkpoint || checkpoint.state !== "committed" || !checkpoint.committedAt || !attempt
      || attempt.workUnitId !== sourceFence.workUnitId || attempt.id !== sourceFence.attemptId
      || attempt.runtimeInstanceId !== sourceFence.runtimeInstanceId || attempt.fencingToken !== sourceFence.fencingToken
      || attempt.workUnitId !== run.workUnitId || checkpoint.attemptId !== attempt.id
      || checkpoint.contextViewId !== run.contextViewId || checkpoint.providerName !== run.providerName
      || checkpoint.providerModel !== run.providerModel || checkpoint.unresolvedToolCallIds.length
      || checkpoint.unresolvedApprovalIds.length || checkpoint.unresolvedQuestionIds.length) return false;
    assertDurableReferences(context, { ...checkpoint, createdAt: checkpoint.createdAt });
    const start = context.database.prepare(`SELECT seq,data_json FROM run_events WHERE run_id=?
      AND type='context_compaction_start' ORDER BY seq DESC LIMIT 1`).get(run.id);
    const data: unknown = start && JSON.parse(String(start.data_json));
    if (!start || Number(start.seq) > checkpoint.sourceEventSeq || !record(data)
      || data.checkpointArtifactId !== checkpoint.contextSnapshotArtifactId) return false;
    const snapshot = context.database.prepare("SELECT * FROM artifacts WHERE id=?").get(checkpoint.contextSnapshotArtifactId);
    const summary = context.database.prepare("SELECT * FROM artifacts WHERE id=?").get(checkpoint.summaryArtifactId);
    const snapshotPayload: unknown = snapshot?.sealed_payload_json && JSON.parse(String(snapshot.sealed_payload_json));
    const summaryPayload: unknown = summary?.sealed_payload_json && JSON.parse(String(summary.sealed_payload_json));
    const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
    if (!snapshot || snapshot.type !== "json" || !record(snapshotPayload) || snapshot.content_sha256 !== hash(snapshotPayload)
      || snapshotPayload.schemaVersion !== 1 || snapshotPayload.boundary !== "pi-compaction-context"
      || snapshotPayload.runId !== run.id || snapshotPayload.attemptId !== data.attemptId
      || snapshotPayload.contextViewId !== run.contextViewId || snapshotPayload.model !== run.providerModel
      || !Array.isArray(snapshotPayload.messages) || !summary || summary.type !== "json"
      || summary.content_type !== "application/vnd.ling.run-compaction-summary+json"
      || !record(summaryPayload) || summary.content_sha256 !== hash(summaryPayload)
      || summaryPayload.schemaVersion !== 1 || !["run-compaction-summary", "run-compaction-progress"].includes(String(summaryPayload.boundary))
      || summaryPayload.runId !== run.id || summaryPayload.attemptId !== checkpoint.attemptId
      || summaryPayload.sourceEventSeq !== checkpoint.sourceEventSeq || typeof summaryPayload.summary !== "string"
      || !summaryPayload.summary.trim() || !Array.isArray(summaryPayload.modelView)) return false;
    const lineage = captureRunProgressCheckpointLineage(ports, run).lineage;
    if (checkpoint.policySnapshotFingerprint !== lineage.policySnapshotFingerprint
      || checkpoint.workspaceProvenanceWatermark !== lineage.workspaceProvenanceWatermark) return false;
    // Activation consumes a sealed replay package, not the raw SDK snapshot.
    // Its captured refs must include this exact checkpoint's two content inputs.
    const replayArtifact = context.database.prepare("SELECT * FROM artifacts WHERE id=?").get(binding.contextSnapshotArtifactId);
    const replay: unknown = replayArtifact?.sealed_payload_json && JSON.parse(String(replayArtifact.sealed_payload_json));
    if (!replayArtifact || replayArtifact.run_id !== run.id || replayArtifact.type !== "json"
      || replayArtifact.content_type !== "application/vnd.ling.runner-continuation-replay+json"
      || !record(replay) || replayArtifact.content_sha256 !== hash(replay)) return false;
    const { fingerprint, ...replayBody } = replay;
    const replayFence = record(replay.sourceFence) ? replay.sourceFence : undefined;
    if (replay.schemaVersion !== 1 || replay.boundary !== "runner-continuation-replay" || fingerprint !== hash(replayBody)
      || replay.runId !== run.id || replay.sourceRunId !== run.id || replay.workUnitId !== sourceFence.workUnitId
      || replay.sourceWorkUnitId !== sourceFence.workUnitId || replay.origin !== "daemon_recovery"
      || replay.contextViewId !== run.contextViewId || replay.runnerId !== binding.runnerId
      || replay.runnerCapabilityRevision !== binding.runnerCapabilityRevision
      || !replayFence || replayFence.workUnitId !== sourceFence.workUnitId || replayFence.attemptId !== sourceFence.attemptId
      || replayFence.runtimeInstanceId !== sourceFence.runtimeInstanceId || replayFence.fencingToken !== sourceFence.fencingToken
      || replay.policySnapshotFingerprint !== lineage.policySnapshotFingerprint
      || replay.preparedExecutionFingerprint !== lineage.preparedExecutionFingerprint
      || replay.acceptedInstructionsFingerprint !== lineage.acceptedInstructionsFingerprint
      || hash(replay.execution) !== lineage.preparedExecutionFingerprint || !Array.isArray(replay.artifactRefs)
      || !replay.artifactRefs.includes(checkpoint.contextSnapshotArtifactId) || !replay.artifactRefs.includes(checkpoint.summaryArtifactId)) return false;
    const events = readRunProgressEvents(ports, run.id);
    const recoveryBookkeeping: typeof events = [];
    let installed = checkpoint.sourceEventSeq > Number(start.seq);
    for (const event of events.filter(event => event.seq > checkpoint.sourceEventSeq)) {
      if (!installed && event.type === "context_compaction_end" && event.data.attemptId === checkpoint.attemptId
        && event.data.outcome === "sdk_installed") { installed = true; continue; }
      if (!installed && ["assistant_text_delta", "assistant_thinking_delta", "assistant_reasoning_summary",
        "message_end", "turn_start", "turn_end"].includes(event.type)) continue;
      if (event.type === "turn_end") continue;
      if (event.type === "artifact_created" && record(event.data.artifact)
        && event.data.artifact.id === checkpoint.contextSnapshotArtifactId) continue;
      // Pi starts the next logical turn after installing an initial compaction view,
      // before the next provider request has produced any observable progress.
      if (installed && event.type === "turn_start" && event.data.attemptId === sourceFence.attemptId) continue;
      if (installed && recoveryTargetFence && ["run_start", "turn_start"].includes(event.type)) {
        recoveryBookkeeping.push(event); continue;
      }
      return false;
    }
    if (recoveryTargetFence) validateRunProgressRecoveryBookkeeping(run, recoveryBookkeeping, recoveryTargetFence.attemptId);
    if (!installed || !events.some(event => event.type === "context_compaction_end" && event.seq > Number(start.seq)
      && event.data.attemptId === data.attemptId && event.data.outcome === "sdk_installed")
      || ports.listHarnessToolExecutions(run.id).some(execution => !["succeeded", "denied", "failed", "cancelled", "superseded"].includes(execution.state))
      || ports.listHostCommandWriteBlockers(run.cwd).some(item => item.runId === run.id)
      || ports.listApprovalRequests({ runId: run.id, status: "pending", limit: 1 }).length) return false;
    assertNoUnsettledHostFacts(context.database, ports, run.id, sourceFence.workUnitId);
    return true;
  } catch { return false; }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

function assertSameCheckpointIdentity(current: RunCompactionCheckpointV1, input: CreateRunCompactionCheckpointInput): void {
  if (current.contextSnapshotArtifactId !== input.contextSnapshotArtifactId
    || current.summaryArtifactId !== input.summaryArtifactId
    || current.summaryContentSha256 !== input.summaryContentSha256
    || current.attemptId !== input.attemptId
    || current.sourceEventSeq !== input.sourceEventSeq
    || current.predecessorId !== input.predecessorId
    || current.contextViewId !== input.contextViewId
    || current.providerName !== input.providerName
    || current.providerModel !== input.providerModel
    || current.policyVersion !== input.policyVersion
    || current.policySnapshotFingerprint !== input.policySnapshotFingerprint
    || current.workspaceProvenanceWatermark !== input.workspaceProvenanceWatermark
    || current.objective !== input.objective
    || JSON.stringify(current.constraints) !== JSON.stringify(uniqueStrings(input.constraints ?? []))
    || JSON.stringify(current.unresolvedToolCallIds) !== JSON.stringify(uniqueStrings(input.unresolvedToolCallIds ?? []))
    || JSON.stringify(current.unresolvedApprovalIds) !== JSON.stringify(uniqueStrings(input.unresolvedApprovalIds ?? []))
    || JSON.stringify(current.unresolvedQuestionIds) !== JSON.stringify(uniqueStrings(input.unresolvedQuestionIds ?? []))) {
    throw new Error(`Compaction checkpoint identity conflict: ${current.id}`);
  }
}

function validateCreateInput(input: CreateRunCompactionCheckpointInput): void {
  for (const [value, label] of [
    [input.runId, "run id"], [input.attemptId, "attempt id"], [input.contextSnapshotArtifactId, "snapshot artifact id"],
    [input.summaryArtifactId, "summary artifact id"],
    [input.providerName, "provider name"], [input.providerModel, "provider model"], [input.policyVersion, "policy version"],
    [input.policySnapshotFingerprint, "policy snapshot fingerprint"], [input.workspaceProvenanceWatermark, "workspace provenance watermark"],
    [input.objective, "objective"], [input.createdAt, "created at"],
  ] as const) {
    if (!value.trim()) throw new Error(`Compaction checkpoint ${label} must not be empty.`);
  }
  if (!Number.isSafeInteger(input.sourceEventSeq) || input.sourceEventSeq < 1) throw new RangeError("Compaction checkpoint source event seq must be positive.");
  if (!/^[0-9a-f]{64}$/u.test(input.summaryContentSha256)) throw new Error("Compaction checkpoint summary digest must be SHA-256.");
  assertTimestamp(input.createdAt);
}

function validateTransitionInput(input: TransitionRunCompactionCheckpointInput): void {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new RangeError("Invalid compaction checkpoint revision.");
  assertTimestamp(input.now);
  if (input.state === "blocked" && !input.blockerCode) throw new Error("Blocked compaction checkpoint requires a blocker code.");
  if (input.blockerCode && !RUN_COMPACTION_CHECKPOINT_BLOCKER_CODES.includes(input.blockerCode)) throw new Error(`Invalid compaction checkpoint blocker code: ${input.blockerCode}`);
}

function readStringArray(row: Record<string, SQLOutputValue>, key: string): string[] {
  const value = parseJson(readString(row, key));
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Invalid string list in ${key}`);
  return value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => {
    if (!value.trim()) throw new Error("Compaction checkpoint list values must not be empty.");
    return value;
  }))];
}

function assertTimestamp(value: string): void {
  if (!timestampPattern.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`Timestamp must be canonical UTC: ${value}`);
}
