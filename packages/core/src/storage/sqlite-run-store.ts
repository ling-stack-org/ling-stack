import { existsSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  ensureRuntimePaths,
  getRunEventLogPath,
  resolveRuntimePaths,
  type LingStackRuntimePaths,
} from "../runtime-paths.js";
import {
  createApprovalRequestId,
  type ApprovalRequest,
  type ApprovalStatus,
  type CreateApprovalRequestInput,
  type ListApprovalRequestsOptions,
  type ResolveApprovalRequestInput,
} from "../approval-types.js";
import {
  createProviderPresetId,
  type ListProviderPresetsOptions,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
} from "../provider-types.js";
import {
  createDefaultApprovalPolicy,
  defaultApprovalToolDecisions,
  readOnlyRunTools,
  type ApprovalPolicy,
  type ApprovalPolicyUpdateInput,
  type ApprovalToolDecision,
  type ApprovalToolDecisions,
  type RunTool,
} from "../approval-policy.js";
import {
  DEFAULT_WORKSPACE_ID,
  createChannelId,
  createTaskId,
  type Channel,
  type ChannelUpdateInput,
  type CreateChannelInput,
  type CreateTaskInput,
  type ListChannelsOptions,
  type ListTasksOptions,
  type Task,
  type TaskStatus,
  type TaskUpdateInput,
} from "../workspace-types.js";
import {
  createArtifactId,
  createEventId,
  type ArtifactType,
  type CreateRunArtifactInput,
  type CreateRunInput,
  type ListRunEventsOptions,
  type ListRunsOptions,
  type RunArtifact,
  type RunEventEnvelope,
  type RunEventType,
  type RunSession,
  type RunStore,
  type RunStatus,
} from "../run-types.js";
import {
  createMediaJobId,
  type CreateMediaJobInput,
  type ListMediaJobsOptions,
  type MediaJob,
  type MediaJobStatus,
  type UpdateMediaJobStatusInput,
} from "../media-types.js";
import { redactSecrets } from "../redaction.js";
import { appendEventLogLine } from "./event-log.js";

const INITIAL_MIGRATION_VERSION = 1;
const INITIAL_MIGRATION_NAME = "create_run_sessions_and_events";
const PROVIDERS_MIGRATION_VERSION = 2;
const PROVIDERS_MIGRATION_NAME = "create_provider_presets";
const APPROVALS_MIGRATION_VERSION = 3;
const APPROVALS_MIGRATION_NAME = "create_approval_requests";
const WORKSPACE_MIGRATION_VERSION = 4;
const WORKSPACE_MIGRATION_NAME = "create_workspace_channels_tasks";
const APPROVAL_POLICY_MIGRATION_VERSION = 5;
const APPROVAL_POLICY_MIGRATION_NAME = "create_approval_policy";
const PROVIDER_CHECKS_MIGRATION_VERSION = 6;
const PROVIDER_CHECKS_MIGRATION_NAME = "add_provider_check_results";
const ARTIFACTS_MIGRATION_VERSION = 7;
const ARTIFACTS_MIGRATION_NAME = "create_artifacts";
const MEDIA_JOBS_MIGRATION_VERSION = 8;
const MEDIA_JOBS_MIGRATION_NAME = "create_media_jobs";
const STALE_RUN_ERROR = "Daemon stopped before the run reached a terminal state.";

export interface SqliteRunStoreOptions {
  readonly cwd: string;
  readonly paths?: LingStackRuntimePaths;
}

export class SqliteRunStore implements RunStore {
  readonly paths: LingStackRuntimePaths;
  private readonly database: DatabaseSync;

  constructor(options: SqliteRunStoreOptions) {
    this.paths = options.paths ?? resolveRuntimePaths(options.cwd);
    ensureRuntimePaths(this.paths);
    const existed = existsSync(this.paths.databasePath);
    this.database = new DatabaseSync(this.paths.databasePath);
    this.configureDatabase();
    this.applyMigrations();
    this.ensureDefaultWorkspace();
    this.ensureDefaultApprovalPolicy();

    if (!existed) {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    }
  }

  createRun(input: CreateRunInput): RunSession {
    const eventLogPath = getRunEventLogPath(this.paths, input.id);
    const redactedTaskSnapshot = redactSecrets(input.taskSnapshot);
    const redactedProviderSnapshot = redactSecrets(input.providerSnapshot);
    const redactedRequestSnapshot = redactSecrets(input.requestSnapshot);

    this.database
      .prepare(`
        INSERT INTO run_sessions (
          id,
          status,
          cwd,
          task_id,
          channel_id,
          teammate_id,
          provider_preset_id,
          provider_name,
          provider_model,
          task_snapshot_json,
          provider_snapshot_json,
          request_snapshot_json,
          event_log_path,
          summary_path,
          error_message,
          created_at,
          started_at,
          ended_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        "queued",
        input.cwd,
        input.taskId,
        input.channelId ?? null,
        input.teammateId ?? null,
        input.providerPresetId ?? null,
        input.providerName,
        input.providerModel,
        stringifyJson(redactedTaskSnapshot),
        stringifyJson(redactedProviderSnapshot),
        stringifyJson(redactedRequestSnapshot),
        eventLogPath,
        null,
        null,
        input.createdAt,
        null,
        null,
        input.createdAt,
      );

    const session = this.getRun(input.id);
    if (!session) {
      throw new Error(`Failed to create run session: ${input.id}`);
    }
    return session;
  }

  markRunStarted(runId: string, startedAt: string): void {
    this.updateRunStatus(runId, "running", startedAt, null, undefined, undefined, startedAt);
  }

  markRunWaitingForApproval(runId: string, updatedAt: string): void {
    this.updateRunStatus(runId, "waiting_for_approval", undefined, undefined, undefined, undefined, updatedAt);
  }

  markRunRunning(runId: string, updatedAt: string): void {
    this.updateRunStatus(runId, "running", undefined, undefined, undefined, undefined, updatedAt);
  }

  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "succeeded", undefined, endedAt, null, summaryPath, endedAt);
  }

  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "failed", undefined, endedAt, errorMessage, summaryPath, endedAt);
  }

  markRunCancelled(runId: string, endedAt: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "cancelled", undefined, endedAt, null, summaryPath, endedAt);
  }

  appendEvent(runId: string, type: RunEventType, data: unknown): RunEventEnvelope {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }

    const envelope: RunEventEnvelope = {
      id: createEventId(),
      runId,
      seq: this.nextEventSeq(runId),
      ts: new Date().toISOString(),
      type,
      data: redactSecrets(data),
    };

    this.database
      .prepare("INSERT INTO run_events (id, run_id, seq, ts, type, data_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(envelope.id, envelope.runId, envelope.seq, envelope.ts, envelope.type, stringifyJson(envelope.data));
    appendEventLogLine(run.eventLogPath, envelope);
    return envelope;
  }

  getRun(runId: string): RunSession | undefined {
    const row = this.database
      .prepare(
        `
          SELECT
            id,
            status,
            cwd,
            task_id,
            channel_id,
            teammate_id,
            provider_preset_id,
            provider_name,
            provider_model,
            task_snapshot_json,
            provider_snapshot_json,
            request_snapshot_json,
            event_log_path,
            summary_path,
            error_message,
            created_at,
            started_at,
            ended_at,
            updated_at
          FROM run_sessions
          WHERE id = ?
        `,
      )
      .get(runId);

    return row ? mapRunSession(row) : undefined;
  }

  listRuns(options: ListRunsOptions = {}): RunSession[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const statusClause = options.status ? "WHERE status = ?" : "";
    const statement = this.database.prepare(`
      SELECT
        id,
        status,
        cwd,
        task_id,
        channel_id,
        teammate_id,
        provider_preset_id,
        provider_name,
        provider_model,
        task_snapshot_json,
        provider_snapshot_json,
        request_snapshot_json,
        event_log_path,
        summary_path,
        error_message,
        created_at,
        started_at,
        ended_at,
        updated_at
      FROM run_sessions
      ${statusClause}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = options.status ? statement.all(options.status, limit) : statement.all(limit);
    return rows.map(mapRunSession);
  }

  listEvents(runId: string, options: ListRunEventsOptions = {}): RunEventEnvelope[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    return this.database
      .prepare(
        `
          SELECT id, run_id, seq, ts, type, data_json
          FROM run_events
          WHERE run_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?
        `,
      )
      .all(runId, afterSeq, limit)
      .map(mapRunEvent);
  }

  countEvents(runId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?").get(runId);
    return readNumber(row, "count");
  }

  createArtifact(input: CreateRunArtifactInput): RunArtifact {
    if (!this.getRun(input.runId)) {
      throw new Error(`Run session not found: ${input.runId}`);
    }

    const artifact: RunArtifact = {
      id: input.id ?? createArtifactId(),
      runId: input.runId,
      type: input.type,
      path: input.path,
      title: input.title,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      createdAt: input.createdAt,
    };

    this.database
      .prepare(`
        INSERT INTO artifacts (
          id,
          run_id,
          type,
          path,
          title,
          content_type,
          size_bytes,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        artifact.id,
        artifact.runId,
        artifact.type,
        artifact.path,
        artifact.title ?? null,
        artifact.contentType ?? null,
        artifact.sizeBytes ?? null,
        artifact.createdAt,
      );

    const created = this.getArtifact(artifact.id);
    if (!created) {
      throw new Error(`Failed to create artifact: ${artifact.id}`);
    }
    return created;
  }

  getArtifact(artifactId: string): RunArtifact | undefined {
    const row = this.database.prepare(artifactSelectSql("WHERE id = ?")).get(artifactId);
    return row ? mapArtifact(row) : undefined;
  }

  listArtifacts(runId: string): RunArtifact[] {
    return this.database
      .prepare(`${artifactSelectSql("WHERE run_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(runId)
      .map(mapArtifact);
  }

  recoverStaleRuns(now: string): number {
    const staleRuns = this.database
      .prepare("SELECT id FROM run_sessions WHERE status IN ('queued', 'running', 'waiting_for_approval')")
      .all()
      .map((row) => readString(row, "id"));

    for (const runId of staleRuns) {
      if (!this.hasTerminalEvent(runId)) {
        this.appendEvent(runId, "run_error", { message: STALE_RUN_ERROR });
      }
      this.markRunFailed(runId, now, STALE_RUN_ERROR);
    }

    return staleRuns.length;
  }

  createChannel(input: CreateChannelInput, now: string): Channel {
    const channel: Channel = {
      id: createChannelId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: input.name,
      boundPath: input.boundPath,
      defaultProviderPresetId: input.defaultProviderPresetId,
      defaultTeammateId: input.defaultTeammateId,
      allowedTools: input.allowedTools ?? [...readOnlyRunTools],
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channels (
          id,
          workspace_id,
          name,
          bound_path,
          default_provider_preset_id,
          default_teammate_id,
          allowed_tools_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        channel.id,
        channel.workspaceId,
        channel.name,
        channel.boundPath ?? null,
        channel.defaultProviderPresetId ?? null,
        channel.defaultTeammateId ?? null,
        stringifyJson(channel.allowedTools),
        channel.createdAt,
        channel.updatedAt,
      );

    const created = this.getChannel(channel.id);
    if (!created) {
      throw new Error(`Failed to create channel: ${channel.id}`);
    }
    return created;
  }

  getChannel(id: string): Channel | undefined {
    const row = this.database.prepare(channelSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannel(row) : undefined;
  }

  listChannels(options: ListChannelsOptions = {}): Channel[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.database
      .prepare(`${channelSelectSql("WHERE workspace_id = ?")} ORDER BY created_at DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, limit)
      .map(mapChannel);
  }

  updateChannel(id: string, input: ChannelUpdateInput, now: string): Channel | undefined {
    const existing = this.getChannel(id);
    if (!existing) {
      return undefined;
    }

    const next: Channel = {
      ...existing,
      name: input.name ?? existing.name,
      boundPath: nullableUpdate(input.boundPath, existing.boundPath),
      defaultProviderPresetId: nullableUpdate(input.defaultProviderPresetId, existing.defaultProviderPresetId),
      defaultTeammateId: nullableUpdate(input.defaultTeammateId, existing.defaultTeammateId),
      allowedTools: input.allowedTools ?? existing.allowedTools,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE channels
        SET
          name = ?,
          bound_path = ?,
          default_provider_preset_id = ?,
          default_teammate_id = ?,
          allowed_tools_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.name,
        next.boundPath ?? null,
        next.defaultProviderPresetId ?? null,
        next.defaultTeammateId ?? null,
        stringifyJson(next.allowedTools),
        next.updatedAt,
        id,
      );

    return this.getChannel(id);
  }

  deleteChannel(id: string): boolean {
    const result = this.database.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createTask(input: CreateTaskInput, now: string): Task {
    const task: Task = {
      id: createTaskId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      title: input.title,
      prompt: input.prompt,
      status: input.status ?? "todo",
      assigneeTeammateId: input.assigneeTeammateId,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO tasks (
          id,
          workspace_id,
          channel_id,
          title,
          prompt,
          status,
          assignee_teammate_id,
          current_run_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.workspaceId,
        task.channelId,
        task.title,
        task.prompt,
        task.status,
        task.assigneeTeammateId ?? null,
        task.currentRunId ?? null,
        task.createdAt,
        task.updatedAt,
      );

    const created = this.getTask(task.id);
    if (!created) {
      throw new Error(`Failed to create task: ${task.id}`);
    }
    return created;
  }

  getTask(id: string): Task | undefined {
    const row = this.database.prepare(taskSelectSql("WHERE id = ?")).get(id);
    return row ? mapTask(row) : undefined;
  }

  listTasks(options: ListTasksOptions = {}): Task[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
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
    return this.database
      .prepare(`${taskSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapTask);
  }

  updateTask(id: string, input: TaskUpdateInput, now: string): Task | undefined {
    const existing = this.getTask(id);
    if (!existing) {
      return undefined;
    }

    const next: Task = {
      ...existing,
      channelId: input.channelId ?? existing.channelId,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      status: input.status ?? existing.status,
      assigneeTeammateId: nullableUpdate(input.assigneeTeammateId, existing.assigneeTeammateId),
      currentRunId: nullableUpdate(input.currentRunId, existing.currentRunId),
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE tasks
        SET
          channel_id = ?,
          title = ?,
          prompt = ?,
          status = ?,
          assignee_teammate_id = ?,
          current_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.channelId,
        next.title,
        next.prompt,
        next.status,
        next.assigneeTeammateId ?? null,
        next.currentRunId ?? null,
        next.updatedAt,
        id,
      );

    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const result = this.database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createProviderPreset(input: ProviderPresetInput, now: string): ProviderPreset {
    const preset: ProviderPreset = {
      id: createProviderPresetId(),
      kind: input.kind,
      displayName: input.displayName,
      providerId: input.providerId,
      model: input.model,
      api: input.api,
      baseUrl: input.baseUrl,
      apiKeyRef: input.apiKeyRef,
      headers: input.headers ?? {},
      authHeader: input.authHeader,
      reasoning: input.reasoning,
      input: input.input ?? ["text"],
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      compat: input.compat ?? {},
      capabilities: input.capabilities,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO provider_presets (
          id,
          kind,
          display_name,
          provider_id,
          model,
          api,
          base_url,
          api_key_ref,
          headers_json,
          auth_header,
          reasoning,
          input_json,
          context_window,
          max_tokens,
          compat_json,
          capabilities_json,
          enabled,
          last_check_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        preset.id,
        preset.kind,
        preset.displayName,
        preset.providerId,
        preset.model,
        preset.api,
        preset.baseUrl ?? null,
        preset.apiKeyRef ?? null,
        stringifyJson(preset.headers),
        booleanToSql(preset.authHeader),
        booleanToSql(preset.reasoning),
        stringifyJson(preset.input),
        preset.contextWindow ?? null,
        preset.maxTokens ?? null,
        stringifyJson(preset.compat),
        stringifyJson(preset.capabilities),
        preset.enabled ? 1 : 0,
        preset.lastCheck ? stringifyJson(preset.lastCheck) : null,
        preset.createdAt,
        preset.updatedAt,
      );

    const created = this.getProviderPreset(preset.id);
    if (!created) {
      throw new Error(`Failed to create provider preset: ${preset.id}`);
    }
    return created;
  }

  getProviderPreset(id: string): ProviderPreset | undefined {
    const row = this.database.prepare(providerPresetSelectSql("WHERE id = ?")).get(id);
    return row ? mapProviderPreset(row) : undefined;
  }

  listProviderPresets(options: ListProviderPresetsOptions = {}): ProviderPreset[] {
    const whereClause = options.enabled === undefined ? "" : "WHERE enabled = ?";
    const statement = this.database.prepare(`${providerPresetSelectSql(whereClause)} ORDER BY created_at DESC`);
    const rows = options.enabled === undefined ? statement.all() : statement.all(options.enabled ? 1 : 0);
    return rows.map(mapProviderPreset);
  }

  updateProviderPreset(id: string, input: ProviderPresetUpdateInput, now: string): ProviderPreset | undefined {
    const existing = this.getProviderPreset(id);
    if (!existing) {
      return undefined;
    }

    const next: ProviderPreset = {
      ...existing,
      kind: input.kind ?? existing.kind,
      displayName: input.displayName ?? existing.displayName,
      providerId: input.providerId ?? existing.providerId,
      model: input.model ?? existing.model,
      api: input.api ?? existing.api,
      baseUrl: nullableUpdate(input.baseUrl, existing.baseUrl),
      apiKeyRef: nullableUpdate(input.apiKeyRef, existing.apiKeyRef),
      headers: input.headers ?? existing.headers,
      authHeader: nullableUpdate(input.authHeader, existing.authHeader),
      reasoning: nullableUpdate(input.reasoning, existing.reasoning),
      input: input.input ?? existing.input,
      contextWindow: nullableUpdate(input.contextWindow, existing.contextWindow),
      maxTokens: nullableUpdate(input.maxTokens, existing.maxTokens),
      compat: input.compat ?? existing.compat,
      capabilities: input.capabilities ?? existing.capabilities,
      enabled: input.enabled ?? existing.enabled,
      lastCheck: undefined,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE provider_presets
        SET
          kind = ?,
          display_name = ?,
          provider_id = ?,
          model = ?,
          api = ?,
          base_url = ?,
          api_key_ref = ?,
          headers_json = ?,
          auth_header = ?,
          reasoning = ?,
          input_json = ?,
          context_window = ?,
          max_tokens = ?,
          compat_json = ?,
          capabilities_json = ?,
          enabled = ?,
          last_check_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.kind,
        next.displayName,
        next.providerId,
        next.model,
        next.api,
        next.baseUrl ?? null,
        next.apiKeyRef ?? null,
        stringifyJson(next.headers),
        booleanToSql(next.authHeader),
        booleanToSql(next.reasoning),
        stringifyJson(next.input),
        next.contextWindow ?? null,
        next.maxTokens ?? null,
        stringifyJson(next.compat),
        stringifyJson(next.capabilities),
        next.enabled ? 1 : 0,
        next.lastCheck ? stringifyJson(next.lastCheck) : null,
        next.updatedAt,
        id,
      );

    return this.getProviderPreset(id);
  }

  recordProviderCheckResult(id: string, result: ProviderCheckResult): ProviderPreset | undefined {
    const updateResult = this.database
      .prepare("UPDATE provider_presets SET last_check_json = ? WHERE id = ?")
      .run(stringifyJson(result), id);
    if (Number(updateResult.changes) === 0) {
      return undefined;
    }
    return this.getProviderPreset(id);
  }

  deleteProviderPreset(id: string): boolean {
    const result = this.database.prepare("DELETE FROM provider_presets WHERE id = ?").run(id);
    return Number(result.changes) > 0;
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

    this.database
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
    const row = this.database.prepare(mediaJobSelectSql("WHERE id = ?")).get(id);
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
    return this.database
      .prepare(`${mediaJobSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapMediaJob);
  }

  updateMediaJobStatus(id: string, input: UpdateMediaJobStatusInput, now: string): MediaJob | undefined {
    const existing = this.getMediaJob(id);
    if (!existing) {
      return undefined;
    }

    this.database
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

  createApprovalRequest(input: CreateApprovalRequestInput, now: string): ApprovalRequest {
    const approval: ApprovalRequest = {
      id: createApprovalRequestId(),
      runId: input.runId,
      taskId: input.taskId,
      channelId: input.channelId,
      toolCallId: input.toolCallId,
      actionType: input.actionType,
      risk: input.risk,
      title: input.title,
      description: input.description,
      payload: redactSecrets(input.payload) as ApprovalRequest["payload"],
      status: "pending",
      createdAt: now,
      expiresAt: input.expiresAt,
    };

    this.database
      .prepare(`
        INSERT INTO approval_requests (
          id,
          run_id,
          task_id,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        approval.id,
        approval.runId,
        approval.taskId,
        approval.channelId ?? null,
        approval.toolCallId ?? null,
        approval.actionType,
        approval.risk,
        approval.title,
        approval.description,
        stringifyJson(approval.payload),
        approval.status,
        approval.createdAt,
        approval.expiresAt ?? null,
        null,
        null,
        null,
      );

    const created = this.getApprovalRequest(approval.id);
    if (!created) {
      throw new Error(`Failed to create approval request: ${approval.id}`);
    }
    return created;
  }

  getApprovalRequest(id: string): ApprovalRequest | undefined {
    const row = this.database.prepare(approvalRequestSelectSql("WHERE id = ?")).get(id);
    return row ? mapApprovalRequest(row) : undefined;
  }

  listApprovalRequests(options: ListApprovalRequestsOptions = {}): ApprovalRequest[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${approvalRequestSelectSql(whereClause)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapApprovalRequest);
  }

  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "approved", input, now);
  }

  denyApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "denied", input, now);
  }

  expireApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "expired", input, now);
  }

  getApprovalPolicy(): ApprovalPolicy {
    const row = this.database.prepare(approvalPolicySelectSql("WHERE workspace_id = ?")).get(DEFAULT_WORKSPACE_ID);
    if (row) {
      return mapApprovalPolicy(row);
    }
    this.ensureDefaultApprovalPolicy();
    const created = this.database.prepare(approvalPolicySelectSql("WHERE workspace_id = ?")).get(DEFAULT_WORKSPACE_ID);
    if (!created) {
      throw new Error(`Approval policy not found: ${DEFAULT_WORKSPACE_ID}`);
    }
    return mapApprovalPolicy(created);
  }

  updateApprovalPolicy(input: ApprovalPolicyUpdateInput, now: string): ApprovalPolicy {
    const existing = this.getApprovalPolicy();
    const next: ApprovalPolicy = {
      ...existing,
      toolDecisions: {
        ...existing.toolDecisions,
        ...(input.toolDecisions ?? {}),
      },
      allowedWritePaths: input.allowedWritePaths ?? existing.allowedWritePaths,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE approval_policies
        SET
          tool_decisions_json = ?,
          allowed_write_paths_json = ?,
          updated_at = ?
        WHERE workspace_id = ?
      `)
      .run(
        stringifyJson(next.toolDecisions),
        stringifyJson(next.allowedWritePaths),
        next.updatedAt,
        next.workspaceId,
      );

    return this.getApprovalPolicy();
  }

  close(): void {
    if (this.database.isOpen) {
      this.database.close();
    }
  }

  private configureDatabase(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private resolveApprovalRequest(
    id: string,
    status: Extract<ApprovalStatus, "approved" | "denied" | "expired">,
    input: ResolveApprovalRequestInput,
    now: string,
  ): ApprovalRequest | undefined {
    const existing = this.getApprovalRequest(id);
    if (!existing) {
      return undefined;
    }
    if (existing.status !== "pending") {
      throw new Error(`Approval request is not pending: ${id}`);
    }

    this.database
      .prepare(`
        UPDATE approval_requests
        SET
          status = ?,
          resolved_at = ?,
          resolved_by = ?,
          decision_reason = ?
        WHERE id = ?
      `)
      .run(status, now, status === "expired" ? (input.resolvedBy ?? null) : (input.resolvedBy ?? "local-user"), input.reason ?? null, id);

    return this.getApprovalRequest(id);
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    if (!this.hasMigration(INITIAL_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS run_sessions (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          cwd TEXT NOT NULL,
          task_id TEXT NOT NULL,
          channel_id TEXT,
          teammate_id TEXT,
          provider_preset_id TEXT,
          provider_name TEXT NOT NULL,
          provider_model TEXT NOT NULL,
          task_snapshot_json TEXT NOT NULL,
          provider_snapshot_json TEXT NOT NULL,
          request_snapshot_json TEXT NOT NULL,
          event_log_path TEXT NOT NULL,
          summary_path TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          data_json TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          UNIQUE(run_id, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_run_sessions_status ON run_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_run_sessions_task ON run_sessions(task_id);
        CREATE INDEX IF NOT EXISTS idx_run_sessions_created_at ON run_sessions(created_at);
        CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(type);
      `);

      this.recordMigration(INITIAL_MIGRATION_VERSION, INITIAL_MIGRATION_NAME);
    }

    if (!this.hasMigration(PROVIDERS_MIGRATION_VERSION)) {
      if (!this.hasColumn("run_sessions", "provider_preset_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN provider_preset_id TEXT;");
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS provider_presets (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          api TEXT NOT NULL,
          base_url TEXT,
          api_key_ref TEXT,
          headers_json TEXT NOT NULL,
          auth_header INTEGER,
          reasoning INTEGER,
          input_json TEXT NOT NULL,
          context_window INTEGER,
          max_tokens INTEGER,
          compat_json TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_provider_presets_kind ON provider_presets(kind);
        CREATE INDEX IF NOT EXISTS idx_provider_presets_enabled ON provider_presets(enabled);
      `);

      this.recordMigration(PROVIDERS_MIGRATION_VERSION, PROVIDERS_MIGRATION_NAME);
    }

    if (!this.hasMigration(APPROVALS_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
      `);

      this.recordMigration(APPROVALS_MIGRATION_VERSION, APPROVALS_MIGRATION_NAME);
    }

    if (!this.hasMigration(WORKSPACE_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          default_provider_preset_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          bound_path TEXT,
          default_provider_preset_id TEXT,
          default_teammate_id TEXT,
          allowed_tools_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          assignee_teammate_id TEXT,
          current_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id)
        );

        CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_channel_status ON tasks(channel_id, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_current_run ON tasks(current_run_id);
      `);

      this.recordMigration(WORKSPACE_MIGRATION_VERSION, WORKSPACE_MIGRATION_NAME);
    }

    if (!this.hasMigration(APPROVAL_POLICY_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS approval_policies (
          workspace_id TEXT PRIMARY KEY,
          tool_decisions_json TEXT NOT NULL,
          allowed_write_paths_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
      `);

      this.recordMigration(APPROVAL_POLICY_MIGRATION_VERSION, APPROVAL_POLICY_MIGRATION_NAME);
    }

    if (!this.hasMigration(PROVIDER_CHECKS_MIGRATION_VERSION)) {
      if (!this.hasColumn("provider_presets", "last_check_json")) {
        this.database.exec("ALTER TABLE provider_presets ADD COLUMN last_check_json TEXT;");
      }

      this.recordMigration(PROVIDER_CHECKS_MIGRATION_VERSION, PROVIDER_CHECKS_MIGRATION_NAME);
    }

    if (!this.hasMigration(ARTIFACTS_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          type TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT,
          content_type TEXT,
          size_bytes INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
      `);

      this.recordMigration(ARTIFACTS_MIGRATION_VERSION, ARTIFACTS_MIGRATION_NAME);
    }

    if (!this.hasMigration(MEDIA_JOBS_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS media_jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider_preset_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          prompt TEXT NOT NULL,
          input_json TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_jobs_workspace ON media_jobs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_provider ON media_jobs(provider_preset_id);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_created_at ON media_jobs(created_at);
      `);

      this.recordMigration(MEDIA_JOBS_MIGRATION_VERSION, MEDIA_JOBS_MIGRATION_NAME);
    }
  }

  private ensureDefaultWorkspace(): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workspaces (id, name, default_provider_preset_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `)
      .run(DEFAULT_WORKSPACE_ID, "Default Workspace", null, now, now);
  }

  private ensureDefaultApprovalPolicy(): void {
    const now = new Date().toISOString();
    const policy = createDefaultApprovalPolicy(DEFAULT_WORKSPACE_ID, now);
    this.database
      .prepare(`
        INSERT INTO approval_policies (
          workspace_id,
          tool_decisions_json,
          allowed_write_paths_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO NOTHING
      `)
      .run(
        policy.workspaceId,
        stringifyJson(policy.toolDecisions),
        stringifyJson(policy.allowedWritePaths),
        policy.createdAt,
        policy.updatedAt,
      );
  }

  private hasMigration(version: number): boolean {
    return Boolean(this.database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version));
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    return this.database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .some((row) => readString(row, "name") === columnName);
  }

  private recordMigration(version: number, name: string): void {
    this.database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, new Date().toISOString());
  }

  private nextEventSeq(runId: string): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?").get(runId);
    return readNumber(row, "next_seq");
  }

  private hasTerminalEvent(runId: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS found FROM run_events WHERE run_id = ? AND type IN ('run_end', 'run_error', 'run_cancelled', 'result') LIMIT 1")
      .get(runId);
    return Boolean(row);
  }

  private updateRunStatus(
    runId: string,
    status: RunStatus,
    startedAt: string | undefined,
    endedAt: string | null | undefined,
    errorMessage: string | null | undefined,
    summaryPath: string | undefined,
    updatedAt: string,
  ): void {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Run session not found: ${runId}`);
    }

    this.database
      .prepare(
        `
          UPDATE run_sessions
          SET
            status = ?,
            started_at = ?,
            ended_at = ?,
            error_message = ?,
            summary_path = ?,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        status,
        startedAt ?? existing.startedAt ?? null,
        endedAt === undefined ? existing.endedAt ?? null : endedAt,
        errorMessage === undefined ? existing.errorMessage ?? null : errorMessage,
        summaryPath ?? existing.summaryPath ?? null,
        updatedAt,
        runId,
      );
  }
}

export function createSqliteRunStore(cwd: string): SqliteRunStore {
  return new SqliteRunStore({ cwd });
}

function mapRunSession(row: Record<string, SQLOutputValue>): RunSession {
  return omitUndefined({
    id: readString(row, "id"),
    status: readString(row, "status") as RunStatus,
    cwd: readString(row, "cwd"),
    taskId: readString(row, "task_id"),
    channelId: readNullableString(row, "channel_id"),
    teammateId: readNullableString(row, "teammate_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    providerName: readString(row, "provider_name"),
    providerModel: readString(row, "provider_model"),
    taskSnapshot: parseJson(readString(row, "task_snapshot_json")),
    providerSnapshot: parseJson(readString(row, "provider_snapshot_json")),
    requestSnapshot: parseJson(readString(row, "request_snapshot_json")),
    eventLogPath: readString(row, "event_log_path"),
    summaryPath: readNullableString(row, "summary_path"),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapRunEvent(row: Record<string, SQLOutputValue>): RunEventEnvelope {
  return {
    id: readString(row, "id"),
    runId: readString(row, "run_id"),
    seq: readNumber(row, "seq"),
    ts: readString(row, "ts"),
    type: readString(row, "type") as RunEventType,
    data: parseJson(readString(row, "data_json")),
  };
}

function mapChannel(row: Record<string, SQLOutputValue>): Channel {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    name: readString(row, "name"),
    boundPath: readNullableString(row, "bound_path"),
    defaultProviderPresetId: readNullableString(row, "default_provider_preset_id"),
    defaultTeammateId: readNullableString(row, "default_teammate_id"),
    allowedTools: parseJsonStringArray(readString(row, "allowed_tools_json")) as RunTool[],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapTask(row: Record<string, SQLOutputValue>): Task {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    status: readString(row, "status") as TaskStatus,
    assigneeTeammateId: readNullableString(row, "assignee_teammate_id"),
    currentRunId: readNullableString(row, "current_run_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapProviderPreset(row: Record<string, SQLOutputValue>): ProviderPreset {
  return omitUndefined({
    id: readString(row, "id"),
    kind: readString(row, "kind") as ProviderPreset["kind"],
    displayName: readString(row, "display_name"),
    providerId: readString(row, "provider_id"),
    model: readString(row, "model"),
    api: readString(row, "api") as ProviderPreset["api"],
    baseUrl: readNullableString(row, "base_url"),
    apiKeyRef: readNullableString(row, "api_key_ref"),
    headers: parseJsonStringRecord(readString(row, "headers_json")),
    authHeader: readNullableBoolean(row, "auth_header"),
    reasoning: readNullableBoolean(row, "reasoning"),
    input: parseJsonStringArray(readString(row, "input_json")) as ProviderPreset["input"],
    contextWindow: readNullableNumber(row, "context_window"),
    maxTokens: readNullableNumber(row, "max_tokens"),
    compat: parseJsonObject(readString(row, "compat_json")),
    capabilities: parseJsonStringArray(readString(row, "capabilities_json")) as ProviderPreset["capabilities"],
    enabled: readBoolean(row, "enabled"),
    lastCheck: parseProviderCheckResult(readNullableString(row, "last_check_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapApprovalRequest(row: Record<string, SQLOutputValue>): ApprovalRequest {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readString(row, "run_id"),
    taskId: readString(row, "task_id"),
    channelId: readNullableString(row, "channel_id"),
    toolCallId: readNullableString(row, "tool_call_id"),
    actionType: readString(row, "action_type") as ApprovalRequest["actionType"],
    risk: readString(row, "risk") as ApprovalRequest["risk"],
    title: readString(row, "title"),
    description: readString(row, "description"),
    payload: parseJsonObject(readString(row, "payload_json")) as ApprovalRequest["payload"],
    status: readString(row, "status") as ApprovalStatus,
    createdAt: readString(row, "created_at"),
    expiresAt: readNullableString(row, "expires_at"),
    resolvedAt: readNullableString(row, "resolved_at"),
    resolvedBy: readNullableString(row, "resolved_by") as ApprovalRequest["resolvedBy"],
    decisionReason: readNullableString(row, "decision_reason"),
  });
}

function mapApprovalPolicy(row: Record<string, SQLOutputValue>): ApprovalPolicy {
  return {
    workspaceId: readString(row, "workspace_id"),
    toolDecisions: parseApprovalToolDecisions(readString(row, "tool_decisions_json")),
    allowedWritePaths: parseJsonStringArray(readString(row, "allowed_write_paths_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapArtifact(row: Record<string, SQLOutputValue>): RunArtifact {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readString(row, "run_id"),
    type: readString(row, "type") as ArtifactType,
    path: readString(row, "path"),
    title: readNullableString(row, "title"),
    contentType: readNullableString(row, "content_type"),
    sizeBytes: readNullableNumber(row, "size_bytes"),
    createdAt: readString(row, "created_at"),
  });
}

function mapMediaJob(row: Record<string, SQLOutputValue>): MediaJob {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    providerPresetId: readString(row, "provider_preset_id"),
    operation: readString(row, "operation") as MediaJob["operation"],
    prompt: readString(row, "prompt"),
    input: parseJsonObject(readString(row, "input_json")),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    status: readString(row, "status") as MediaJobStatus,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseApprovalToolDecisions(value: string): ApprovalToolDecisions {
  const parsed = parseJsonObject(value);
  const decisions: Record<RunTool, ApprovalToolDecision> = { ...defaultApprovalToolDecisions };
  for (const tool of Object.keys(defaultApprovalToolDecisions) as RunTool[]) {
    const decision = parsed[tool];
    if (decision === "allow" || decision === "ask" || decision === "deny") {
      decisions[tool] = decision;
    }
  }
  return decisions;
}

function channelSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      name,
      bound_path,
      default_provider_preset_id,
      default_teammate_id,
      allowed_tools_json,
      created_at,
      updated_at
    FROM channels
    ${whereClause}
  `;
}

function taskSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      title,
      prompt,
      status,
      assignee_teammate_id,
      current_run_id,
      created_at,
      updated_at
    FROM tasks
    ${whereClause}
  `;
}

function providerPresetSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      kind,
      display_name,
      provider_id,
      model,
      api,
      base_url,
      api_key_ref,
      headers_json,
      auth_header,
      reasoning,
      input_json,
      context_window,
      max_tokens,
      compat_json,
      capabilities_json,
      enabled,
      last_check_json,
      created_at,
      updated_at
    FROM provider_presets
    ${whereClause}
  `;
}

function approvalRequestSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      task_id,
      channel_id,
      tool_call_id,
      action_type,
      risk,
      title,
      description,
      payload_json,
      status,
      created_at,
      expires_at,
      resolved_at,
      resolved_by,
      decision_reason
    FROM approval_requests
    ${whereClause}
  `;
}

function approvalPolicySelectSql(whereClause: string): string {
  return `
    SELECT
      workspace_id,
      tool_decisions_json,
      allowed_write_paths_json,
      created_at,
      updated_at
    FROM approval_policies
    ${whereClause}
  `;
}

function artifactSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      type,
      path,
      title,
      content_type,
      size_bytes,
      created_at
    FROM artifacts
    ${whereClause}
  `;
}

function mediaJobSelectSql(whereClause: string): string {
  return `
    SELECT
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
    FROM media_jobs
    ${whereClause}
  `;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object from SQLite");
  }
  return parsed as Record<string, unknown>;
}

function parseJsonStringRecord(value: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(parsed)) {
    if (typeof entryValue !== "string") {
      throw new Error("Expected JSON string record from SQLite");
    }
    result[key] = entryValue;
  }
  return result;
}

function parseJsonStringArray(value: string): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Expected JSON string array from SQLite");
  }
  return parsed as string[];
}

function parseProviderCheckResult(value: string | undefined): ProviderCheckResult | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = parseJsonObject(value);
  if (typeof parsed.ok !== "boolean" || typeof parsed.message !== "string" || typeof parsed.checkedAt !== "string") {
    throw new Error("Expected provider check result from SQLite");
  }
  if (parsed.code !== undefined && typeof parsed.code !== "string") {
    throw new Error("Expected provider check code to be a string");
  }

  const code = typeof parsed.code === "string" ? parsed.code : undefined;
  return omitUndefined({
    ok: parsed.ok,
    code,
    message: parsed.message,
    checkedAt: parsed.checkedAt,
  }) as ProviderCheckResult;
}

function readString(row: Record<string, SQLOutputValue> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string`);
  }
  return value;
}

function readBoolean(row: Record<string, SQLOutputValue>, key: string): boolean {
  const value = row[key];
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "bigint") {
    return value === 1n;
  }
  throw new Error(`Expected SQLite column ${key} to be a boolean integer`);
}

function readNullableBoolean(row: Record<string, SQLOutputValue>, key: string): boolean | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "bigint") {
    return value === 1n;
  }
  throw new Error(`Expected SQLite column ${key} to be a boolean integer or null`);
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string or null`);
  }
  return value;
}

function readNullableNumber(row: Record<string, SQLOutputValue>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`Expected SQLite column ${key} to be a number or null`);
}

function readNumber(row: Record<string, SQLOutputValue> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`Expected SQLite column ${key} to be a number`);
}

function booleanToSql(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

function nullableUpdate<T>(value: T | null | undefined, existing: T | undefined): T | undefined {
  if (value === undefined) {
    return existing;
  }
  if (value === null) {
    return undefined;
  }
  return value;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}
