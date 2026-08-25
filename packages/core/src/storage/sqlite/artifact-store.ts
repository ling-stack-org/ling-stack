import { createHash } from "node:crypto";
import {
  createArtifactId,
  type CreateRunArtifactInput,
  type RunArtifact,
} from "../../run-types.js";
import { omitUndefined } from "./helpers.js";
import { mapArtifact } from "./external-work-mappers.js";
import { artifactSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteArtifactStorePorts {
  readonly hasRun: (id: string) => boolean;
  readonly hasMediaJob: (id: string) => boolean;
  readonly hasExternalWorkRecord: (id: string) => boolean;
  readonly rebuildLingThreadMetadataForRun: (runId: string | undefined, now: string) => void;
}

export class SqliteArtifactStore {
  private readonly context: SqliteStoreContext;
  private readonly ports: SqliteArtifactStorePorts;

  constructor(context: SqliteStoreContext, ports: SqliteArtifactStorePorts) {
    this.context = context;
    this.ports = ports;
  }

  createArtifact(input: CreateRunArtifactInput): RunArtifact {
    const runId = normalizeOptionalOwnerId(input.runId);
    const mediaJobId = normalizeOptionalOwnerId(input.mediaJobId);
    const externalWorkId = normalizeOptionalOwnerId(input.externalWorkId);
    const ownerCount = [runId, mediaJobId, externalWorkId].filter(Boolean).length;
    if (ownerCount !== 1) {
      throw new Error("Artifact must belong to exactly one run, media job, or external work item.");
    }
    if (runId && !this.ports.hasRun(runId)) {
      throw new Error(`Run session not found: ${runId}`);
    }
    if (mediaJobId && !this.ports.hasMediaJob(mediaJobId)) {
      throw new Error(`Media job not found: ${mediaJobId}`);
    }
    if (externalWorkId && !this.ports.hasExternalWorkRecord(externalWorkId)) {
      throw new Error(`External work item not found: ${externalWorkId}`);
    }

    const artifact: RunArtifact = omitUndefined({
      id: input.id ?? createArtifactId(),
      runId,
      mediaJobId,
      externalWorkId,
      type: input.type,
      path: input.path,
      title: input.title,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sealedPayload: input.sealedPayload,
      contentSha256: input.sealedPayload === undefined
        ? undefined
        : sha256Json(input.sealedPayload),
      createdAt: input.createdAt,
    });
    if (input.contentSha256 !== undefined && input.contentSha256 !== artifact.contentSha256) {
      throw new Error(`Artifact sealed payload digest mismatch: ${artifact.id}`);
    }

    this.context.database
      .prepare(`
        INSERT INTO artifacts (
          id,
          run_id,
          media_job_id,
          external_work_id,
          type,
          path,
          title,
          content_type,
          size_bytes,
          sealed_payload_json,
          content_sha256,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        artifact.id,
        artifact.runId ?? null,
        artifact.mediaJobId ?? null,
        artifact.externalWorkId ?? null,
        artifact.type,
        artifact.path,
        artifact.title ?? null,
        artifact.contentType ?? null,
        artifact.sizeBytes ?? null,
        artifact.sealedPayload === undefined ? null : JSON.stringify(artifact.sealedPayload),
        artifact.contentSha256 ?? null,
        artifact.createdAt,
      );

    const created = this.getArtifact(artifact.id);
    if (!created) {
      throw new Error(`Failed to create artifact: ${artifact.id}`);
    }
    this.ports.rebuildLingThreadMetadataForRun(created.runId, created.createdAt);
    return created;
  }

  getArtifact(artifactId: string): RunArtifact | undefined {
    const row = this.context.database.prepare(artifactSelectSql("WHERE id = ?")).get(artifactId);
    return row ? mapArtifact(row) : undefined;
  }

  listArtifacts(runId: string): RunArtifact[] {
    return this.context.database
      .prepare(`${artifactSelectSql("WHERE run_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(runId)
      .map(mapArtifact);
  }

  listMediaJobArtifacts(mediaJobId: string): RunArtifact[] {
    return this.context.database
      .prepare(`${artifactSelectSql("WHERE media_job_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(mediaJobId)
      .map(mapArtifact);
  }

  listExternalWorkArtifacts(externalWorkId: string): RunArtifact[] {
    return this.context.database
      .prepare(`${artifactSelectSql("WHERE external_work_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(externalWorkId)
      .map(mapArtifact);
  }
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function normalizeOptionalOwnerId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
