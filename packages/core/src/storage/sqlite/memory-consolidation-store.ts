import type { SQLOutputValue } from "node:sqlite";
import {
  createMemoryConsolidationJobId,
  type CreateMemoryConsolidationJobInput,
  type ListMemoryConsolidationJobsOptions,
  type MemoryConsolidationJob,
  type MemoryConsolidationJobKind,
  type MemoryConsolidationJobStatus,
  type UpdateMemoryConsolidationJobInput,
} from "../../memory-consolidation-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import { mapMemoryConsolidationJob, normalizeMemorySourceRefs } from "./memory-mappers.js";
import { memoryConsolidationJobSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteMemoryConsolidationStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createMemoryConsolidationJob(input: CreateMemoryConsolidationJobInput, now: string): MemoryConsolidationJob {
    const id = input.id ?? createMemoryConsolidationJobId();
    const job: MemoryConsolidationJob = {
      id,
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      kind: input.kind,
      sourceRefs: normalizeMemorySourceRefs(input.sourceRefs ?? []),
      status: input.status ?? "queued",
      createdCandidateIds: normalizeStringList(input.createdCandidateIds ?? []),
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };
    validateMemoryConsolidationJob(job);
    this.context.database
      .prepare(`
        INSERT INTO memory_consolidation_jobs (
          id,
          workspace_id,
          kind,
          source_refs_json,
          status,
          created_candidate_ids_json,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        job.id,
        job.workspaceId,
        job.kind,
        stringifyJson(job.sourceRefs),
        job.status,
        stringifyJson(job.createdCandidateIds),
        job.errorMessage ?? null,
        job.createdAt,
        job.updatedAt,
      );
    const created = this.getMemoryConsolidationJob(job.id);
    if (!created) {
      throw new Error(`Failed to create memory consolidation job: ${job.id}`);
    }
    return created;
  }

  getMemoryConsolidationJob(id: string): MemoryConsolidationJob | undefined {
    const row = this.context.database.prepare(memoryConsolidationJobSelectSql("WHERE id = ?")).get(id);
    return row ? mapMemoryConsolidationJob(row as Record<string, SQLOutputValue>) : undefined;
  }

  listMemoryConsolidationJobs(options: ListMemoryConsolidationJobsOptions = {}): MemoryConsolidationJob[] {
    const clauses: string[] = ["workspace_id = ?"];
    const params: (string | number)[] = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${memoryConsolidationJobSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapMemoryConsolidationJob(row as Record<string, SQLOutputValue>));
  }

  updateMemoryConsolidationJob(id: string, input: UpdateMemoryConsolidationJobInput, now: string): MemoryConsolidationJob | undefined {
    const existing = this.getMemoryConsolidationJob(id);
    if (!existing) {
      return undefined;
    }
    const next: MemoryConsolidationJob = {
      ...existing,
      sourceRefs: input.sourceRefs ? normalizeMemorySourceRefs(input.sourceRefs) : existing.sourceRefs,
      status: input.status ?? existing.status,
      createdCandidateIds: input.createdCandidateIds ? normalizeStringList(input.createdCandidateIds) : existing.createdCandidateIds,
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };
    validateMemoryConsolidationJob(next);
    this.context.database
      .prepare(`
        UPDATE memory_consolidation_jobs
        SET
          source_refs_json = ?,
          status = ?,
          created_candidate_ids_json = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        stringifyJson(next.sourceRefs),
        next.status,
        stringifyJson(next.createdCandidateIds),
        next.errorMessage ?? null,
        next.updatedAt,
        id,
      );
    return this.getMemoryConsolidationJob(id);
  }
}

function validateMemoryConsolidationJob(job: MemoryConsolidationJob): void {
  if (!job.workspaceId.trim()) {
    throw new Error("workspaceId must be a non-empty string");
  }
  if (!isMemoryConsolidationJobKind(job.kind)) {
    throw new Error("memory consolidation job kind is not supported");
  }
  if (!isMemoryConsolidationJobStatus(job.status)) {
    throw new Error("memory consolidation job status is not supported");
  }
}

function isMemoryConsolidationJobKind(value: unknown): value is MemoryConsolidationJobKind {
  return value === "private_chat_summary" || value === "channel_decision_summary" || value === "task_run_lesson" || value === "workspace_consolidation";
}

function isMemoryConsolidationJobStatus(value: unknown): value is MemoryConsolidationJobStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item.toLowerCase())) {
      continue;
    }
    seen.add(item.toLowerCase());
    normalized.push(item);
  }
  return normalized;
}
