import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  isConversationDomainRef,
  workspaceMutationEffectStates,
  workspaceMutationOperations,
  type CompactionCheckpoint,
  type CreateCompactionCheckpointInput,
  type CreateWorkspaceMutationRecordInput,
  type ListCompactionCheckpointsOptions,
  type ListWorkspaceMutationRecordsOptions,
  type WorkspaceMutationRecord,
} from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  parseJson,
  readNullableString,
  readNumber,
  readString,
  stringifyJson,
} from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export class SqliteWorkspaceProvenanceStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createWorkspaceMutationRecord(input: CreateWorkspaceMutationRecordInput): WorkspaceMutationRecord {
    const records = this.createWorkspaceMutationRecords([input]);
    const record = records[0];
    if (!record) throw new Error("Workspace mutation record was not created.");
    return record;
  }

  createWorkspaceMutationRecords(inputs: readonly CreateWorkspaceMutationRecordInput[]): WorkspaceMutationRecord[] {
    if (inputs.length === 0) return [];
    inputs.forEach(validateMutationInput);
    const workspaceIds = new Set(inputs.map((input) => normalizeRequired(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "workspace mutation workspace id")));
    if (workspaceIds.size !== 1) throw new Error("Workspace mutation batch must use one workspace.");
    const workspaceId = [...workspaceIds][0]!;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      inputs.forEach((input) => assertMutationReferences(this.context, input));
      const records: WorkspaceMutationRecord[] = [];
      const nextSequence = this.context.database.prepare(`
        INSERT INTO workspace_provenance_sequences (workspace_id, last_seq)
        VALUES (?, 1)
        ON CONFLICT(workspace_id) DO UPDATE SET last_seq = last_seq + 1
        RETURNING last_seq
      `);
      for (const input of inputs) {
        const sequenceRow = nextSequence.get(workspaceId) as Record<string, SQLOutputValue>;
        const record: WorkspaceMutationRecord = {
          id: input.id ?? `workspace_mutation_${randomUUID()}`,
          workspaceId,
          cwd: input.cwd,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.turnId ? { turnId: input.turnId } : {}),
          runId: input.runId,
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
          ...(input.artifactId ? { artifactId: input.artifactId } : {}),
          ...(input.forwardPatchArtifactId ? { forwardPatchArtifactId: input.forwardPatchArtifactId } : {}),
          patchPlanId: input.patchPlanId,
          operationIndex: input.operationIndex,
          path: input.path,
          operation: input.operation,
          beforeSha256: input.beforeSha256,
          afterSha256: input.afterSha256,
          inversePatchArtifactId: input.inversePatchArtifactId,
          provenanceSeq: readNumber(sequenceRow, "last_seq"),
          effectState: input.effectState ?? "applied",
          sourceRefs: uniqueDomainRefs(input.sourceRefs ?? []),
          createdAt: input.createdAt,
        };
      this.context.database.prepare(`
        INSERT INTO workspace_mutation_records (
          id, workspace_id, cwd, thread_id, turn_id, run_id, tool_call_id,
          approval_id, artifact_id, forward_patch_artifact_id, patch_plan_id,
          operation_index, path, operation, before_sha256, after_sha256,
          inverse_patch_artifact_id, provenance_seq, effect_state, source_refs_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.workspaceId,
        record.cwd,
        record.threadId ?? null,
        record.turnId ?? null,
        record.runId,
        record.toolCallId ?? null,
        record.approvalId ?? null,
        record.artifactId ?? null,
        record.forwardPatchArtifactId ?? null,
        record.patchPlanId,
        record.operationIndex,
        record.path,
        record.operation,
        record.beforeSha256,
        record.afterSha256,
        record.inversePatchArtifactId,
        record.provenanceSeq,
        record.effectState,
        stringifyJson(record.sourceRefs),
        record.createdAt,
      );
        records.push(record);
      }
      this.context.database.exec("COMMIT");
      return records;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  getWorkspaceMutationRecord(id: string): WorkspaceMutationRecord | undefined {
    const row = this.context.database.prepare(`${workspaceMutationSelectSql} WHERE id = ?`).get(id);
    return row ? mapWorkspaceMutationRecord(row as Record<string, SQLOutputValue>) : undefined;
  }

  listWorkspaceMutationRecords(options: ListWorkspaceMutationRecordsOptions = {}): WorkspaceMutationRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ["workspace_id", options.workspaceId],
      ["thread_id", options.threadId],
      ["turn_id", options.turnId],
      ["run_id", options.runId],
      ["patch_plan_id", options.patchPlanId],
      ["effect_state", options.effectState],
    ] as const) {
      if (value) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    params.push(Math.min(Math.max(options.limit ?? 500, 1), 2_000));
    return this.context.database.prepare(`
      ${workspaceMutationSelectSql}
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY provenance_seq ASC, operation_index ASC
      LIMIT ?
    `).all(...params).map((row) => mapWorkspaceMutationRecord(row as Record<string, SQLOutputValue>));
  }

  getLatestWorkspaceProvenanceWatermark(workspaceId = DEFAULT_WORKSPACE_ID): string {
    const row = this.context.database.prepare(`
      SELECT COALESCE(last_seq, 0) AS last_seq
      FROM workspace_provenance_sequences
      WHERE workspace_id = ?
    `).get(workspaceId) as Record<string, SQLOutputValue> | undefined;
    return `${workspaceId}:${row ? readNumber(row, "last_seq") : 0}`;
  }

  createCompactionCheckpoint(input: CreateCompactionCheckpointInput): CompactionCheckpoint {
    validateCheckpointInput(input);
    const workspaceId = normalizeRequired(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "compaction checkpoint workspace id");
    const coveredTurnIds = uniqueStrings(input.coveredTurnIds);
    const summaryIds = uniqueStrings(input.summaryIds ?? []);
    const sourceRefs = uniqueDomainRefs(input.sourceRefs);
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      assertCheckpointReferences(this.context, input.threadId, input.sourceTurnId, coveredTurnIds, summaryIds, input.coveredItemSeqFrom, input.coveredItemSeqTo);
      const currentWatermark = this.getLatestWorkspaceProvenanceWatermark(workspaceId);
      assertValidWatermark(input.workspaceProvenanceWatermark, workspaceId, currentWatermark);
      const checkpoint: CompactionCheckpoint = {
        id: input.id ?? `compaction_checkpoint_${randomUUID()}`,
        workspaceId,
        threadId: input.threadId,
        ...(input.channelId ? { channelId: input.channelId } : {}),
        sourceTurnId: input.sourceTurnId,
        ...(input.contextViewId ? { contextViewId: input.contextViewId } : {}),
        ...(input.contextViewCreatedAt ? { contextViewCreatedAt: input.contextViewCreatedAt } : {}),
        coveredItemSeqFrom: input.coveredItemSeqFrom,
        coveredItemSeqTo: input.coveredItemSeqTo,
        coveredTurnIds,
        summaryIds,
        ...(input.summaryContentSha256 ? { summaryContentSha256: input.summaryContentSha256 } : {}),
        sourceRefs,
        workspaceProvenanceWatermark: input.workspaceProvenanceWatermark,
        compactionPolicyVersion: input.compactionPolicyVersion,
        createdAt: input.createdAt,
      };
      this.context.database.prepare(`
        INSERT INTO compaction_checkpoints (
          id, workspace_id, thread_id, channel_id, source_turn_id, context_view_id,
          context_view_created_at, covered_item_seq_from, covered_item_seq_to,
          covered_turn_ids_json, summary_ids_json, summary_content_sha256,
          source_refs_json, workspace_provenance_watermark, compaction_policy_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpoint.id,
        checkpoint.workspaceId,
        checkpoint.threadId,
        checkpoint.channelId ?? null,
        checkpoint.sourceTurnId,
        checkpoint.contextViewId ?? null,
        checkpoint.contextViewCreatedAt ?? null,
        checkpoint.coveredItemSeqFrom,
        checkpoint.coveredItemSeqTo,
        stringifyJson(checkpoint.coveredTurnIds),
        stringifyJson(checkpoint.summaryIds),
        checkpoint.summaryContentSha256 ?? null,
        stringifyJson(checkpoint.sourceRefs),
        checkpoint.workspaceProvenanceWatermark,
        checkpoint.compactionPolicyVersion,
        checkpoint.createdAt,
      );
      this.context.database.exec("COMMIT");
      return checkpoint;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  getCompactionCheckpoint(id: string): CompactionCheckpoint | undefined {
    const row = this.context.database.prepare(`${compactionCheckpointSelectSql} WHERE id = ?`).get(id);
    return row ? mapCompactionCheckpoint(row as Record<string, SQLOutputValue>) : undefined;
  }

  listCompactionCheckpoints(options: ListCompactionCheckpointsOptions = {}): CompactionCheckpoint[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ["workspace_id", options.workspaceId],
      ["thread_id", options.threadId],
      ["source_turn_id", options.sourceTurnId],
    ] as const) {
      if (value) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    params.push(Math.min(Math.max(options.limit ?? 50, 1), 500));
    return this.context.database.prepare(`
      ${compactionCheckpointSelectSql}
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params).map((row) => mapCompactionCheckpoint(row as Record<string, SQLOutputValue>));
  }
}

const workspaceMutationSelectSql = `
  SELECT id, workspace_id, cwd, thread_id, turn_id, run_id, tool_call_id,
    approval_id, artifact_id, forward_patch_artifact_id, patch_plan_id,
    operation_index, path, operation, before_sha256, after_sha256,
    inverse_patch_artifact_id, provenance_seq, effect_state, source_refs_json,
    created_at
  FROM workspace_mutation_records
`;

const compactionCheckpointSelectSql = `
  SELECT id, workspace_id, thread_id, channel_id, source_turn_id, context_view_id,
    context_view_created_at, covered_item_seq_from, covered_item_seq_to,
    covered_turn_ids_json, summary_ids_json, summary_content_sha256,
    source_refs_json, workspace_provenance_watermark, compaction_policy_version,
    created_at
  FROM compaction_checkpoints
`;

function mapWorkspaceMutationRecord(row: Record<string, SQLOutputValue>): WorkspaceMutationRecord {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    cwd: readString(row, "cwd"),
    ...(readNullableString(row, "thread_id") ? { threadId: readNullableString(row, "thread_id") } : {}),
    ...(readNullableString(row, "turn_id") ? { turnId: readNullableString(row, "turn_id") } : {}),
    runId: readString(row, "run_id"),
    ...(readNullableString(row, "tool_call_id") ? { toolCallId: readNullableString(row, "tool_call_id") } : {}),
    ...(readNullableString(row, "approval_id") ? { approvalId: readNullableString(row, "approval_id") } : {}),
    ...(readNullableString(row, "artifact_id") ? { artifactId: readNullableString(row, "artifact_id") } : {}),
    ...(readNullableString(row, "forward_patch_artifact_id") ? { forwardPatchArtifactId: readNullableString(row, "forward_patch_artifact_id") } : {}),
    patchPlanId: readString(row, "patch_plan_id"),
    operationIndex: readNumber(row, "operation_index"),
    path: readString(row, "path"),
    operation: readString(row, "operation") as WorkspaceMutationRecord["operation"],
    beforeSha256: readString(row, "before_sha256"),
    afterSha256: readString(row, "after_sha256"),
    inversePatchArtifactId: readString(row, "inverse_patch_artifact_id"),
    provenanceSeq: readNumber(row, "provenance_seq"),
    effectState: readString(row, "effect_state") as WorkspaceMutationRecord["effectState"],
    sourceRefs: readDomainRefs(row, "source_refs_json"),
    createdAt: readString(row, "created_at"),
  };
}

function mapCompactionCheckpoint(row: Record<string, SQLOutputValue>): CompactionCheckpoint {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readString(row, "thread_id"),
    ...(readNullableString(row, "channel_id") ? { channelId: readNullableString(row, "channel_id") } : {}),
    sourceTurnId: readString(row, "source_turn_id"),
    ...(readNullableString(row, "context_view_id") ? { contextViewId: readNullableString(row, "context_view_id") } : {}),
    ...(readNullableString(row, "context_view_created_at") ? { contextViewCreatedAt: readNullableString(row, "context_view_created_at") } : {}),
    coveredItemSeqFrom: readNumber(row, "covered_item_seq_from"),
    coveredItemSeqTo: readNumber(row, "covered_item_seq_to"),
    coveredTurnIds: readStringArray(row, "covered_turn_ids_json"),
    summaryIds: readStringArray(row, "summary_ids_json"),
    ...(readNullableString(row, "summary_content_sha256") ? { summaryContentSha256: readNullableString(row, "summary_content_sha256") } : {}),
    sourceRefs: readDomainRefs(row, "source_refs_json"),
    workspaceProvenanceWatermark: readString(row, "workspace_provenance_watermark"),
    compactionPolicyVersion: readString(row, "compaction_policy_version"),
    createdAt: readString(row, "created_at"),
  };
}

function validateMutationInput(input: CreateWorkspaceMutationRecordInput): void {
  for (const [value, label] of [
    [input.cwd, "cwd"], [input.runId, "run id"], [input.patchPlanId, "patch plan id"],
    [input.path, "path"], [input.beforeSha256, "before hash"], [input.afterSha256, "after hash"],
    [input.inversePatchArtifactId, "inverse patch artifact id"],
  ] as const) normalizeRequired(value, `workspace mutation ${label}`);
  if (!Number.isSafeInteger(input.operationIndex) || input.operationIndex < 0) {
    throw new RangeError(`Invalid workspace mutation operation index: ${input.operationIndex}`);
  }
  if (!workspaceMutationOperations.includes(input.operation)) throw new Error(`Invalid workspace mutation operation: ${input.operation}`);
  if (input.effectState && !workspaceMutationEffectStates.includes(input.effectState)) throw new Error(`Invalid workspace mutation effect state: ${input.effectState}`);
  assertCanonicalTimestamp(input.createdAt);
  if ((input.sourceRefs ?? []).some((ref) => !isConversationDomainRef(ref))) throw new Error("Workspace mutation contains an invalid source ref.");
}

function validateCheckpointInput(input: CreateCompactionCheckpointInput): void {
  normalizeRequired(input.threadId, "compaction checkpoint thread id");
  normalizeRequired(input.sourceTurnId, "compaction checkpoint source turn id");
  normalizeRequired(input.workspaceProvenanceWatermark, "compaction checkpoint provenance watermark");
  normalizeRequired(input.compactionPolicyVersion, "compaction checkpoint policy version");
  if (!Number.isSafeInteger(input.coveredItemSeqFrom) || input.coveredItemSeqFrom < 1
    || !Number.isSafeInteger(input.coveredItemSeqTo) || input.coveredItemSeqTo < input.coveredItemSeqFrom) {
    throw new RangeError(`Invalid compaction checkpoint Item range: ${input.coveredItemSeqFrom}-${input.coveredItemSeqTo}`);
  }
  if (input.coveredTurnIds.length === 0) throw new Error("Compaction checkpoint must cover at least one Turn.");
  if (input.sourceRefs.some((ref) => !isConversationDomainRef(ref))) throw new Error("Compaction checkpoint contains an invalid source ref.");
  if (input.contextViewCreatedAt) assertCanonicalTimestamp(input.contextViewCreatedAt);
  assertCanonicalTimestamp(input.createdAt);
}

function assertMutationReferences(context: SqliteStoreContext, input: CreateWorkspaceMutationRecordInput): void {
  const run = context.database.prepare("SELECT thread_id FROM run_sessions WHERE id = ?").get(input.runId) as Record<string, SQLOutputValue> | undefined;
  if (!run) throw new Error(`Workspace mutation run not found: ${input.runId}`);
  const runThreadId = readNullableString(run, "thread_id");
  if (input.threadId && runThreadId && input.threadId !== runThreadId) throw new Error(`Workspace mutation thread does not match run: ${input.threadId}`);
  if (input.turnId) {
    const turn = context.database.prepare("SELECT thread_id FROM ling_turns WHERE id = ?").get(input.turnId) as Record<string, SQLOutputValue> | undefined;
    if (!turn) throw new Error(`Workspace mutation turn not found: ${input.turnId}`);
    if (input.threadId && readString(turn, "thread_id") !== input.threadId) throw new Error(`Workspace mutation turn belongs to another thread: ${input.turnId}`);
  }
}

function assertCheckpointReferences(
  context: SqliteStoreContext,
  threadId: string,
  sourceTurnId: string,
  coveredTurnIds: readonly string[],
  summaryIds: readonly string[],
  from: number,
  to: number,
): void {
  const sourceTurn = context.database.prepare("SELECT thread_id FROM ling_turns WHERE id = ?").get(sourceTurnId) as Record<string, SQLOutputValue> | undefined;
  if (!sourceTurn || readString(sourceTurn, "thread_id") !== threadId) throw new Error(`Compaction checkpoint source Turn does not belong to thread: ${sourceTurnId}`);
  for (const turnId of coveredTurnIds) {
    const turn = context.database.prepare("SELECT thread_id FROM ling_turns WHERE id = ?").get(turnId) as Record<string, SQLOutputValue> | undefined;
    if (!turn || readString(turn, "thread_id") !== threadId) throw new Error(`Compaction checkpoint covered Turn does not belong to thread: ${turnId}`);
  }
  for (const summaryId of summaryIds) {
    const summary = context.database.prepare("SELECT thread_id FROM conversation_context_summaries WHERE id = ?").get(summaryId) as Record<string, SQLOutputValue> | undefined;
    if (!summary || readString(summary, "thread_id") !== threadId) throw new Error(`Compaction checkpoint summary does not belong to thread: ${summaryId}`);
  }
  const range = context.database.prepare(`
    SELECT MIN(sequence) AS minimum, MAX(sequence) AS maximum, COUNT(*) AS count
    FROM conversation_items
    WHERE thread_id = ? AND sequence BETWEEN ? AND ? AND status = 'committed'
  `).get(threadId, from, to) as Record<string, SQLOutputValue>;
  if (readNumber(range, "count") !== to - from + 1 || readNumber(range, "minimum") !== from || readNumber(range, "maximum") !== to) {
    throw new Error(`Compaction checkpoint Item range is not committed in thread: ${threadId}/${from}-${to}`);
  }
}

function assertValidWatermark(value: string, workspaceId: string, current: string): void {
  const match = /^(.+):(\d+)$/u.exec(value);
  const currentMatch = /^(.+):(\d+)$/u.exec(current);
  if (!match || match[1] !== workspaceId || !currentMatch || Number(match[2]) > Number(currentMatch[2])) {
    throw new Error(`Invalid workspace provenance watermark: ${value}`);
  }
}

function readStringArray(row: Record<string, SQLOutputValue>, key: string): string[] {
  const value = parseJson(readString(row, key));
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Invalid string list in ${key}`);
  return value;
}

function readDomainRefs(row: Record<string, SQLOutputValue>, key: string) {
  const value = parseJson(readString(row, key));
  if (!Array.isArray(value) || value.some((ref) => !isConversationDomainRef(ref))) throw new Error(`Invalid domain refs in ${key}`);
  return value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeRequired(value, "list value")))];
}

function uniqueDomainRefs(values: readonly import("@ling-stack/contracts").ConversationDomainRef[]) {
  const seen = new Set<string>();
  return values.filter((ref) => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function assertCanonicalTimestamp(value: string): void {
  if (!canonicalTimestampPattern.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`Timestamp must be canonical UTC: ${value}`);
}
