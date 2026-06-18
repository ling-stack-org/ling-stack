import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { redactSecrets } from "../../redaction.js";
import {
  createMediaJobId,
  type CreateMediaJobInput,
  type ListMediaJobsOptions,
  type MediaJob,
  type UpdateMediaJobStatusInput,
} from "../../media-types.js";
import { stringifyJson } from "./helpers.js";
import { mapMediaJob } from "./approval-media-mappers.js";
import { mediaJobSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteMediaStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  createMediaJob(input: CreateMediaJobInput, now: string): MediaJob {
    const job: MediaJob = {
      id: createMediaJobId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      providerPresetId: input.providerPresetId,
      operation: input.operation,
      prompt: input.prompt,
      input: input.input ?? {},
      artifactIds: [],
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO media_jobs (
          id,
          workspace_id,
          provider_preset_id,
          operation,
          prompt,
          input_json,
          artifact_ids_json,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        job.id,
        job.workspaceId,
        job.providerPresetId,
        job.operation,
        job.prompt,
        stringifyJson(redactSecrets(job.input)),
        stringifyJson(job.artifactIds),
        job.status,
        null,
        job.createdAt,
        job.updatedAt,
      );

    const created = this.getMediaJob(job.id);
    if (!created) {
      throw new Error(`Failed to create media job: ${job.id}`);
    }
    return created;
  }

  getMediaJob(id: string): MediaJob | undefined {
    const row = this.context.database.prepare(mediaJobSelectSql("WHERE id = ?")).get(id);
    return row ? mapMediaJob(row) : undefined;
  }

  listMediaJobs(options: ListMediaJobsOptions = {}): MediaJob[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.providerPresetId) {
      clauses.push("provider_preset_id = ?");
      params.push(options.providerPresetId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${mediaJobSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapMediaJob);
  }

  updateMediaJobStatus(id: string, input: UpdateMediaJobStatusInput, now: string): MediaJob | undefined {
    const existing = this.getMediaJob(id);
    if (!existing) {
      return undefined;
    }

    this.context.database
      .prepare(`
        UPDATE media_jobs
        SET
          status = ?,
          artifact_ids_json = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        input.errorMessage === undefined ? existing.errorMessage ?? null : input.errorMessage,
        now,
        id,
      );

    return this.getMediaJob(id);
  }
}
