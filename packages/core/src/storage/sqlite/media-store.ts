import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { redactSecrets } from "../../redaction.js";
import {
  createMediaProjectId,
  createMediaProjectAssetId,
  createMediaJobId,
  createMediaSceneId,
  createMediaSceneRunId,
  type CreateMediaProjectInput,
  type CreateMediaProjectAssetInput,
  type CreateMediaJobInput,
  type CreateMediaSceneInput,
  type CreateMediaSceneRunInput,
  type ListMediaJobsOptions,
  type MediaCanvasPosition,
  type MediaCanvasViewport,
  type MediaJobExecutionHandle,
  type MediaJob,
  type MediaProject,
  type MediaProjectAsset,
  type MediaScene,
  type MediaSceneRun,
  type UpdateMediaProjectInput,
  type UpdateMediaJobStatusInput,
  type UpdateMediaSceneInput,
  type UpsertMediaJobExecutionHandleInput,
} from "../../media-types.js";
import { stringifyJson } from "./helpers.js";
import { mapMediaJob } from "./approval-media-mappers.js";
import {
  mapMediaJobExecutionHandle,
  mapMediaProject,
  mapMediaProjectAsset,
  mapMediaScene,
  mapMediaSceneRun,
} from "./media-production-mappers.js";
import { mediaJobSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteMediaStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  createMediaJob(input: CreateMediaJobInput, now: string): MediaJob {
    const executionSource = normalizeMediaExecutionSource(input);
    const job: MediaJob = {
      id: createMediaJobId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      providerPresetId: executionSource.kind === "provider" ? executionSource.providerPresetId : undefined,
      workflowVersionId: executionSource.kind === "workflow" ? executionSource.workflowVersionId : undefined,
      executionSource,
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
          source_kind,
          provider_preset_id,
          workflow_version_id,
          operation,
          prompt,
          input_json,
          artifact_ids_json,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        job.id,
        job.workspaceId,
        job.executionSource.kind,
        job.providerPresetId ?? null,
        job.workflowVersionId ?? null,
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
    const expected = input.expectedStatuses;
    if (expected && (expected.length === 0 || expected.some(status =>
      !["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"].includes(status)))) {
      throw new Error("Media status comparison requires valid non-empty expected statuses.");
    }
    const existing = this.getMediaJob(id);
    if (!existing) {
      return undefined;
    }

    const result = this.context.database
      .prepare(`
        UPDATE media_jobs
        SET
          status = ?,
          artifact_ids_json = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?${expected ? ` AND status IN (${expected.map(() => "?").join(",")})` : ""}
      `)
      .run(
        input.status,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        input.errorMessage === undefined ? existing.errorMessage ?? null : input.errorMessage,
        now,
        id,
        ...(expected ?? []),
      );
    if (Number(result.changes) === 0) return undefined;
    return this.getMediaJob(id);
  }

  createMediaProject(input: CreateMediaProjectInput, now: string): MediaProject {
    const project: MediaProject = {
      id: createMediaProjectId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: input.name.trim(),
      defaultProviderPresetId: input.defaultProviderPresetId,
      defaultExecutionMode: input.defaultExecutionMode ?? "direct",
      defaultWorkflowDefinitionId: input.defaultWorkflowDefinitionId,
      canvasViewport: normalizeCanvasViewport(input.canvasViewport),
      createdAt: now,
      updatedAt: now,
    };
    if (!project.name) {
      throw new Error("Media project name is required");
    }

    this.context.database
      .prepare(`
        INSERT INTO media_projects (
          id, workspace_id, name, default_provider_preset_id, default_execution_mode,
          default_workflow_definition_id, canvas_viewport_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        project.id,
        project.workspaceId,
        project.name,
        project.defaultProviderPresetId ?? null,
        project.defaultExecutionMode,
        project.defaultWorkflowDefinitionId ?? null,
        stringifyJson(project.canvasViewport),
        project.createdAt,
        project.updatedAt,
      );

    const created = this.getMediaProject(project.id);
    if (!created) {
      throw new Error(`Failed to create media project: ${project.id}`);
    }
    return created;
  }

  getMediaProject(id: string): MediaProject | undefined {
    const row = this.context.database.prepare(`
      SELECT id, workspace_id, name, default_provider_preset_id, default_execution_mode,
             default_workflow_definition_id, canvas_viewport_json, created_at, updated_at
      FROM media_projects
      WHERE id = ? AND workspace_id = ?
    `).get(id, DEFAULT_WORKSPACE_ID);
    return row ? mapMediaProject(row) : undefined;
  }

  listMediaProjects(): MediaProject[] {
    return this.context.database.prepare(`
      SELECT id, workspace_id, name, default_provider_preset_id, default_execution_mode,
             default_workflow_definition_id, canvas_viewport_json, created_at, updated_at
      FROM media_projects
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(DEFAULT_WORKSPACE_ID).map(mapMediaProject);
  }

  createMediaProjectAsset(input: CreateMediaProjectAssetInput, now: string): MediaProjectAsset {
    const project = this.getMediaProject(input.projectId);
    if (!project) {
      throw new Error(`Media project not found: ${input.projectId}`);
    }
    const asset: MediaProjectAsset = {
      id: input.id ?? createMediaProjectAssetId(),
      projectId: project.id,
      fileName: input.fileName.trim(),
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      width: input.width,
      height: input.height,
      checksum: input.checksum,
      sourceArtifactId: input.sourceArtifactId,
      path: input.path,
      createdAt: now,
    };
    assertMediaProjectAssetValues(asset);
    this.context.database.prepare(`
      INSERT INTO media_project_assets (
        id, workspace_id, project_id, file_name, content_type, size_bytes, width, height,
        checksum, source_artifact_id, path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, project_id, checksum) DO NOTHING
    `).run(
      asset.id,
      DEFAULT_WORKSPACE_ID,
      asset.projectId,
      asset.fileName,
      asset.contentType,
      asset.sizeBytes,
      asset.width,
      asset.height,
      asset.checksum,
      asset.sourceArtifactId ?? null,
      asset.path,
      asset.createdAt,
    );
    const created = this.findMediaProjectAssetByChecksum(asset.projectId, asset.checksum);
    if (!created) {
      throw new Error(`Failed to create media project asset: ${asset.id}`);
    }
    return created;
  }

  getMediaProjectAsset(id: string): MediaProjectAsset | undefined {
    const row = this.context.database.prepare(`${mediaProjectAssetSelectSql("WHERE id = ? AND workspace_id = ?")}`)
      .get(id, DEFAULT_WORKSPACE_ID);
    return row ? mapMediaProjectAsset(row) : undefined;
  }

  listMediaProjectAssets(projectId: string): MediaProjectAsset[] {
    return this.context.database.prepare(`${mediaProjectAssetSelectSql("WHERE project_id = ? AND workspace_id = ?")} ORDER BY created_at DESC`)
      .all(projectId, DEFAULT_WORKSPACE_ID)
      .map(mapMediaProjectAsset);
  }

  findMediaProjectAssetByChecksum(projectId: string, checksum: string): MediaProjectAsset | undefined {
    const row = this.context.database.prepare(`${mediaProjectAssetSelectSql("WHERE project_id = ? AND workspace_id = ? AND checksum = ?")}`)
      .get(projectId, DEFAULT_WORKSPACE_ID, checksum);
    return row ? mapMediaProjectAsset(row) : undefined;
  }

  deleteMediaProjectAsset(id: string): boolean {
    const asset = this.getMediaProjectAsset(id);
    if (!asset) {
      return false;
    }
    const inUse = this.listMediaScenes(asset.projectId)
      .some((scene) => scene.videoImageInputs.some((input) => input.assetId === asset.id));
    if (inUse) {
      throw new Error(`Media project asset is in use: ${id}`);
    }
    return this.context.database.prepare("DELETE FROM media_project_assets WHERE id = ? AND workspace_id = ?")
      .run(id, DEFAULT_WORKSPACE_ID).changes > 0;
  }

  updateMediaProject(id: string, input: UpdateMediaProjectInput, now: string): MediaProject | undefined {
    const existing = this.getMediaProject(id);
    if (!existing) {
      return undefined;
    }
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) {
      throw new Error("Media project name is required");
    }
    const defaultProviderPresetId = input.defaultProviderPresetId === undefined
      ? existing.defaultProviderPresetId
      : input.defaultProviderPresetId ?? undefined;
    const defaultWorkflowDefinitionId = input.defaultWorkflowDefinitionId === undefined
      ? existing.defaultWorkflowDefinitionId
      : input.defaultWorkflowDefinitionId ?? undefined;
    const canvasViewport = input.canvasViewport === undefined
      ? existing.canvasViewport
      : normalizeCanvasViewport(input.canvasViewport);

    this.context.database.prepare(`
      UPDATE media_projects
      SET name = ?, default_provider_preset_id = ?, default_execution_mode = ?,
          default_workflow_definition_id = ?, canvas_viewport_json = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(
      name,
      defaultProviderPresetId ?? null,
      input.defaultExecutionMode ?? existing.defaultExecutionMode,
      defaultWorkflowDefinitionId ?? null,
      stringifyJson(canvasViewport),
      now,
      id,
      DEFAULT_WORKSPACE_ID,
    );
    return this.getMediaProject(id);
  }

  deleteMediaProject(id: string): boolean {
    return this.context.database
      .prepare("DELETE FROM media_projects WHERE id = ? AND workspace_id = ?")
      .run(id, DEFAULT_WORKSPACE_ID).changes > 0;
  }

  createMediaScene(input: CreateMediaSceneInput, now: string): MediaScene {
    const project = this.getMediaProject(input.projectId);
    if (!project) {
      throw new Error(`Media project not found: ${input.projectId}`);
    }
    const title = input.title.trim();
    if (!title) {
      throw new Error("Media scene title is required");
    }
    const scene: MediaScene = {
      id: createMediaSceneId(),
      projectId: project.id,
      sortOrder: input.sortOrder ?? this.nextMediaSceneSortOrder(project.id),
      title,
      prompt: input.prompt,
      providerPresetId: input.providerPresetId,
      executionMode: input.executionMode ?? "inherit",
      workflowDefinitionId: input.workflowDefinitionId,
      workflowInputValues: { ...(input.workflowInputValues ?? {}) },
      ratio: input.ratio ?? "16:9",
      durationSeconds: input.durationSeconds ?? 5,
      referenceArtifactIds: [...(input.referenceArtifactIds ?? [])],
      videoImageInputs: [...(input.videoImageInputs ?? [])],
      canvasPosition: normalizeCanvasPosition(input.canvasPosition),
      createdAt: now,
      updatedAt: now,
    };
    assertMediaSceneValues(scene);
    this.assertMediaSceneVideoImageInputs(scene);

    this.context.database.prepare(`
      INSERT INTO media_scenes (
        id, project_id, sort_order, title, prompt, provider_preset_id, ratio, duration_seconds,
        execution_mode, workflow_definition_id, workflow_input_values_json,
        reference_artifact_ids_json, video_image_inputs_json, canvas_position_json,
        selected_media_scene_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scene.id,
      scene.projectId,
      scene.sortOrder,
      scene.title,
      scene.prompt,
      scene.providerPresetId ?? null,
      scene.ratio,
      scene.durationSeconds,
      scene.executionMode,
      scene.workflowDefinitionId ?? null,
      stringifyJson(scene.workflowInputValues),
      stringifyJson(scene.referenceArtifactIds),
      stringifyJson(scene.videoImageInputs),
      stringifyJson(scene.canvasPosition),
      null,
      scene.createdAt,
      scene.updatedAt,
    );
    const created = this.getMediaScene(scene.id);
    if (!created) {
      throw new Error(`Failed to create media scene: ${scene.id}`);
    }
    return created;
  }

  getMediaScene(id: string): MediaScene | undefined {
    const row = this.context.database.prepare(mediaSceneSelectSql("WHERE id = ?")).get(id);
    return row ? mapMediaScene(row) : undefined;
  }

  listMediaScenes(projectId: string): MediaScene[] {
    return this.context.database.prepare(`${mediaSceneSelectSql("WHERE project_id = ?")} ORDER BY sort_order ASC, created_at ASC`)
      .all(projectId)
      .map(mapMediaScene);
  }

  updateMediaScene(id: string, input: UpdateMediaSceneInput, now: string): MediaScene | undefined {
    const existing = this.getMediaScene(id);
    if (!existing) {
      return undefined;
    }
    const scene: MediaScene = {
      ...existing,
      sortOrder: input.sortOrder ?? existing.sortOrder,
      title: input.title === undefined ? existing.title : input.title.trim(),
      prompt: input.prompt ?? existing.prompt,
      providerPresetId: input.providerPresetId === undefined ? existing.providerPresetId : input.providerPresetId ?? undefined,
      executionMode: input.executionMode ?? existing.executionMode,
      workflowDefinitionId: input.workflowDefinitionId === undefined ? existing.workflowDefinitionId : input.workflowDefinitionId ?? undefined,
      workflowInputValues: input.workflowInputValues === undefined ? existing.workflowInputValues : { ...input.workflowInputValues },
      ratio: input.ratio ?? existing.ratio,
      durationSeconds: input.durationSeconds ?? existing.durationSeconds,
      referenceArtifactIds: input.referenceArtifactIds === undefined ? existing.referenceArtifactIds : [...input.referenceArtifactIds],
      videoImageInputs: input.videoImageInputs === undefined ? existing.videoImageInputs : [...input.videoImageInputs],
      canvasPosition: input.canvasPosition === undefined ? existing.canvasPosition : normalizeCanvasPosition(input.canvasPosition),
      selectedMediaSceneRunId: input.selectedMediaSceneRunId === undefined
        ? existing.selectedMediaSceneRunId
        : input.selectedMediaSceneRunId ?? undefined,
      updatedAt: now,
    };
    assertMediaSceneValues(scene);
    this.assertMediaSceneVideoImageInputs(scene);

    this.context.database.prepare(`
      UPDATE media_scenes
      SET sort_order = ?, title = ?, prompt = ?, provider_preset_id = ?, ratio = ?, duration_seconds = ?,
          execution_mode = ?, workflow_definition_id = ?, workflow_input_values_json = ?,
          reference_artifact_ids_json = ?, video_image_inputs_json = ?, canvas_position_json = ?,
          selected_media_scene_run_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      scene.sortOrder,
      scene.title,
      scene.prompt,
      scene.providerPresetId ?? null,
      scene.ratio,
      scene.durationSeconds,
      scene.executionMode,
      scene.workflowDefinitionId ?? null,
      stringifyJson(scene.workflowInputValues),
      stringifyJson(scene.referenceArtifactIds),
      stringifyJson(scene.videoImageInputs),
      stringifyJson(scene.canvasPosition),
      scene.selectedMediaSceneRunId ?? null,
      scene.updatedAt,
      scene.id,
    );
    return this.getMediaScene(id);
  }

  reorderMediaScenes(projectId: string, sceneIds: readonly string[], now: string): MediaScene[] {
    const existing = this.listMediaScenes(projectId);
    if (existing.length !== sceneIds.length || new Set(sceneIds).size !== sceneIds.length) {
      throw new Error("Media scene order must contain every scene exactly once");
    }
    const existingIds = new Set(existing.map((scene) => scene.id));
    if (sceneIds.some((sceneId) => !existingIds.has(sceneId))) {
      throw new Error("Media scene order includes a scene outside this project");
    }

    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.context.database.prepare(`
        UPDATE media_scenes SET sort_order = ?, updated_at = ? WHERE id = ? AND project_id = ?
      `);
      sceneIds.forEach((sceneId, sortOrder) => statement.run(sortOrder, now, sceneId, projectId));
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    return this.listMediaScenes(projectId);
  }

  deleteMediaScene(id: string): boolean {
    return this.context.database.prepare("DELETE FROM media_scenes WHERE id = ?").run(id).changes > 0;
  }

  createMediaSceneRun(input: CreateMediaSceneRunInput, now: string): MediaSceneRun {
    const run: MediaSceneRun = {
      id: createMediaSceneRunId(),
      projectId: input.projectId,
      sceneId: input.sceneId,
      mediaJobId: input.mediaJobId,
      providerSnapshot: redactSecrets(input.providerSnapshot) as Record<string, unknown>,
      executionSnapshot: redactSecrets(input.executionSnapshot ?? input.providerSnapshot) as Record<string, unknown>,
      inputSnapshot: redactSecrets(input.inputSnapshot) as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    };
    this.context.database.prepare(`
      INSERT INTO media_scene_runs (
        id, project_id, scene_id, media_job_id, provider_snapshot_json, execution_snapshot_json,
        input_snapshot_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.projectId,
      run.sceneId,
      run.mediaJobId,
      stringifyJson(run.providerSnapshot),
      stringifyJson(run.executionSnapshot),
      stringifyJson(run.inputSnapshot),
      run.createdAt,
      run.updatedAt,
    );
    const created = this.getMediaSceneRun(run.id);
    if (!created) {
      throw new Error(`Failed to create media scene run: ${run.id}`);
    }
    return created;
  }

  listMediaSceneRuns(options: { readonly projectId?: string; readonly sceneId?: string }): MediaSceneRun[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.projectId) {
      clauses.push("project_id = ?");
      params.push(options.projectId);
    }
    if (options.sceneId) {
      clauses.push("scene_id = ?");
      params.push(options.sceneId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database.prepare(`
      SELECT id, project_id, scene_id, media_job_id, provider_snapshot_json, execution_snapshot_json,
             input_snapshot_json, created_at, updated_at
      FROM media_scene_runs
      ${where}
      ORDER BY created_at DESC
    `).all(...params).map(mapMediaSceneRun);
  }

  getMediaSceneRun(id: string): MediaSceneRun | undefined {
    const row = this.context.database.prepare(`
      SELECT id, project_id, scene_id, media_job_id, provider_snapshot_json, execution_snapshot_json,
             input_snapshot_json, created_at, updated_at
      FROM media_scene_runs WHERE id = ?
    `).get(id);
    return row ? mapMediaSceneRun(row) : undefined;
  }

  getMediaSceneRunByMediaJobId(mediaJobId: string): MediaSceneRun | undefined {
    const row = this.context.database.prepare(`
      SELECT id, project_id, scene_id, media_job_id, provider_snapshot_json, execution_snapshot_json,
             input_snapshot_json, created_at, updated_at
      FROM media_scene_runs
      WHERE media_job_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(mediaJobId);
    return row ? mapMediaSceneRun(row) : undefined;
  }

  upsertMediaJobExecutionHandle(input: UpsertMediaJobExecutionHandleInput, now: string): MediaJobExecutionHandle {
    const existing = this.getMediaJobExecutionHandle(input.mediaJobId);
    this.context.database.prepare(`
      INSERT INTO media_job_execution_handles (
        media_job_id, adapter_kind, external_operation_id, recovery_json, next_poll_at,
        poll_attempts, work_unit_id, attempt_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_job_id) DO UPDATE SET
        adapter_kind = excluded.adapter_kind,
        external_operation_id = excluded.external_operation_id,
        recovery_json = excluded.recovery_json,
        next_poll_at = excluded.next_poll_at,
        poll_attempts = excluded.poll_attempts,
        work_unit_id = excluded.work_unit_id,
        attempt_id = excluded.attempt_id,
        updated_at = excluded.updated_at
    `).run(
      input.mediaJobId,
      input.adapterKind,
      input.externalOperationId,
      stringifyJson(redactSecrets(input.recovery)),
      input.nextPollAt === undefined ? existing?.nextPollAt ?? null : input.nextPollAt,
      input.pollAttempts ?? existing?.pollAttempts ?? 0,
      input.workUnitId === undefined ? existing?.workUnitId ?? null : input.workUnitId,
      input.attemptId === undefined ? existing?.attemptId ?? null : input.attemptId,
      existing?.createdAt ?? now,
      now,
    );
    const handle = this.getMediaJobExecutionHandle(input.mediaJobId);
    if (!handle) {
      throw new Error(`Failed to persist media execution handle: ${input.mediaJobId}`);
    }
    return handle;
  }

  getMediaJobExecutionHandle(mediaJobId: string): MediaJobExecutionHandle | undefined {
    const row = this.context.database.prepare(`
      SELECT media_job_id, adapter_kind, external_operation_id, recovery_json, next_poll_at,
             poll_attempts, work_unit_id, attempt_id, created_at, updated_at
      FROM media_job_execution_handles WHERE media_job_id = ?
    `).get(mediaJobId);
    return row ? mapMediaJobExecutionHandle(row) : undefined;
  }

  listMediaJobExecutionHandles(): MediaJobExecutionHandle[] {
    return this.context.database.prepare(`
      SELECT media_job_id, adapter_kind, external_operation_id, recovery_json, next_poll_at,
             poll_attempts, work_unit_id, attempt_id, created_at, updated_at
      FROM media_job_execution_handles ORDER BY updated_at ASC
    `).all().map(mapMediaJobExecutionHandle);
  }

  deleteMediaJobExecutionHandle(mediaJobId: string): boolean {
    return this.context.database.prepare("DELETE FROM media_job_execution_handles WHERE media_job_id = ?")
      .run(mediaJobId).changes > 0;
  }

  private nextMediaSceneSortOrder(projectId: string): number {
    const row = this.context.database.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS sort_order FROM media_scenes WHERE project_id = ?
    `).get(projectId) as Record<string, number | bigint | null>;
    const sortOrder = row.sort_order;
    return (typeof sortOrder === "bigint" ? Number(sortOrder) : sortOrder ?? -1) + 1;
  }

  private assertMediaSceneVideoImageInputs(scene: Pick<MediaScene, "projectId" | "videoImageInputs">): void {
    const assetIds = new Set<string>();
    let role: MediaScene["videoImageInputs"][number]["role"] | undefined;
    for (const input of scene.videoImageInputs) {
      if (!input.assetId || (input.role !== "first_frame" && input.role !== "reference_image")) {
        throw new Error("Media scene image input is invalid");
      }
      if (assetIds.has(input.assetId)) {
        throw new Error("Media scene image inputs must not contain duplicates");
      }
      assetIds.add(input.assetId);
      if (role && role !== input.role) {
        throw new Error("Media scene image inputs must use one role");
      }
      role = input.role;
      const asset = this.getMediaProjectAsset(input.assetId);
      if (!asset || asset.projectId !== scene.projectId) {
        throw new Error(`Media project asset not found in scene project: ${input.assetId}`);
      }
    }
  }
}

function mediaSceneSelectSql(whereClause: string): string {
  return `
    SELECT id, project_id, sort_order, title, prompt, provider_preset_id, ratio, duration_seconds,
           execution_mode, workflow_definition_id, workflow_input_values_json,
           reference_artifact_ids_json, video_image_inputs_json, canvas_position_json,
           selected_media_scene_run_id, created_at, updated_at
    FROM media_scenes
    ${whereClause}
  `;
}

function mediaProjectAssetSelectSql(whereClause: string): string {
  return `
    SELECT id, project_id, file_name, content_type, size_bytes, width, height, checksum,
           source_artifact_id, path, created_at
    FROM media_project_assets
    ${whereClause}
  `;
}

function normalizeMediaExecutionSource(input: CreateMediaJobInput): MediaJob["executionSource"] {
  if (input.executionSource) {
    return input.executionSource;
  }
  if (input.workflowVersionId) {
    return { kind: "workflow", workflowVersionId: input.workflowVersionId };
  }
  if (input.providerPresetId) {
    return { kind: "provider", providerPresetId: input.providerPresetId };
  }
  throw new Error("Media job requires a provider or workflow execution source");
}

function normalizeCanvasViewport(viewport: MediaCanvasViewport | undefined): MediaCanvasViewport {
  return {
    x: finiteNumber(viewport?.x, 0),
    y: finiteNumber(viewport?.y, 0),
    zoom: finiteNumber(viewport?.zoom, 1),
  };
}

function normalizeCanvasPosition(position: MediaCanvasPosition | undefined): MediaCanvasPosition {
  return {
    x: finiteNumber(position?.x, 0),
    y: finiteNumber(position?.y, 0),
  };
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function assertMediaSceneValues(scene: Pick<MediaScene, "title" | "sortOrder" | "ratio" | "durationSeconds">): void {
  if (!scene.title) {
    throw new Error("Media scene title is required");
  }
  if (!Number.isInteger(scene.sortOrder) || scene.sortOrder < 0) {
    throw new Error("Media scene sort order must be a non-negative integer");
  }
  if (!scene.ratio.trim()) {
    throw new Error("Media scene ratio is required");
  }
  if (!Number.isInteger(scene.durationSeconds) || scene.durationSeconds <= 0) {
    throw new Error("Media scene duration must be a positive integer");
  }
}

function assertMediaProjectAssetValues(asset: MediaProjectAsset): void {
  if (!asset.fileName || !asset.checksum || !asset.path) {
    throw new Error("Media project asset metadata is required");
  }
  if (!Number.isInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
    throw new Error("Media project asset size must be a positive integer");
  }
  if (!Number.isInteger(asset.width) || asset.width <= 0 || !Number.isInteger(asset.height) || asset.height <= 0) {
    throw new Error("Media project asset dimensions must be positive integers");
  }
}
