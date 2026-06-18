import type { SQLOutputValue } from "node:sqlite";
import {
  createExternalWorkCiTriageId,
  type CreateExternalWorkCiTriageInput,
  type ExternalWorkCiTriageRecord,
  type ExternalWorkRecord,
  type ListExternalWorkCiTriageOptions,
  type UpdateExternalWorkCiTriageInput,
} from "../../external-work-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { nullableUpdate, omitUndefined, stringifyJson } from "./helpers.js";
import { mapExternalWorkCiTriage } from "./external-work-mappers.js";
import { externalWorkCiTriageSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteExternalWorkCiTriageStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly getExternalWorkRecord: (id: string) => ExternalWorkRecord | undefined;
}

export class SqliteExternalWorkCiTriageStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteExternalWorkCiTriageStorePorts,
  ) {}

  createExternalWorkCiTriage(input: CreateExternalWorkCiTriageInput, now: string): ExternalWorkCiTriageRecord {
    this.ports.assertChannelExists(input.channelId);
    const externalWork = this.ports.getExternalWorkRecord(input.externalWorkId);
    if (!externalWork) {
      throw new Error(`External work item not found: ${input.externalWorkId}`);
    }
    if (externalWork.channelId !== input.channelId) {
      throw new Error(`External work item does not belong to channel: ${input.channelId}`);
    }
    const existing = this.getExternalWorkCiTriageByFailureKey(input.sourceKind, input.failureKey);
    if (existing) {
      return existing;
    }

    const record: ExternalWorkCiTriageRecord = omitUndefined({
      id: createExternalWorkCiTriageId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      externalWorkId: input.externalWorkId,
      sourceKind: input.sourceKind,
      repository: input.repository,
      subjectKind: input.subjectKind,
      subjectNumber: input.subjectNumber,
      headSha: input.headSha,
      failureKey: input.failureKey,
      status: input.status,
      checkName: input.checkName,
      workflowName: input.workflowName,
      jobName: input.jobName,
      conclusion: input.conclusion,
      htmlUrl: input.htmlUrl,
      firstFailingCommand: input.firstFailingCommand,
      reproductionCommand: input.reproductionCommand,
      suspectedSourcePath: input.suspectedSourcePath,
      taskId: input.taskId,
      runId: input.runId,
      artifactIds: [...(input.artifactIds ?? [])],
      failure: input.failure,
      lastErrorCode: input.lastErrorCode,
      lastErrorMessage: input.lastErrorMessage,
      createdAt: now,
      updatedAt: now,
    });

    this.context.database
      .prepare(`
        INSERT INTO external_work_ci_triage (
          id,
          workspace_id,
          channel_id,
          external_work_id,
          source_kind,
          repository,
          subject_kind,
          subject_number,
          head_sha,
          failure_key,
          status,
          check_name,
          workflow_name,
          job_name,
          conclusion,
          html_url,
          first_failing_command,
          reproduction_command,
          suspected_source_path,
          task_id,
          run_id,
          artifact_ids_json,
          failure_json,
          last_error_code,
          last_error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.workspaceId,
        record.channelId,
        record.externalWorkId,
        record.sourceKind,
        record.repository,
        record.subjectKind,
        record.subjectNumber,
        record.headSha,
        record.failureKey,
        record.status,
        record.checkName,
        record.workflowName ?? null,
        record.jobName ?? null,
        record.conclusion,
        record.htmlUrl ?? null,
        record.firstFailingCommand ?? null,
        record.reproductionCommand ?? null,
        record.suspectedSourcePath ?? null,
        record.taskId ?? null,
        record.runId ?? null,
        stringifyJson(record.artifactIds),
        stringifyJson(record.failure),
        record.lastErrorCode ?? null,
        record.lastErrorMessage ?? null,
        record.createdAt,
        record.updatedAt,
      );

    const created = this.getExternalWorkCiTriage(record.id);
    if (!created) {
      throw new Error(`Failed to create external work CI triage: ${record.id}`);
    }
    return created;
  }

  getExternalWorkCiTriage(id: string): ExternalWorkCiTriageRecord | undefined {
    const row = this.context.database.prepare(externalWorkCiTriageSelectSql("WHERE id = ?")).get(id);
    return row ? mapExternalWorkCiTriage(row as Record<string, SQLOutputValue>) : undefined;
  }

  getExternalWorkCiTriageByFailureKey(
    sourceKind: ExternalWorkCiTriageRecord["sourceKind"],
    failureKey: string,
  ): ExternalWorkCiTriageRecord | undefined {
    const row = this.context.database
      .prepare(externalWorkCiTriageSelectSql("WHERE workspace_id = ? AND source_kind = ? AND failure_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceKind, failureKey);
    return row ? mapExternalWorkCiTriage(row as Record<string, SQLOutputValue>) : undefined;
  }

  listExternalWorkCiTriage(options: ListExternalWorkCiTriageOptions = {}): ExternalWorkCiTriageRecord[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${externalWorkCiTriageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapExternalWorkCiTriage(row as Record<string, SQLOutputValue>));
  }

  countExternalWorkCiTriage(options: Omit<ListExternalWorkCiTriageOptions, "limit"> = {}): number {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const row = this.context.database
      .prepare(`SELECT COUNT(*) AS count FROM external_work_ci_triage WHERE ${clauses.join(" AND ")}`)
      .get(...params) as { readonly count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  updateExternalWorkCiTriage(
    id: string,
    input: UpdateExternalWorkCiTriageInput,
    now: string,
  ): ExternalWorkCiTriageRecord | undefined {
    const existing = this.getExternalWorkCiTriage(id);
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare(`
        UPDATE external_work_ci_triage
        SET
          status = ?,
          first_failing_command = ?,
          reproduction_command = ?,
          suspected_source_path = ?,
          task_id = ?,
          run_id = ?,
          artifact_ids_json = ?,
          failure_json = ?,
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.status ?? existing.status,
        nullableUpdate(input.firstFailingCommand, existing.firstFailingCommand) ?? null,
        nullableUpdate(input.reproductionCommand, existing.reproductionCommand) ?? null,
        nullableUpdate(input.suspectedSourcePath, existing.suspectedSourcePath) ?? null,
        nullableUpdate(input.taskId, existing.taskId) ?? null,
        nullableUpdate(input.runId, existing.runId) ?? null,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        stringifyJson(input.failure ?? existing.failure),
        nullableUpdate(input.lastErrorCode, existing.lastErrorCode) ?? null,
        nullableUpdate(input.lastErrorMessage, existing.lastErrorMessage) ?? null,
        now,
        id,
      );
    return this.getExternalWorkCiTriage(id);
  }
}
